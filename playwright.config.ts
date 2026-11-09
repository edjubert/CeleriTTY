import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "harness/browser",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8123",
    viewport: { width: 1000, height: 700 },
    launchOptions: {
      // Match ANGLE's compositor to Dawn's WebGPU backend. Otherwise headless
      // Chromium can render valid frames while capturing a transparent canvas.
      // Linux CI uses SwiftShader Vulkan and needs no physical GPU or surface.
      args: [
        "--enable-unsafe-webgpu",
        ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
        ...(process.platform === "linux"
          ? [
              "--use-angle=vulkan",
              "--use-vulkan=swiftshader",
              "--enable-features=Vulkan",
              "--disable-vulkan-surface",
            ]
          : []),
      ],
    },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --config vite.harness.config.ts --host 127.0.0.1 --strictPort",
    url: "http://127.0.0.1:8123/browser.html",
    reuseExistingServer: false,
  },
});
