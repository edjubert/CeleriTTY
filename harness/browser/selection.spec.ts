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
            // Positions overshoot horizontally on both sides but stay inside
            // vertically: a drag that leaves the viewport top or bottom now
            // auto-scrolls the display (covered by a dedicated test below),
            // which would make these expectations drift.
            const positions = [
              [-20, 0.5],
              [0.5, 0.5],
              [box.width - 0.1, 0.5],
              [box.width + 20, 5],
              [0.5, box.height - 0.1],
              [5, box.height - 0.1],
              [box.width + 20, box.height - 0.1],
              [-20, box.height - 0.1],
              [box.width + 20, 0.5],
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

test("selection drags past the viewport edges auto-scroll the display", async ({ page }) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  const result = await page.evaluate(async () => {
    const { qa } = window;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // A fixed, tall-enough host keeps the cell math predictable: overshoot of
    // a few lines can never clamp the start anchor against the grid edge.
    qa.host.style.width = "401.6px";
    qa.host.style.height = "241.2px";
    await frame();
    await frame();
    const canvas = qa.host.querySelector("canvas")!;
    const box = canvas.getBoundingClientRect();
    qa.feed(
      "\x1b[2J\x1b[H" +
        Array.from({ length: 60 }, (_, i) => `R${String(i).padStart(3, "0")}`).join("\r\n"),
    );
    await frame();
    await frame();

    const drag = (startX: number, startY: number, endX: number, endY: number) => {
      const at = (x: number, y: number) => ({ bubbles: true, clientX: x, clientY: y });
      canvas.dispatchEvent(new MouseEvent("mousedown", at(startX, startY)));
      window.dispatchEvent(new MouseEvent("mousemove", at(endX, endY)));
      window.dispatchEvent(new MouseEvent("mouseup", at(endX, endY)));
    };
    const rowIndex = (y: number) => {
      const cell = qa.state().cell;
      return Math.max(
        0,
        Math.min(
          qa.state().grid.lines - 1,
          Math.floor(((y - box.top) * devicePixelRatio) / cell.height),
        ),
      );
    };

    // Up: dragging past the top edge scrolls the viewport into history and
    // extends the selection above what was visible before the drag. The end
    // column is the left edge so the top line keeps its full label; the start
    // column is mid-row so the bottom line does too.
    const beforeUp = qa.state().rows;
    const startRowUp = rowIndex(box.top + box.height / 2);
    drag(box.left + box.width / 2, box.top + box.height / 2, box.left + 1, box.top - 40);
    const selectionUp = qa.terminal.getSelection();
    await frame();
    await frame();
    const afterUp = qa.state().rows;

    // Down: from history, dragging past the bottom edge scrolls back toward
    // the live screen and the selection follows the content below the
    // pre-drag viewport.
    qa.terminal.scrollToBottom();
    qa.terminal.scrollLines(8);
    await frame();
    await frame();
    const beforeDown = qa.state().rows;
    const startRowDown = rowIndex(box.top + box.height / 2);
    drag(box.left + 1, box.top + box.height / 2, box.left + box.width / 2, box.bottom + 40);
    const selectionDown = qa.terminal.getSelection();
    await frame();
    await frame();
    const afterDown = qa.state().rows;

    return {
      beforeUp,
      afterUp,
      selectionUp,
      startRowUp,
      beforeDown,
      afterDown,
      selectionDown,
      startRowDown,
    };
  });

  const label = (row: string): number => {
    const match = /^R(\d{3})/.exec(row);
    return match === null ? Number.NaN : Number(match[1]);
  };
  const linesUp = (result.selectionUp ?? "").trimEnd().split("\n");
  const linesDown = (result.selectionDown ?? "").trimEnd().split("\n");

  // Up: the viewport moved into history...
  expect(label(result.afterUp[0])).toBeLessThan(label(result.beforeUp[0]));
  // ...the selection starts above the pre-drag viewport top...
  expect(label(linesUp[0])).toBeLessThan(label(result.beforeUp[0]));
  // ...and still ends on the row the drag started from.
  expect(label(linesUp[linesUp.length - 1])).toBe(label(result.beforeUp[result.startRowUp]));

  // Down: the viewport moved back toward the live screen...
  expect(label(result.afterDown[0])).toBeGreaterThan(label(result.beforeDown[0]));
  // ...the selection reaches content that was below the pre-drag viewport...
  expect(label(linesDown[linesDown.length - 1])).toBeGreaterThan(
    label(result.beforeDown[result.beforeDown.length - 1]),
  );
  // ...and still starts on the row the drag started from.
  expect(label(linesDown[0])).toBe(label(result.beforeDown[result.startRowDown]));
});

