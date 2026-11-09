import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const diagnostics = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    const canvas = document.querySelector("canvas")!;
    return {
      state: window.qa?.state(),
      gpu: adapter
        ? {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          }
        : null,
      canvas: { width: canvas.width, height: canvas.height },
    };
  });
  const gpuPath = testInfo.outputPath("gpu-diagnostics.json");
  await writeFile(gpuPath, JSON.stringify(diagnostics, null, 2));
  console.log("GPU diagnostics:", JSON.stringify(diagnostics));
  await testInfo.attach("gpu-diagnostics", {
    path: gpuPath,
    contentType: "application/json",
  });
});

for (const dpr of [1, 2]) {
  test.describe(`cursor at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test("DECSCUSR draws block, beam and underline with the cursor palette color", async ({
      page,
    }) => {
      await page.goto("/browser.html");
      await page.waitForFunction(() => window.qa?.state().frames > 0);
      await page.evaluate(() => {
        window.qa.terminal.focus();
        // Integral CSS bounds keep screenshot pixels aligned with GPU pixels.
        window.qa.host.style.cssText =
          "position:absolute;left:0;top:100px;width:320px;height:192px";
        window.qa.terminal.setOptions({
          colors: {
            black: "#000000",
            red: "#000000",
            green: "#000000",
            yellow: "#000000",
            blue: "#000000",
            magenta: "#000000",
            cyan: "#000000",
            white: "#ffffff",
            brightBlack: "#000000",
            brightRed: "#000000",
            brightGreen: "#000000",
            brightYellow: "#000000",
            brightBlue: "#000000",
            brightMagenta: "#000000",
            brightCyan: "#000000",
            brightWhite: "#ffffff",
            foreground: "#ffffff",
            background: "#000000",
            cursor: "#ff0000",
          },
        });
      });
      await expect.poll(() => page.evaluate(() => window.qa.state().grid.columns)).toBe(40);
      for (const [parameter, shape] of [
        [2, "block"],
        [6, "beam"],
        [4, "underline"],
      ] as const) {
        await page.evaluate(
          (parameter) => window.qa.feed(`\x1b[2J\x1b[H\x1b[${parameter} q`),
          parameter,
        );
        await expect.poll(() => page.evaluate(() => window.qa.state().cursor?.shape)).toBe(shape);
        const pixels = await page.evaluate(async () => {
          const { width, height, rgba: data } = await window.qa.captureCell();
          const red: number[][] = [];
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const offset = (y * width + x) * 4;
              if (data[offset] > 250 && data[offset + 1] < 5 && data[offset + 2] < 5)
                red.push([x, y]);
            }
          return { red, width, height };
        });
        const stroke = Math.max(1, Math.round(pixels.width * 0.15));
        expect(pixels.red).toHaveLength(
          shape === "block"
            ? pixels.width * pixels.height
            : shape === "beam"
              ? stroke * pixels.height
              : pixels.width * stroke,
        );
        expect(
          pixels.red.every(
            ([x, y]) =>
              shape === "block" || (shape === "beam" ? x < stroke : y >= pixels.height - stroke),
          ),
        ).toBe(true);
      }
      // A block must keep the underlying glyph readable on inverse text too.
      await page.evaluate(() => window.qa.feed("\x1b[0m\x1b[HA\x1b[H\x1b[2 q"));
      await expect.poll(() => page.evaluate(() => window.qa.state().cursor?.shape)).toBe("block");
      const normal = await page.evaluate(() => window.qa.captureCell());
      await page.evaluate(() => window.qa.feed("\x1b[7mA\x1b[H"));
      await expect.poll(() => page.evaluate(() => window.qa.state().inverse)).toEqual(["0:0"]);
      expect(await page.evaluate(() => window.qa.captureCell())).toEqual(normal);
      await page.evaluate(() => window.qa.feed("\x1b[?25l"));
      await expect.poll(() => page.evaluate(() => window.qa.state().cursor)).toBeNull();
      expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
    });
  });
}

test("application blink, hiding and resetting to configured cursor defaults", async ({ page }) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  await page.evaluate(() => {
    window.qa.terminal.focus();
    window.qa.terminal.setOptions({ cursor: { style: "underline", blink: false } });
    window.qa.feed("\x1b[0 q");
  });
  await expect.poll(() => page.evaluate(() => window.qa.state().cursor?.shape)).toBe("underline");
  await page.evaluate(() => window.qa.feed("\x1b[5 q"));
  await expect.poll(() => page.evaluate(() => window.qa.state().cursor?.shape)).toBe("beam");
  await expect.poll(() => page.evaluate(() => window.qa.state().cursorVisible)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.qa.state().cursorVisible)).toBe(true);
  await page.evaluate(() => window.qa.feed("\x1b[?25l"));
  await expect.poll(() => page.evaluate(() => window.qa.state().cursor)).toBeNull();
  await page.evaluate(() => window.qa.feed("\x1b[?25h\x1b[0 q"));
  await expect.poll(() => page.evaluate(() => window.qa.state().cursor?.shape)).toBe("underline");
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
});
