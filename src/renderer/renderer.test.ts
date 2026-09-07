// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlasTexture } from "./renderer-interface";
import { TerminalRenderer } from "./renderer";

const ATLAS = {
  cell: { width: 8, height: 16 },
  glyph: vi.fn(),
  isFull: false,
  isDirty: false,
  markUploaded: vi.fn(),
  reset: vi.fn(),
  source: {} as OffscreenCanvas,
} satisfies AtlasTexture;

function installGpu(device: object) {
  vi.stubGlobal("navigator", {
    gpu: {
      getPreferredCanvasFormat: () => "bgra8unorm",
      requestAdapter: async () => ({ requestDevice: async () => device }),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TerminalRenderer lifecycle", () => {
  it("destroys an acquired device when canvas context creation fails", async () => {
    const destroy = vi.fn();
    installGpu({ destroy });
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(null);

    await expect(TerminalRenderer.create(canvas, ATLAS)).rejects.toThrow(
      "Could not acquire a WebGPU context",
    );

    expect(destroy).toHaveBeenCalledOnce();
  });

  it("unconfigures the context and disposes GPU resources idempotently", async () => {
    const buffers = [{ destroy: vi.fn() }, { destroy: vi.fn() }];
    const context = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
    };
    const device = {
      createBuffer: vi.fn(() => buffers.shift()!),
      createPipelineLayout: vi.fn(),
      createRenderPipeline: vi.fn(() => ({})),
      createSampler: vi.fn(() => ({})),
      createShaderModule: vi.fn(() => ({})),
      destroy: vi.fn(),
    };
    installGpu(device);
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(context as never);

    const renderer = await TerminalRenderer.create(canvas, ATLAS);
    const allocated = device.createBuffer.mock.results.map(({ value }) => value);
    renderer.dispose();
    renderer.dispose();
    expect(() =>
      renderer.render({ columns: 1, lines: 1, packed: new Uint32Array(4) }),
    ).not.toThrow();
    expect(() => renderer.setAtlas(ATLAS)).toThrow("after dispose");
    expect(() => renderer.setPalette(new Map())).toThrow("after dispose");

    expect(context.unconfigure).toHaveBeenCalledOnce();
    expect(allocated[0].destroy).toHaveBeenCalledOnce();
    expect(allocated[1].destroy).toHaveBeenCalledOnce();
    expect(device.destroy).toHaveBeenCalledOnce();
  });
});
