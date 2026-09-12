// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderer } from "../renderer/renderer-interface";
import type { TerminalTransport } from "../transport/types";

const mocks = vi.hoisted(() => ({
  engines: [] as Array<{ feed: ReturnType<typeof vi.fn> }>,
  memory: new ArrayBuffer(80 * 24 * 4 * Uint32Array.BYTES_PER_ELEMENT),
}));

vi.mock("./wasm", () => ({
  EngineTerminal: class {
    readonly columns = 80;
    readonly screenLines = 24;
    readonly displayOffset = 0;
    readonly applicationCursor = false;
    readonly mouseReporting = 0;
    readonly sgrMouse = false;
    readonly alternateScroll = false;
    readonly altScreen = false;
    readonly feed = vi.fn();
    takeOutput(): Uint8Array {
      return new Uint8Array();
    }
    constructor() {
      mocks.engines.push(this);
    }
    setScrollbackLines(): void {}
    flushSync(): boolean {
      return false;
    }
    refreshSnapshot(): void {}
    snapshotPtr(): number {
      return 0;
    }
    snapshotLen(): number {
      return 80 * 24 * 4;
    }
    resize(): void {}
    resetScroll(): void {}
    free(): void {}
  },
  encodeKey: (key: string) => new TextEncoder().encode(key),
  encodeMouse: vi.fn(),
  engineMemory: () => mocks.memory,
  loadEngine: () => Promise.resolve(),
}));

import { Terminal } from "./terminal";

const OPTIONS = {
  font: { family: "monospace", size: 13 },
  colors: {
    black: "#000000",
    red: "#000000",
    green: "#000000",
    yellow: "#000000",
    blue: "#000000",
    magenta: "#000000",
    cyan: "#000000",
    white: "#000000",
    brightBlack: "#000000",
    brightRed: "#000000",
    brightGreen: "#000000",
    brightYellow: "#000000",
    brightBlue: "#000000",
    brightMagenta: "#000000",
    brightCyan: "#000000",
    brightWhite: "#000000",
    foreground: "#ffffff",
    background: "#000000",
    cursor: "#ffffff",
  },
  cursor: { style: "block" as const, blink: false },
  scrollback: 1_000,
};

function renderer(): Renderer {
  return {
    setPalette: vi.fn(),
    setAtlas: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

async function mount() {
  const host = document.createElement("div");
  const terminal = new Terminal(host, OPTIONS, () => Promise.resolve(renderer()));
  await terminal.ready;
  return { host, terminal };
}

describe("Terminal transport lifecycle", () => {
  beforeEach(() => {
    mocks.engines.length = 0;
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return {
            beginPath: vi.fn(),
            clip: vi.fn(),
            fillText: vi.fn(),
            measureText: () => ({ width: 8 }),
            rect: vi.fn(),
            restore: vi.fn(),
            save: vi.fn(),
          };
        }
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fully unwinds a transport that reports close while subscribing", async () => {
    const { host, terminal } = await mount();
    const dataOff = vi.fn();
    const closeOff = vi.fn();
    const transport: TerminalTransport = {
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(() => dataOff),
      onClose: vi.fn((listener) => {
        listener("closed during attach");
        return closeOff;
      }),
    };
    const errors: string[] = [];
    terminal.on("error", (error) => errors.push(error.message));

    terminal.attach(transport);
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "x", cancelable: true }));

    expect(terminal.transport).toBeUndefined();
    expect(dataOff).toHaveBeenCalledOnce();
    expect(closeOff).toHaveBeenCalledOnce();
    expect(transport.resize).not.toHaveBeenCalled();
    expect(transport.write).not.toHaveBeenCalled();
    expect(errors).toEqual(["closed during attach"]);
    terminal.dispose();
  });

  it("makes detach reentrant when an unsubscribe callback detaches again", async () => {
    const { terminal } = await mount();
    const recursiveOff = vi.fn(() => terminal.detach());
    const transport: TerminalTransport = {
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(() => recursiveOff),
      onClose: vi.fn(() => vi.fn()),
    };
    terminal.attach(transport);

    expect(() => terminal.detach()).not.toThrow();
    expect(recursiveOff).toHaveBeenCalledOnce();
    expect(terminal.transport).toBeUndefined();
    terminal.dispose();
  });

  it("keeps a nested attachment made while replacing the old transport", async () => {
    const { host, terminal } = await mount();
    const makeTransport = (): TerminalTransport => ({
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onClose: vi.fn(() => vi.fn()),
    });
    const first = makeTransport();
    const outer = makeTransport();
    const nested = makeTransport();
    const nestedDataOff = vi.fn();
    nested.onData = vi.fn(() => nestedDataOff);
    const firstOff = vi.fn(() => terminal.attach(nested));
    first.onData = vi.fn(() => firstOff);
    terminal.attach(first);
    terminal.attach(outer);
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "a", cancelable: true }));
    expect(terminal.transport).toBe(nested);
    expect(firstOff).toHaveBeenCalledOnce();
    expect(nested.write).toHaveBeenCalledOnce();
    expect(outer.onData).not.toHaveBeenCalled();
    expect(outer.write).not.toHaveBeenCalled();
    expect(first.write).not.toHaveBeenCalled();
    terminal.detach();
    expect(nestedDataOff).toHaveBeenCalledOnce();
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "b", cancelable: true }));
    expect(nested.write).toHaveBeenCalledOnce();
    terminal.dispose();
  });

  it("leaves no attachment when an unsubscribe detaches during replacement", async () => {
    const { host, terminal } = await mount();
    const firstOff = vi.fn(() => terminal.detach());
    const closeOff = vi.fn();
    const first: TerminalTransport = {
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(() => firstOff),
      onClose: vi.fn(() => closeOff),
    };
    const outer: TerminalTransport = {
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onClose: vi.fn(() => vi.fn()),
    };
    terminal.attach(first);
    terminal.attach(outer);
    expect(terminal.transport).toBeUndefined();
    expect(firstOff).toHaveBeenCalledOnce();
    expect(closeOff).toHaveBeenCalledOnce();
    expect(outer.onData).not.toHaveBeenCalled();
    expect(outer.onClose).not.toHaveBeenCalled();
    expect(outer.resize).not.toHaveBeenCalled();
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "a", cancelable: true }));
    expect(first.write).not.toHaveBeenCalled();
    expect(outer.write).not.toHaveBeenCalled();
    terminal.dispose();
    expect(firstOff).toHaveBeenCalledOnce();
    expect(closeOff).toHaveBeenCalledOnce();
  });

  it("preserves one engine while replaying output across transport replacement", async () => {
    const { terminal } = await mount();
    const firstOff = vi.fn();
    const first: TerminalTransport = {
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn((listener) => {
        listener(new TextEncoder().encode("before reconnect"));
        return firstOff;
      }),
      onClose: vi.fn(() => vi.fn()),
    };
    const second: TerminalTransport = {
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn((listener) => {
        listener(new TextEncoder().encode("after reconnect"));
        return vi.fn();
      }),
      onClose: vi.fn(() => vi.fn()),
    };

    terminal.attach(first);
    terminal.setOptions({ scrollback: 2_000 });
    terminal.attach(second);

    expect(mocks.engines).toHaveLength(1);
    expect(
      mocks.engines[0].feed.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes)),
    ).toEqual(["before reconnect", "after reconnect"]);
    expect(firstOff).toHaveBeenCalledOnce();
    expect(terminal.transport).toBe(second);
    terminal.dispose();
  });
});
