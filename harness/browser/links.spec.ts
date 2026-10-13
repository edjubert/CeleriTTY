import { expect, test } from "@playwright/test";

/**
 * Link activation against the real WASM engine and WebGPU renderer: a click
 * on a detected URL opens it, with no GPU errors.
 */
test("links: a click on a detected URL opens it, with no GPU errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);

  const result = await page.evaluate(async () => {
    const { qa } = window;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    qa.feed("x https://example.com y");
    await frame();
    await frame();

    const canvas = qa.host.querySelector("canvas")!;
    const { cell } = qa.state();
    const dpr = window.devicePixelRatio;

    const opened: string[] = [];
    window.open = ((url: string) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    const box = canvas.getBoundingClientRect();
    // Column 5 is inside "https://example.com" (columns 2..20).
    const event = {
      bubbles: true,
      button: 0,
      clientX: box.left + (5.5 * cell.width) / dpr,
      clientY: box.top + (0.5 * cell.height) / dpr,
    };
    canvas.dispatchEvent(new MouseEvent("mousedown", event));
    window.dispatchEvent(new MouseEvent("mouseup", event));

    return { opened, row: qa.state().rows[0], frames: qa.state().frames };
  });

  expect(result.row).toContain("https://example.com");
  expect(result.opened).toEqual(["https://example.com"]);
  expect(result.frames).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
});
