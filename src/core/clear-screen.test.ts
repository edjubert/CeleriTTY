// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRenderer } from "../renderer/fake-renderer";
import type { TerminalOptions } from "./types";
import { loadEngine } from "./wasm";
import { Terminal } from "./terminal";

// Exercise the real parser and public Terminal API without requiring a GPU.
vi.mock("../renderer/atlas", () => ({
  GlyphAtlas: class {
    readonly cell = { width: 8, height: 16 };
  },
}));

const options = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/full-theme/expected.json"), "utf8"),
) as TerminalOptions;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
let terminal: Terminal;
let renderer: FakeRenderer;
let frame: FrameRequestCallback | undefined;

beforeAll(async () => {
  await loadEngine(readFileSync(join(import.meta.dirname, "../wasm/celeritty_bg.wasm")));
});

beforeEach(async () => {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const host = document.createElement("div");
  document.body.appendChild(host);
  renderer = new FakeRenderer();
  terminal = new Terminal(host, options, async () => renderer);
  await terminal.ready;
});

afterEach(() => {
  terminal?.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Draw a frame and return its non-empty rows. */
function rows(): string[] {
  frame?.(0);
  const { columns, lines, packed } = renderer.frames.at(-1)!;
  return Array.from({ length: lines }, (_, line) =>
    Array.from({ length: columns }, (_, column) =>
      String.fromCodePoint(packed[(line * columns + column) * 4] || 32),
    )
      .join("")
      .trimEnd(),
  ).filter((row) => row !== "");
}

describe("clearScreen", () => {
  it("keeps the prompt line as the first row and drops the history", () => {
    terminal.feed(encode(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\r\n")));
    terminal.feed(encode("\r\n$ echo hi"));
    terminal.scrollLines(5);

    terminal.clearScreen();

    expect(rows()).toEqual(["$ echo hi"]);
    // The shell keeps editing the same line.
    terminal.feed(encode("!"));
    expect(rows()).toEqual(["$ echo hi!"]);
    // Nothing is left to scroll back into.
    terminal.scrollLines(10);
    expect(rows()).toEqual(["$ echo hi!"]);
  });

  it("sends nothing to the process", () => {
    const data = vi.fn();
    terminal.on("data", data);
    terminal.feed(encode("out\r\n$ "));
    terminal.clearScreen();
    expect(data).not.toHaveBeenCalled();
  });

  it("applies output from a pending synchronized update before clearing", () => {
    terminal.feed(encode("\x1b[2J\x1b[Hbefore\r\n$ old"));
    terminal.feed(encode("\x1b[?2026h\r\nresult\r\n$ new"));
    terminal.clearScreen();
    terminal.feed(encode("\x1b[?2026l"));
    expect(rows()).toEqual(["$ new"]);
  });

  it("sends replies deferred in a synchronized update once, under their policy", () => {
    const data: string[] = [];
    terminal.on("data", (bytes) => data.push(new TextDecoder().decode(bytes)));
    // Live output: the status query is answered when the batch is applied.
    terminal.feed(encode("\x1b[?2026h\x1b[5n$ "));
    expect(data).toEqual([]);
    terminal.clearScreen();
    expect(data).toEqual(["\x1b[0n"]);
    terminal.feed(encode("\x1b[?2026l"));
    expect(data).toEqual(["\x1b[0n"]);
    // Local writes never reach the process, even when applied by a clear.
    terminal.write("\x1b[?2026h\x1b[5n");
    terminal.clearScreen();
    expect(data).toEqual(["\x1b[0n"]);
  });

  it("leaves a full-screen program's alternate screen alone", () => {
    terminal.feed(encode("\x1b[?1049h\x1b[Hvim buffer"));
    terminal.clearScreen();
    expect(rows()).toEqual(["vim buffer"]);
  });
});
