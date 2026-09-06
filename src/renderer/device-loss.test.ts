// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlasTexture, Renderer } from "./renderer-interface";
import { TerminalRenderer } from "./renderer";

const ATLAS = {
  cell: { width: 8, height: 16 },
  glyph: vi.fn(),
  isDirty: false,
  isFull: false,
  markUploaded: vi.fn(),
  reset: vi.fn(),
  source: {} as OffscreenCanvas,
} satisfies AtlasTexture;

type ErrorObservableRenderer = Renderer & {
  onError(listener: (error: Error) => void): () => void;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WebGPU device loss", () => {
  it("rejects clearly when WebGPU is unavailable", async () => {
    vi.stubGlobal("navigator", {});

    await expect(TerminalRenderer.create(document.createElement("canvas"), ATLAS)).rejects.toThrow(
      "WebGPU is unavailable",
    );
  });

  it("rejects when no adapter is available", async () => {
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: async () => null,
      },
    });

    await expect(TerminalRenderer.create(document.createElement("canvas"), ATLAS)).rejects.toThrow(
      "No WebGPU adapter",
    );
  });

  it("propagates device creation failure", async () => {
    const failure = new Error("requestDevice failed");
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: async () => ({
          requestDevice: async () => Promise.reject(failure),
        }),
      },
    });

    await expect(TerminalRenderer.create(document.createElement("canvas"), ATLAS)).rejects.toBe(
      failure,
    );
  });

  it("reports an unexpected lost device to renderer consumers", async () => {
    let loseDevice!: (info: GPUDeviceLostInfo) => void;
    const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
      loseDevice = resolve;
    });
    const context = { configure: vi.fn(), unconfigure: vi.fn() };
    const device = {
      addEventListener: vi.fn(),
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      createRenderPipeline: vi.fn(() => ({})),
      createSampler: vi.fn(() => ({})),
      createShaderModule: vi.fn(() => ({})),
      destroy: vi.fn(),
      lost,
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("navigator", {
      gpu: {
        getPreferredCanvasFormat: () => "bgra8unorm",
        requestAdapter: async () => ({ requestDevice: async () => device }),
      },
    });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(context as never);
    const renderer = (await TerminalRenderer.create(
      canvas,
      ATLAS,
    )) as unknown as ErrorObservableRenderer;
    const listener = vi.fn();

    const unsubscribe = renderer.onError(listener);
    loseDevice({ reason: "unknown", message: "GPU reset" } as GPUDeviceLostInfo);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ message: "WebGPU device lost: GPU reset" }),
    );
    unsubscribe();
    renderer.dispose();
  });
});
