/**
 * A renderer that draws nothing and records everything.
 *
 * vitest has no WebGPU context, so this is the only way to assert what the
 * terminal asked to be drawn. Exported from the package because consumers
 * testing their own integration need the same thing.
 */

import type { AtlasTexture, Renderer, RendererFactory, RendererGrid } from "./renderer-interface";

export interface RecordedFrame {
  columns: number;
  lines: number;
  /** A copy, not the caller's buffer — see `render`. */
  packed: Uint32Array;
  cursorVisible: boolean;
}

export class FakeRenderer implements Renderer {
  readonly frames: RecordedFrame[] = [];
  readonly atlases: AtlasTexture[] = [];
  readonly palettes: Array<Map<number, string>> = [];
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  setPalette(overrides: Map<number, string>): void {
    this.#assertLive("setPalette");
    // Copied for the same reason frames are: the caller may reuse the map.
    this.palettes.push(new Map(overrides));
  }

  setAtlas(atlas: AtlasTexture): void {
    this.#assertLive("setAtlas");
    this.atlases.push(atlas);
  }

  render(grid: RendererGrid): void {
    this.#assertLive("render");
    // `packed` is a view over the engine's wasm memory and is rewritten in
    // place on every refresh. Storing the reference would make every
    // recorded frame show the latest contents, silently passing tests that
    // should fail. Copy it.
    this.frames.push({
      columns: grid.columns,
      lines: grid.lines,
      packed: grid.packed.slice(),
      cursorVisible: grid.cursorVisible !== false,
    });
  }

  dispose(): void {
    this.#assertLive("dispose");
    this.#disposed = true;
  }

  #assertLive(method: string): void {
    if (this.#disposed) {
      throw new Error(`FakeRenderer.${method}() was called after dispose().`);
    }
  }
}

export const createFakeRenderer: RendererFactory = () => Promise.resolve(new FakeRenderer());
