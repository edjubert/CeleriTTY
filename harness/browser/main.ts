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
type CapturedCell = { width: number; height: number; rgba: number[] };
let captureRequested:
  | { resolve: (cell: CapturedCell) => void; reject: (error: unknown) => void }
  | undefined;
const terminal = new Terminal(host, options, async (canvas, atlas) => {
  cell = atlas.cell;
  const renderer = await createWebGpuRenderer(canvas, atlas);
  // Pixel regressions read this real WebGPU surface back into a PNG.
  const context = canvas.getContext("webgpu")!;
  const configuration = context.getConfiguration()!;
  context.configure({
    ...configuration,
    usage: configuration.usage | GPUTextureUsage.COPY_SRC,
  });
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
    const capture = captureRequested;
    if (capture === undefined) return;
    captureRequested = undefined;
    // Copy before Chromium presents/discards the current canvas texture.
    // This verifies the real renderer's pixels without browser image imports.
    const bytesPerRow = Math.ceil((cell.width * 4) / 256) * 256;
    const width = cell.width;
    const height = cell.height;
    const buffer = configuration.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = configuration.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: context.getCurrentTexture() },
      { buffer, bytesPerRow },
      { width, height },
    );
    configuration.device.queue.submit([encoder.finish()]);
    void buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const data = new Uint8Array(buffer.getMappedRange());
        const rgba: number[] = [];
        const bgra = configuration.format.startsWith("bgra");
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const offset = y * bytesPerRow + x * 4;
            rgba.push(
              data[offset + (bgra ? 2 : 0)],
              data[offset + 1],
              data[offset + (bgra ? 0 : 2)],
              data[offset + 3],
            );
          }
        capture.resolve({ width, height, rgba });
      })
      .catch(capture.reject)
      .finally(() => buffer.destroy());
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
  captureCell: () =>
    new Promise<CapturedCell>((resolve, reject) => {
      if (captureRequested !== undefined) {
        reject(new Error("A GPU cell capture is already pending"));
        return;
      }
      captureRequested = { resolve, reject };
      terminal.write("");
    }),
  state: () => ({ rows, inverse, cursor, cursorVisible, frames, cell, grid, errors, replies }),
};
declare global {
  interface Window {
    qa: typeof qa;
    ptyInput?: (bytes: number[]) => void;
  }
}
window.qa = qa;
