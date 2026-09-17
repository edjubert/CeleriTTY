import { defineConfig } from "@playwright/test";
import browser from "./playwright.config";

export default defineConfig({
  ...browser,
  testDir: "harness/integration",
});
