import { expect, test } from "@playwright/test";

test("built WASM parses output, answers queries and renders with WebGPU", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  await page.evaluate(() => window.qa.feed("WASM_WEBGPU_OK\x1b[5n"));
  await expect.poll(() => page.evaluate(() => window.qa.state().rows[0])).toBe("WASM_WEBGPU_OK");
  expect(
    await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.qa.replies.flat()))),
  ).toBe("\x1b[0n");
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
  expect(errors).toEqual([]);
});
