// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderer } from "../renderer/renderer-interface";

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

describe("Terminal renderer failures", () => {
  beforeEach(() => {
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

  it("surfaces asynchronous renderer failure and releases the unusable terminal", async () => {
    let fail: ((error: Error) => void) | undefined;
    const renderer = {
      setPalette: vi.fn(),
      setAtlas: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
      onError(listener: (error: Error) => void) {
        fail = listener;
        return () => {
          fail = undefined;
        };
      },
    } satisfies Renderer & { onError(listener: (error: Error) => void): () => void };
    const host = document.createElement("div");
    const terminal = new Terminal(host, OPTIONS, () => Promise.resolve(renderer));
    const errors: Error[] = [];
    terminal.on("error", (error) => errors.push(error));
    await terminal.ready;

    fail?.(new Error("WebGPU device lost: GPU reset"));

    expect(errors.map(({ message }) => message)).toEqual(["WebGPU device lost: GPU reset"]);
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(host.querySelector("canvas")).toBeNull();
  });
});
