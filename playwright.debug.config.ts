import { defineConfig } from "@playwright/test";
import browser from "./playwright.config";

export default defineConfig({
  ...browser,
  testDir: "debug",
  use: { ...browser.use, baseURL: "http://127.0.0.1:8125" },
  webServer: {
    command: "pnpm exec vite --config vite.debug.config.ts --port 8125",
    url: "http://127.0.0.1:8125",
    reuseExistingServer: false,
  },
});
