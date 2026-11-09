import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "harness/browser",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    // Exercise the complete Chromium browser used by embedding applications.
    channel: "chromium",
    baseURL: "http://127.0.0.1:8123",
    viewport: { width: 1000, height: 700 },
    launchOptions: {
      // Match ANGLE's compositor to Dawn's Metal backend on macOS.
      args: [
        "--enable-unsafe-webgpu",
        ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
        ...(process.platform === "linux"
          ? [
              // Use one Vulkan device for ANGLE, Skia and WebGPU canvas backing.
              "--use-angle=vulkan",
              "--use-vulkan=native",
              "--enable-features=Vulkan,VulkanFromANGLE",
              "--disable-vulkan-surface",
              "--ignore-gpu-blocklist",
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
