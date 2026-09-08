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

async function gpuRenderer() {
  let lose!: (info: GPUDeviceLostInfo) => void;
  const device = {
    lost: new Promise<GPUDeviceLostInfo>((resolve) => {
      lose = resolve;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createRenderPipeline: vi.fn(() => ({})),
    createSampler: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    destroy: vi.fn(),
  };
  vi.stubGlobal("navigator", {
    gpu: {
      getPreferredCanvasFormat: () => "bgra8unorm",
      requestAdapter: async () => ({ requestDevice: async () => device }),
    },
  });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue({ configure: vi.fn() } as never);
  const renderer = await TerminalRenderer.create(canvas, ATLAS);
  const uncaptured = device.addEventListener.mock.calls.find(
    ([type]) => type === "uncapturederror",
  )![1];
  return { renderer, device, lose, uncaptured };
}

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

  it("reports repeated uncaptured diagnostics without suppressing later device loss", async () => {
    const { renderer, device, lose, uncaptured } = await gpuRenderer();
    const diagnostic = vi.fn();
    const fatal = vi.fn();
    renderer.onDiagnostic(diagnostic);
    renderer.onError(fatal);
    for (const message of ["validation", "out of memory", "internal"]) {
      uncaptured({ error: { message } });
    }
    expect(diagnostic).toHaveBeenCalledTimes(3);
    expect(fatal).not.toHaveBeenCalled();
    expect(device.destroy).not.toHaveBeenCalled();
    lose({ reason: "unknown", message: "later loss" } as GPUDeviceLostInfo);
    await Promise.resolve();
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: "WebGPU device lost: later loss" }),
    );
    renderer.dispose();
    uncaptured({ error: { message: "late diagnostic" } });
    expect(diagnostic).toHaveBeenCalledTimes(3);
  });

  it("replays cached early device loss to a late subscriber", async () => {
    const { renderer, lose } = await gpuRenderer();
    lose({ reason: "unknown", message: "early loss" } as GPUDeviceLostInfo);
    await Promise.resolve();
    const listener = vi.fn();
    renderer.onError(listener);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ message: "WebGPU device lost: early loss" }),
    );
    renderer.dispose();
  });

  it.each([false, true])(
    "ignores subscriptions after disposal (cached failure: %s)",
    async (failed) => {
      const { renderer, lose } = await gpuRenderer();
      if (failed) {
        lose({ reason: "unknown", message: "early loss" } as GPUDeviceLostInfo);
        await Promise.resolve();
      }
      renderer.dispose();
      const listener = vi.fn();
      const add = vi.spyOn(Set.prototype, "add");
      const offError = renderer.onError(listener);
      const offDiagnostic = renderer.onDiagnostic(listener);
      const retained = add.mock.calls.some(([value]) => value === listener);
      add.mockRestore();
      expect(retained).toBe(false);
      expect(listener).not.toHaveBeenCalled();
      expect(() => {
        offError();
        offDiagnostic();
      }).not.toThrow();
    },
  );

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
