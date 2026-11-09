import { expect, test } from "@playwright/test";

test("the browser's native WebGPU adapter renders and maps pixels without a terminal", async ({
  page,
}) => {
  await page.goto("/gpu.html");
  const pixels = await page.evaluate(async () => {
    const gpu = navigator.gpu;
    const adapter = await gpu.requestAdapter();
    if (adapter === null) throw new Error("No native WebGPU adapter");
    const device = await adapter.requestDevice();
    const canvas = document.querySelector("canvas")!;
    const context = canvas.getContext("webgpu")!;
    const format = gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const texture = context.getCurrentTexture();
    const buffer = device.createBuffer({
      size: 256 * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView(),
            clearValue: { r: 1, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.end();
      encoder.copyTextureToBuffer(
        { texture },
        { buffer, bytesPerRow: 256 },
        { width: 8, height: 8 },
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(buffer.getMappedRange());
      const rgba = Array.from(data.subarray(0, 4));
      if (format.startsWith("bgra")) [rgba[0], rgba[2]] = [rgba[2], rgba[0]];
      return { rgba, vendor: adapter.info.vendor, architecture: adapter.info.architecture };
    } finally {
      buffer.destroy();
      context.unconfigure();
      device.destroy();
    }
  });
  console.log("Native WebGPU adapter:", pixels);
  expect(pixels.rgba).toEqual([255, 0, 0, 255]);
});
