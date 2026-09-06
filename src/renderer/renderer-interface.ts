/**
 * The contract between the terminal and whatever draws it.
 *
 * One implementation ships today (WebGPU). The interface exists so the draw
 * path can be asserted without a GPU, and so a second implementation is an
 * added file rather than a refactor.
 */

import type { CellMetrics } from "./atlas-layout";
import type { GlyphSource } from "./instance-data";

export interface RendererGrid {
  columns: number;
  lines: number;
  /** Packed snapshot: four u32 per cell. Rebuild it after every engine call. */
  packed: Uint32Array;
}

export interface AtlasTexture extends GlyphSource {
  readonly source: OffscreenCanvas;
  readonly isDirty: boolean;
  /** Physical-pixel size of one cell — the renderer draws at exactly this size. */
  readonly cell: CellMetrics;
  markUploaded(): void;
}

export interface Renderer {
  /**
   * Subscribe to an asynchronous renderer failure, such as WebGPU device
   * loss. Optional for third-party renderers that can only fail from
   * synchronous method calls.
   */
  onError?(listener: (error: Error) => void): () => void;

  /**
   * Replace the theme. Palette slot indices follow alacritty's
   * `vte::ansi::NamedColor` ordering: 0-15 ANSI, 256 foreground,
   * 257 background, 258 cursor. Must not rebuild the glyph atlas — colour is
   * applied per cell, so changing theme is a uniform write, not a re-raster.
   */
  setPalette(overrides: Map<number, string>): void;

  /**
   * Swap the glyph atlas. Implementations must drop any cached texture:
   * keeping it would draw old glyph shapes at the new cell metrics.
   */
  setAtlas(atlas: AtlasTexture): void;

  /** Draw one frame. Never schedules the next one — the caller owns the loop. */
  render(grid: RendererGrid): void;

  /**
   * Release every GPU resource. Late render calls are harmless no-ops;
   * configuration calls after disposal are programming errors and throw.
   */
  dispose(): void;
}

/**
 * Builds a renderer for a canvas. Asynchronous because acquiring a GPU
 * adapter and device is asynchronous; a constructor cannot do it.
 */
export type RendererFactory = (canvas: HTMLCanvasElement, atlas: AtlasTexture) => Promise<Renderer>;
