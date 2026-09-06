// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderer, RendererFactory } from "../renderer/renderer-interface";

const wasm = vi.hoisted(() => ({
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

    setScrollbackLines(): void {}
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
  encodeKey: vi.fn(),
  engineMemory: () => wasm.memory,
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

function createRenderer(render: Renderer["render"] = vi.fn()) {
  return {
    setPalette: vi.fn(),
    setAtlas: vi.fn(),
    render,
    dispose: vi.fn(),
  } satisfies Renderer;
}

describe("Terminal lifecycle", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    document.body.replaceChildren();
    frames = new Map();
    nextFrame = 1;
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
            drawImage: vi.fn(),
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
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disposes a renderer that resolves after initialization was cancelled", async () => {
    let resolveRenderer!: (renderer: Renderer) => void;
    const renderer = createRenderer();
    const factory: RendererFactory = () =>
      new Promise((resolve) => {
        resolveRenderer = resolve;
      });
    const host = document.createElement("div");
    const terminal = new Terminal(host, OPTIONS, factory);

    await Promise.resolve();
    terminal.dispose();
    terminal.dispose();
    resolveRenderer(renderer);

    await expect(terminal.ready).rejects.toThrow("after dispose");
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(host.querySelector("canvas")).toBeNull();
  });

  it("cleans the host when renderer initialization fails", async () => {
    const host = document.createElement("div");
    const failure = new Error("No WebGPU adapter");
    const terminal = new Terminal(host, OPTIONS, () => Promise.reject(failure));

    await expect(terminal.ready).rejects.toBe(failure);

    expect(host.querySelector("canvas")).toBeNull();
    expect(host.hasAttribute("tabindex")).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it("does not schedule another frame after an error listener disposes it", async () => {
    const renderer = createRenderer(
      vi.fn(() => {
        throw new Error("render failed");
      }),
    );
    const terminal = new Terminal(document.createElement("div"), OPTIONS, () =>
      Promise.resolve(renderer),
    );
    await terminal.ready;
    terminal.on("error", () => terminal.dispose());

    const [id, frame] = [...frames.entries()][0];
    frames.delete(id);
    frame(0);

    expect(frames).toHaveLength(0);
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
});
