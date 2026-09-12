// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderer } from "../renderer/renderer-interface";

const mocks = vi.hoisted(() => ({
  engines: [] as Array<{
    resize: ReturnType<typeof vi.fn>;
    selectedText: ReturnType<typeof vi.fn>;
  }>,
  observers: [] as Array<{
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
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
    readonly resize = vi.fn();
    readonly selectedText = vi.fn(() => "selection");
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
    resetScroll(): void {}
    rowText(): string {
      return "";
    }
    free(): void {}
  },
  encodeKey: vi.fn(),
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

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function renderer(): Renderer {
  return {
    setPalette: vi.fn(),
    setAtlas: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("embedded terminal surface", () => {
  beforeEach(() => {
    mocks.engines.length = 0;
    mocks.observers.length = 0;
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
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
        readonly callback: ResizeObserverCallback;
        readonly disconnect = vi.fn();
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
          mocks.observers.push(this);
        }
        readonly observe = vi.fn();
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

  it("measures and points from the canvas content box inside a padded host", async () => {
    const host = document.createElement("div");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(100, 50, 600, 300));
    const terminal = new Terminal(host, OPTIONS, () => Promise.resolve(renderer()));
    const canvas = host.querySelector("canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(120, 70, 554, 254));

    await terminal.ready;

    expect(mocks.observers[0].observe).toHaveBeenCalledWith(canvas, { box: "content-box" });
    expect(mocks.engines[0].resize).toHaveBeenLastCalledWith(138, 15);
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 1108, height: 508 });

    host.dispatchEvent(
      new MouseEvent("mousedown", {
        button: 0,
        clientX: 136,
        clientY: 86,
        bubbles: true,
      }),
    );
    expect(terminal.getSelection()).toBe("selection");
    expect(mocks.engines[0].selectedText).toHaveBeenLastCalledWith(1, 4, 1, 4);
    terminal.dispose();
  });

  it("remeasures an independently resized canvas while the host stays unchanged", async () => {
    const host = document.createElement("div");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(0, 0, 600, 300));
    const terminal = new Terminal(host, OPTIONS, () => Promise.resolve(renderer()));
    const canvas = host.querySelector("canvas")!;
    const bounds = vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(0, 0, 400, 200));
    await terminal.ready;
    expect(mocks.observers[0].observe).toHaveBeenCalledWith(canvas, { box: "content-box" });
    const firstSize = [...mocks.engines[0].resize.mock.lastCall!];
    bounds.mockReturnValue(rect(0, 0, 200, 100));
    const observer = mocks.observers[0];
    observer.callback([], observer as unknown as ResizeObserver);
    expect(mocks.engines[0].resize.mock.lastCall).not.toEqual(firstSize);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
    terminal.dispose();
  });

  it("keeps the last grid while hidden and remeasures when visible again", async () => {
    const host = document.createElement("div");
    let hostRect = rect(100, 50, 0, 0);
    let canvasRect = rect(120, 70, 0, 0);
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => hostRect);
    const terminal = new Terminal(host, OPTIONS, () => Promise.resolve(renderer()));
    const canvas = host.querySelector("canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockImplementation(() => canvasRect);
    await terminal.ready;
    const observer = mocks.observers[0];

    expect(mocks.engines[0].resize).not.toHaveBeenCalled();
    hostRect = rect(100, 50, 600, 300);
    canvasRect = rect(120, 70, 554, 254);
    observer.callback([], observer as unknown as ResizeObserver);
    expect(mocks.engines[0].resize).toHaveBeenLastCalledWith(138, 15);

    hostRect = rect(100, 50, 0, 0);
    canvasRect = rect(120, 70, 0, 0);
    observer.callback([], observer as unknown as ResizeObserver);
    expect(mocks.engines[0].resize).toHaveBeenCalledOnce();
    terminal.dispose();
  });
});
