// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRenderer } from "../renderer/fake-renderer";
import { Terminal } from "./terminal";
import type { TerminalOptions } from "./types";
import { loadEngine } from "./wasm";

// Real public API, WASM engine and recorded grids; only browser graphics are stubbed.
const options = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/full-theme/expected.json"), "utf8"),
) as TerminalOptions;
const terminals: Terminal[] = [];
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;

beforeAll(async () => {
  await loadEngine(readFileSync(join(import.meta.dirname, "../wasm/celeritty_bg.wasm")));
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
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
          beginPath() {},
          clip() {},
          drawImage() {},
          fillText() {},
          rect() {},
          restore() {},
          save() {},
          measureText: () => ({ width: 8 }),
        };
      }
    },
  );
});

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tick() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

async function mount(parent: Node = document.body, focusBeforeReady = false) {
  const host = document.createElement("div");
  parent.appendChild(host);
  const renderer = new FakeRenderer();
  const terminal = new Terminal(host, options, async () => renderer);
  terminals.push(terminal);
  if (focusBeforeReady) terminal.focus();
  await terminal.ready;
  tick();
  const input = host.querySelector("textarea")!;
  return { host, input, terminal, renderer };
}

function inverse(renderer: FakeRenderer): number[] {
  const packed = renderer.frames.at(-1)!.packed;
  const cells = [];
  for (let index = 3; index < packed.length; index += 4) {
    if (packed[index] & 1) cells.push((index - 3) / 4);
  }
  return cells;
}

describe("cursor presentation follows actual focus", () => {
  it("starts hidden and moves between instances without PTY output or writes", async () => {
    const a = await mount();
    const b = await mount();
    const data = vi.fn();
    a.terminal.on("data", data);
    b.terminal.on("data", data);
    expect(inverse(a.renderer)).toEqual([]);
    expect(inverse(b.renderer)).toEqual([]);

    a.terminal.focus();
    tick();
    expect(document.activeElement).toBe(a.input);
    expect(inverse(a.renderer)).toEqual([0]);
    expect(inverse(b.renderer)).toEqual([]);
    const before = a.renderer.frames.length;
    a.terminal.blur();
    b.terminal.focus();
    tick();
    expect(document.activeElement).toBe(b.input);
    expect(a.renderer.frames.length).toBe(before + 1);
    expect(inverse(a.renderer)).toEqual([]);
    expect(inverse(b.renderer)).toEqual([0]);

    a.terminal.write("");
    b.terminal.write("");
    tick();
    expect(inverse(a.renderer)).toEqual([]);
    expect(inverse(b.renderer)).toEqual([0]);
    b.terminal.blur();
    tick();
    expect(inverse(b.renderer)).toEqual([]);
    expect(data).not.toHaveBeenCalled();
  });

  it("tracks host/textarea focus and leaving for another field", async () => {
    const a = await mount();
    const b = await mount();
    a.host.focus();
    tick();
    expect(document.activeElement).toBe(a.input);
    expect(inverse(a.renderer)).toEqual([0]);
    b.input.focus();
    tick();
    expect(inverse(a.renderer)).toEqual([]);
    expect(inverse(b.renderer)).toEqual([0]);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    tick();
    expect(inverse(b.renderer)).toEqual([]);
  });

  it("initializes focus received before ready and supports a shadow-root host", async () => {
    const early = await mount(document.body, true);
    expect(document.activeElement).toBe(early.input);
    expect(inverse(early.renderer)).toEqual([0]);
    const outer = document.createElement("div");
    document.body.appendChild(outer);
    const root = outer.attachShadow({ mode: "open" });
    const a = await mount(root);
    a.host.focus();
    tick();
    expect(root.activeElement).toBe(a.input);
    expect(inverse(a.renderer)).toEqual([0]);
    a.terminal.blur();
    tick();
    expect(inverse(a.renderer)).toEqual([]);
  });

  it("hides on window blur or document hiding even while activeElement stays inside", async () => {
    const a = await mount();
    a.terminal.focus();
    tick();
    expect(inverse(a.renderer)).toEqual([0]);
    window.dispatchEvent(new Event("blur"));
    tick();
    expect(document.activeElement).toBe(a.input);
    expect(inverse(a.renderer)).toEqual([]);
    window.dispatchEvent(new Event("focus"));
    tick();
    expect(inverse(a.renderer)).toEqual([0]);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    tick();
    expect(inverse(a.renderer)).toEqual([]);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    tick();
    expect(inverse(a.renderer)).toEqual([0]);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    tick();
    expect(inverse(a.renderer)).toEqual([]);
  });

  it("preserves application cursor visibility across blur, refocus and unfocused output", async () => {
    const a = await mount();
    a.terminal.write("\x1b[?25l");
    a.terminal.focus();
    tick();
    expect(inverse(a.renderer)).toEqual([]);
    a.terminal.blur();
    a.terminal.focus();
    tick();
    expect(inverse(a.renderer)).toEqual([]);
    a.terminal.blur();
    a.terminal.write("\x1b[?25h");
    tick();
    expect(inverse(a.renderer)).toEqual([]);
    a.terminal.focus();
    tick();
    expect(inverse(a.renderer)).toEqual([0]);
    a.terminal.write("\x1b[?25l");
    tick();
    expect(inverse(a.renderer)).toEqual([]);
  });

  it("preserves inverse SGR cells and selection while toggling only the cursor overlay", async () => {
    const a = await mount();
    a.terminal.write("\x1b[7mAB\x1b[0mCD\r");
    tick();
    expect(inverse(a.renderer)).toEqual([0, 1]);
    a.terminal.focus();
    tick();
    expect(inverse(a.renderer)).toEqual([1]);
    a.terminal.blur();
    tick();
    expect(inverse(a.renderer)).toEqual([0, 1]);
    const canvas = a.host.querySelector("canvas")!;
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 17, clientY: 1 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 31, clientY: 1 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 31, clientY: 1 }));
    tick();
    expect(a.terminal.getSelection()).toBe("CD");
    expect(inverse(a.renderer)).toEqual([1, 2, 3]);
    a.terminal.blur();
    tick();
    expect(a.terminal.getSelection()).toBe("CD");
    expect(inverse(a.renderer)).toEqual([0, 1, 2, 3]);
  });

  it("removes focus listeners on disposal", async () => {
    const a = await mount();
    a.terminal.focus();
    tick();
    a.terminal.dispose();
    const count = a.renderer.frames.length;
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    a.host.focus();
    tick();
    expect(a.renderer.frames).toHaveLength(count);
    expect(frames.size).toBe(0);
  });
});
