import { Terminal, createWebGpuRenderer } from "../../dist/index.js";
import { EngineTerminal, loadEngine } from "../../src/core/wasm";
import type { TerminalOptions } from "../../src/core/types";

const options = (await fetch(
  new URL("../../fixtures/full-theme/expected.json", import.meta.url).href,
).then((r) => r.json())) as TerminalOptions;
options.font.family = "monospace";
const host = document.querySelector<HTMLDivElement>("#terminal")!;
const errors: string[] = [];
const replies: number[][] = [];
let rows: string[] = [];
let inverse: string[] = [];
let cursor: { line: number; column: number; shape: string } | null = null;
let cursorVisible = true;
let frames = 0;
let cell = { width: 1, height: 1 };
let grid = { columns: 1, lines: 1 };
const terminal = new Terminal(host, options, async (canvas, atlas) => {
  cell = atlas.cell;
  const renderer = await createWebGpuRenderer(canvas, atlas);
  const setAtlas = renderer.setAtlas.bind(renderer);
  renderer.setAtlas = (atlas) => {
    cell = atlas.cell;
    setAtlas(atlas);
  };
  const render = renderer.render.bind(renderer);
  renderer.render = (value) => {
    grid = { columns: value.columns, lines: value.lines };
    rows = Array.from({ length: value.lines }, (_, line) =>
      Array.from({ length: value.columns }, (_, col) =>
        String.fromCodePoint(value.packed[(line * value.columns + col) * 4]),
      )
        .join("")
        .trimEnd(),
    );
    // Inverse text/selection cells and independent cursor shape markers.
    inverse = [];
    cursor = null;
    cursorVisible = value.cursorVisible !== false;
    for (let index = 0; index < value.lines * value.columns; index++) {
      const flags = value.packed[index * 4 + 3];
      if (flags & 1) inverse.push(`${Math.floor(index / value.columns)}:${index % value.columns}`);
      const shape =
        flags & (1 << 16)
          ? "block"
          : flags & (1 << 17)
            ? "beam"
            : flags & (1 << 18)
              ? "underline"
              : null;
      if (shape !== null)
        cursor = { line: Math.floor(index / value.columns), column: index % value.columns, shape };
    }
    frames++;
    render(value);
  };
  return renderer;
});
terminal.on("error", (error) => errors.push(error.message));
terminal.on("diagnostic", (error) => errors.push(error.message));
terminal.on("data", (bytes) => {
  replies.push(Array.from(bytes));
  window.ptyInput?.(Array.from(bytes));
});
await terminal.ready;
await loadEngine();
const qa = {
  terminal,
  host,
  errors,
  replies,
  EngineTerminal,
  Terminal,
  createWebGpuRenderer,
  options,
  feed: (text: string, replyToQueries = true) =>
    terminal.feed(new TextEncoder().encode(text), { replyToQueries }),
  state: () => ({ rows, inverse, cursor, cursorVisible, frames, cell, grid, errors, replies }),
};
declare global {
  interface Window {
    qa: typeof qa;
    ptyInput?: (bytes: number[]) => void;
  }
}
window.qa = qa;
