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
let frames = 0;
let cell = { width: 1, height: 1 };
let grid = { columns: 1, lines: 1 };
const terminal = new Terminal(host, options, async (canvas, atlas) => {
  cell = atlas.cell;
  const renderer = await createWebGpuRenderer(canvas, atlas);
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
  feed: (text: string, replyToQueries = true) =>
    terminal.feed(new TextEncoder().encode(text), { replyToQueries }),
  state: () => ({ rows, frames, cell, grid, errors, replies }),
};
declare global {
  interface Window {
    qa: typeof qa;
    ptyInput?: (bytes: number[]) => void;
  }
}
window.qa = qa;
