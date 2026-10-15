// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRenderer } from "../renderer/fake-renderer";
import type { TerminalOptions } from "./types";
import { loadEngine } from "./wasm";
import { Terminal } from "./terminal";

// Real parser and selection rules, fixed 8×16 cells, no GPU.
vi.mock("../renderer/atlas", () => ({
  GlyphAtlas: class {
    readonly cell = { width: 8, height: 16 };
  },
}));

const options = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/full-theme/expected.json"), "utf8"),
) as TerminalOptions;
const CELL = { width: 8, height: 16 };
const INVERSE = 1;
let terminal: Terminal;
let host: HTMLDivElement;
let renderer: FakeRenderer;
let frame: FrameRequestCallback | undefined;

beforeAll(async () => {
  await loadEngine(readFileSync(join(import.meta.dirname, "../wasm/celeritty_bg.wasm")));
});

beforeEach(async () => {
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.createElement("div");
  document.body.appendChild(host);
  renderer = new FakeRenderer();
  terminal = new Terminal(host, options, async () => renderer);
  const canvas = host.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 40 * CELL.width, 6 * CELL.height),
  );
  await terminal.ready;
  terminal.feed(new TextEncoder().encode("$ cat /etc/hosts https://example.com\r\nsecond line"));
});

afterEach(() => {
  terminal?.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A pointer at `column` + `fraction` of a cell, on `line`. */
function at(line: number, column: number, fraction = 0.25): MouseEventInit {
  return {
    bubbles: true,
    button: 0,
    clientX: (column + fraction) * CELL.width,
    clientY: (line + 0.5) * CELL.height,
  };
}

function press(init: MouseEventInit, detail = 1): void {
  host.dispatchEvent(new MouseEvent("mousedown", { ...init, detail }));
}
function move(init: MouseEventInit): void {
  window.dispatchEvent(new MouseEvent("mousemove", init));
}
function release(init: MouseEventInit, detail = 1): void {
  window.dispatchEvent(new MouseEvent("mouseup", { ...init, detail }));
}

/** Cells drawn inverse in the next frame, as `line:column`. */
function highlighted(): string[] {
  frame?.(0);
  const { columns, packed } = renderer.frames.at(-1)!;
  const cells: string[] = [];
  for (let index = 0; index * 4 < packed.length; index++) {
    if (packed[index * 4 + 3] & INVERSE)
      cells.push(`${Math.floor(index / columns)}:${index % columns}`);
  }
  return cells;
}

describe("mouse selection", () => {
  it("a click selects and highlights nothing", () => {
    // Hide the real cursor so only selection highlight counts.
    terminal.feed(new TextEncoder().encode("\x1b[?25l"));
    const changes: Array<string | null> = [];
    terminal.on("selection-change", (text) => changes.push(text));
    press(at(0, 4, 0.75));
    expect(highlighted()).toEqual([]);
    release(at(0, 4, 0.75));
    expect(terminal.getSelection()).toBeNull();
    expect(highlighted()).toEqual([]);
    expect(changes).toEqual([null]);
  });

  it("a drag covers the cells whose middle it crosses", () => {
    terminal.feed(new TextEncoder().encode("\x1b[?25l"));
    press(at(0, 2, 0.4));
    move(at(0, 4, 0.6));
    release(at(0, 4, 0.6));
    expect(terminal.getSelection()).toBe("cat");
    expect(highlighted()).toEqual(["0:2", "0:3", "0:4"]);
    // Across one middle only: a single character.
    press(at(0, 7, 0.2));
    move(at(0, 7, 0.8));
    release(at(0, 7, 0.8));
    expect(terminal.getSelection()).toBe("e");
  });

  it("a double click selects a word, and dragging extends it word by word", () => {
    press(at(0, 9), 1);
    release(at(0, 9), 1);
    press(at(0, 9), 2);
    expect(terminal.getSelection()).toBe("/etc/hosts");
    release(at(0, 9), 2);
    expect(terminal.getSelection()).toBe("/etc/hosts");

    press(at(0, 3), 2);
    move(at(0, 9));
    release(at(0, 9), 2);
    expect(terminal.getSelection()).toBe("cat /etc/hosts");
  });

  it("a link opens on a single click only", () => {
    const activate = vi.fn();
    terminal.on("link-activate", activate);
    press(at(0, 27), 1);
    release(at(0, 27), 1);
    expect(activate).toHaveBeenCalledOnce();
    press(at(0, 27), 2);
    release(at(0, 27), 2);
    // alacritty's word boundaries include `:`, as in Alacritty itself.
    expect(terminal.getSelection()).toBe("//example.com");
    expect(activate).toHaveBeenCalledOnce();
  });

  it("a triple click selects the whole line, and dragging extends it line by line", () => {
    press(at(0, 5), 3);
    release(at(0, 5), 3);
    expect(terminal.getSelection()).toBe("$ cat /etc/hosts https://example.com");

    press(at(0, 5), 3);
    move(at(1, 0));
    release(at(1, 0), 3);
    expect(terminal.getSelection()).toBe("$ cat /etc/hosts https://example.com\nsecond line");
  });

  it("a word selection follows its text when the view scrolls", () => {
    // Push both lines into history, then scroll back to the top of it.
    terminal.feed(new TextEncoder().encode("\r\n".repeat(10)));
    terminal.scrollLines(10);
    press(at(1, 2), 2);
    release(at(1, 2), 2);
    expect(terminal.getSelection()).toBe("second");
    terminal.scrollToBottom();
    expect(terminal.getSelection()).toBe("second");
  });
});
