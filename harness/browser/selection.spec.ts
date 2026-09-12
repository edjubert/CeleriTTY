import { expect, test } from "@playwright/test";

test("selection: isolated 1.2.0 crash reproduction stays usable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/browser.html");
  await page.waitForFunction(() => !!window.qa);
  await page.evaluate(() => {
    const { qa } = window;
    qa.feed("BASELINE");
    const canvas = qa.host.querySelector("canvas")!;
    const box = canvas.getBoundingClientRect();
    const event = { bubbles: true, clientX: box.right + 20, clientY: box.top + 5 };
    canvas.dispatchEvent(new MouseEvent("mousedown", event));
    window.dispatchEvent(new MouseEvent("mouseup", event));
    qa.feed("\r\nSTILL_ALIVE");
    qa.terminal.getSelection();
  });
  await expect
    .poll(() => page.evaluate(() => window.qa.state().rows.join("\n")))
    .toContain("STILL_ALIVE");
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
});

for (const dpr of [1, 2]) {
  test.describe(`selection geometry at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    test("all edges, both endpoints, fractional pixels, scrollback and resizing", async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser.html");
      await page.waitForFunction(() => window.qa?.state().frames > 0);
      const results = await page.evaluate(async () => {
        const { qa } = window;
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const canvas = qa.host.querySelector("canvas")!;
        let checked = 0;
        const failures: unknown[] = [];
        for (const [width, height] of [
          [333.4, 201.4],
          [175.7, 93.3],
          [401.6, 241.2],
        ]) {
          qa.host.style.width = `${width}px`;
          qa.host.style.height = `${height}px`;
          // Observer and draw callbacks run in adjacent frames.
          await frame();
          await frame();
          await frame();
          qa.feed(
            "\x1b[2J\x1b[H" +
              Array.from(
                { length: 45 },
                (_, i) => `ROW_${String(i).padStart(3, "0")} abcdefghijkl`,
              ).join("\r\n"),
          );
          for (const scroll of [0, 10]) {
            qa.terminal.scrollLines(scroll);
            await frame();
            const state = qa.state();
            const box = canvas.getBoundingClientRect();
            const { columns, lines } = state.grid;
            const positions = [
              [-20, -20],
              [0.5, 0.5],
              [box.width - 0.1, 0.5],
              [box.width + 20, 5],
              [0.5, box.height - 0.1],
              [5, box.height + 20],
              [box.width + 20, box.height + 20],
              [-20, box.height + 20],
              [box.width + 20, -20],
              [box.width / 2, box.height / 2],
            ];
            for (const start of positions)
              for (const end of positions) {
                const point = ([x, y]: number[]) => ({
                  line: Math.max(
                    0,
                    Math.min(lines - 1, Math.floor((y * devicePixelRatio) / state.cell.height)),
                  ),
                  column: Math.max(
                    0,
                    Math.min(columns - 1, Math.floor((x * devicePixelRatio) / state.cell.width)),
                  ),
                });
                const sorted = [point(start), point(end)].sort(
                  (a, b) => a.line - b.line || a.column - b.column,
                );
                const [top, bottom] = sorted;
                const selected: string[] = [];
                for (let line = top.line; line <= bottom.line; line++) {
                  selected.push(
                    state.rows[line]
                      .padEnd(columns, " ")
                      .slice(
                        line === top.line ? top.column : 0,
                        line === bottom.line ? bottom.column + 1 : columns,
                      )
                      .trimEnd(),
                  );
                }
                // alacritty omits the final newline when selecting through a blank last cell.
                const expected = selected.join("\n").trimEnd() || null;
                const mouse = ([x, y]: number[]) => ({
                  bubbles: true,
                  clientX: box.left + x,
                  clientY: box.top + y,
                });
                canvas.dispatchEvent(new MouseEvent("mousedown", mouse(start)));
                window.dispatchEvent(new MouseEvent("mousemove", mouse(end)));
                window.dispatchEvent(new MouseEvent("mouseup", mouse(end)));
                const actual = qa.terminal.getSelection();
                if (actual?.trimEnd() !== expected?.trimEnd())
                  failures.push({ start, end, expected, actual, scroll, width });
                checked++;
              }
          }
        }
        qa.feed("\x1b[?25l");
        return { checked, failures };
      });
      expect(results.failures).toEqual([]);
      expect(results.checked).toBe(600);
      // Actual browser mouse events in residual bottom/right pixels, then a drag outside.
      const box = await page.locator("canvas").boundingBox();
      await page.mouse.move(box!.x + box!.width - 0.1, box!.y + box!.height - 0.1);
      await page.mouse.down();
      await page.mouse.move(1, 1);
      await page.mouse.up();
      // Resize during a drag: the start anchor belongs to the old, larger grid.
      await page.mouse.move(box!.x + box!.width - 1, box!.y + box!.height - 1);
      await page.mouse.down();
      await page.evaluate(() => {
        window.qa.host.style.width = "113.4px";
        window.qa.host.style.height = "61.4px";
      });
      await expect.poll(() => page.evaluate(() => window.qa.state().grid.columns)).toBeLessThan(20);
      await page.mouse.up();
      await page.evaluate(() => {
        window.qa.terminal.getSelection();
        window.qa.feed("\x1b[2J\x1b[HALIVE");
        window.qa.terminal.scrollToBottom();
      });
      await expect
        .poll(() => page.evaluate(() => window.qa.state().rows.join("\n")))
        .toContain("ALIVE");
      await page.screenshot({ path: info.outputPath("selection-alive.png") });
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
    });
  });
}

test("raw WASM boundary defends invalid and reversed viewport coordinates", async ({ page }) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => !!window.qa);
  const result = await page.evaluate(() => {
    const engine = new window.qa.EngineTerminal(8, 3);
    const feed = (text: string) => engine.feed(new TextEncoder().encode(text));
    try {
      feed("one\r\ntwo\r\nthree\r\nfour\r\nfive");
      engine.scrollLines(2);
      const selected = engine.selectedText(2, 0xffffffff, -100, 0);
      for (const line of [-2147483648, -1, 0, 3, 2147483647]) {
        for (const col of [-1, 0, 8, 0xffffffff]) {
          engine.selectedText(line, col, -line, col);
          engine.selectedText(-line, col, line, col);
        }
      }
      engine.resize(1, 1);
      engine.selectedText(2147483647, 0xffffffff, -2147483648, 0);
      feed("\x1b[2J\x1b[HX");
      engine.resetScroll();
      engine.refreshSnapshot();
      return { selected, alive: engine.rowText(0) };
    } finally {
      engine.free();
    }
  });
  expect(result).toEqual({ selected: "one\ntwo\nthree", alive: "X" });
});

test("selection of a wide-character wrap on the top row stays usable", async ({ page }) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => !!window.qa);
  const selection = await page.evaluate(() => {
    const engine = new window.qa.EngineTerminal(4, 3);
    engine.feed(new TextEncoder().encode("abc界"));
    const selected = engine.selectedText(0, 0, 0, 0xffffffff);
    engine.feed(new TextEncoder().encode("!"));
    engine.refreshSnapshot();
    engine.free();
    return selected;
  });
  expect(selection).toBe("abc界");
});
