import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "harness/browser",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8123",
    viewport: { width: 1000, height: 700 },
    launchOptions: { args: ["--enable-unsafe-webgpu"] },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --config vite.harness.config.ts --host 127.0.0.1 --strictPort",
    url: "http://127.0.0.1:8123/browser.html",
    reuseExistingServer: false,
  },
});