for (const routing of ["explicit", "wheel"] as const) {
  test(`selection stays anchored during ${routing} scrolling`, async ({ page }) => {
    await page.goto("/browser.html");
    await page.waitForFunction(() => window.qa?.state().frames > 0);
    const result = await page.evaluate(async (routing) => {
      const { qa } = window;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      qa.host.style.width = "401.6px";
      qa.host.style.height = "241.2px";
      await frame();
      await frame();
      const canvas = qa.host.querySelector("canvas")!;
      const box = canvas.getBoundingClientRect();
      qa.feed(
        "\x1b[2J\x1b[H" +
          Array.from({ length: 60 }, (_, i) => `R${String(i).padStart(3, "0")}`).join("\r\n"),
      );
      await frame();
      await frame();

      const cell = qa.state().cell;
      // Select a row in the middle of the viewport.
      const midY = box.top + box.height / 2;
      const startX = box.left + cell.width / devicePixelRatio;
      const endX = box.left + (cell.width * 4) / devicePixelRatio;
      const at = (x: number, y: number) => ({ bubbles: true, clientX: x, clientY: y });
      canvas.dispatchEvent(new MouseEvent("mousedown", at(startX, midY)));
      window.dispatchEvent(new MouseEvent("mousemove", at(endX, midY)));
      window.dispatchEvent(new MouseEvent("mouseup", at(endX, midY)));
      const expectedText = qa.terminal.getSelection();
      const scroll = (lines: number) => {
        if (routing === "explicit") qa.terminal.scrollLines(lines);
        else
          qa.host.dispatchEvent(
            new WheelEvent("wheel", {
              deltaMode: 1,
              deltaY: -lines,
              bubbles: true,
              cancelable: true,
              clientX: startX,
              clientY: midY,
            }),
          );
      };

      // Scroll up into history: the selection must follow the content.
      scroll(3);
      await frame();
      await frame();
      const afterScrollUp = qa.terminal.getSelection();

      // Scroll back down to the live screen.
      scroll(-3);
      await frame();
      await frame();
      const afterScrollDown = qa.terminal.getSelection();

      // Scroll up again, then jump to bottom: the selection must still track
      // the same content.
      scroll(3);
      await frame();
      await frame();
      qa.terminal.scrollToBottom();
      await frame();
      await frame();
      const afterScrollToBottom = qa.terminal.getSelection();

      return {
        expectedText,
        afterScrollUp,
        afterScrollDown,
        afterScrollToBottom,
      };
    }, routing);

    // The selection text is invariant under viewport scrolling.
    expect(result.expectedText).not.toBeNull();
    expect(result.afterScrollUp).toBe(result.expectedText);
    expect(result.afterScrollDown).toBe(result.expectedText);
    expect(result.afterScrollToBottom).toBe(result.expectedText);
  });
}

test("selection scrolled past the viewport edge disappears visually but keeps its text", async ({
  page,
}) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  const result = await page.evaluate(async () => {
    const { qa } = window;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    qa.host.style.width = "401.6px";
    qa.host.style.height = "241.2px";
    await frame();
    await frame();
    const canvas = qa.host.querySelector("canvas")!;
    const box = canvas.getBoundingClientRect();
    qa.feed(
      "\x1b[2J\x1b[H" +
        Array.from({ length: 60 }, (_, i) => `R${String(i).padStart(3, "0")}`).join("\r\n"),
    );
    await frame();
    await frame();

    const cell = qa.state().cell;
    const grid = qa.state().grid;
    // Select the topmost visible row.
    const topY = box.top + cell.height / devicePixelRatio / 2;
    const startX = box.left + cell.width / devicePixelRatio;
    const endX = box.left + (cell.width * 4) / devicePixelRatio;
    const at = (x: number, y: number) => ({ bubbles: true, clientX: x, clientY: y });
    canvas.dispatchEvent(new MouseEvent("mousedown", at(startX, topY)));
    window.dispatchEvent(new MouseEvent("mousemove", at(endX, topY)));
    window.dispatchEvent(new MouseEvent("mouseup", at(endX, topY)));
    const expectedText = qa.terminal.getSelection();
    const firstRow = qa.state().rows[0];

    // Scroll up enough that the selected row leaves the viewport entirely.
    qa.terminal.scrollLines(grid.lines + 5);
    await frame();
    await frame();
    const selectionOffScreen = qa.terminal.getSelection();
    const rowsAfterScroll = qa.state().rows;

    // Scroll back down: the selection reappears on the same content.
    qa.terminal.scrollToBottom();
    await frame();
    await frame();
    const selectionBack = qa.terminal.getSelection();
    const rowsAfterReturn = qa.state().rows;

    return {
      expectedText,
      firstRow,
      selectionOffScreen,
      rowsAfterScroll,
      selectionBack,
      rowsAfterReturn,
      gridLines: grid.lines,
    };
  });

  // The selection text is preserved even when scrolled off-screen.
  expect(result.selectionOffScreen).toBe(result.expectedText);
  // The viewport actually moved (the selected row is no longer visible).
  expect(result.rowsAfterScroll[0]).not.toBe(result.firstRow);
  // After returning to the bottom, the selection still resolves the same text.
  expect(result.selectionBack).toBe(result.expectedText);
  expect(result.rowsAfterReturn[0]).toBe(result.firstRow);
});

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

test("bottom-row wide spacer outside DECSTBM never reads beyond the grid", async ({ page }) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => !!window.qa);
  const result = await page.evaluate(() => {
    const engine = new window.qa.EngineTerminal(4, 3);
    engine.feed(new TextEncoder().encode("\x1b[1;2r\x1b[3;1Habc界"));
    const row = engine.rowText(2);
    const selected = engine.selectedText(2, 0, 2, 3);
    engine.feed(new TextEncoder().encode("\x1b[r\x1b[HOK"));
    engine.refreshSnapshot();
    const alive = engine.selectedText(0, 0, 0, 1);
    engine.free();
    return { row, selected, alive };
  });
  expect(result).toEqual({ row: "界 c", selected: "界c", alive: "OK" });
});
