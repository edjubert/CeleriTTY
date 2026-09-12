import { expect, test } from "@playwright/test";

test("sync: isolated 1.2.0 crash reproduction stays usable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/browser.html");
  await page.waitForFunction(() => !!window.qa);
  await page.evaluate(() => {
    const { qa } = window;
    qa.feed("BASELINE");
    qa.feed("\x1b[?2026h");
    qa.feed("SYNC_OK\x1b[?2026l");
    qa.feed("\r\nSTILL_ALIVE");
    qa.terminal.getSelection();
  });
  await expect
    .poll(() => page.evaluate(() => window.qa.state().rows.join("\n")))
    .toContain("STILL_ALIVE");
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
});

test("sync chunks, repetition, negotiation, timeout without new feed, replay policy", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  await page.evaluate(() => window.qa.feed("BEFORE\x1b[?2026$p"));
  await expect.poll(() => page.evaluate(() => window.qa.state().rows[0])).toBe("BEFORE");
  expect(
    await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.qa.replies.flat()))),
  ).toBe("\x1b[?2026;2$y");
  await page.evaluate(() => {
    window.qa.feed("\x1b[?2026hHIDDEN\x1b[?2026h");
  });
  expect(await page.evaluate(() => window.qa.state().rows[0])).toBe("BEFORE");
  await page.evaluate(() => {
    for (const byte of "\x1b[?2026l") window.qa.feed(byte);
  });
  await expect.poll(() => page.evaluate(() => window.qa.state().rows[0])).toBe("BEFOREHIDDEN");
  await page.evaluate(() => {
    window.qa.replies.length = 0;
    window.qa.feed("\x1b[?2026hTIMEOUT\x1b[6n");
  });
  expect(await page.evaluate(() => window.qa.state().rows[0])).toBe("BEFOREHIDDEN");
  // No feed follows: the animation loop must deliver the 150ms deadline itself.
  await expect
    .poll(() => page.evaluate(() => window.qa.state().rows[0]))
    .toBe("BEFOREHIDDENTIMEOUT");
  expect(
    await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.qa.replies.flat()))),
  ).toBe("\x1b[1;20R");
  await page.evaluate(() => {
    window.qa.replies.length = 0;
    window.qa.feed("\x1b[?2026hREPLAY\x1b[6n", false);
  });
  await expect.poll(() => page.evaluate(() => window.qa.state().rows[0])).toContain("REPLAY");
  expect(await page.evaluate(() => window.qa.replies)).toEqual([]);
  await page.evaluate(() => window.qa.feed("\x1b[?2026h\r\nRESUMED\x1b[?2026l\x1b[5n"));
  await expect
    .poll(() => page.evaluate(() => window.qa.state().rows.join("\n")))
    .toContain("RESUMED");
  expect(
    await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.qa.replies.flat()))),
  ).toBe("\x1b[0n");
  await page.screenshot({ path: info.outputPath("sync-resumed.png") });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
});

test("real WASM sync survives every byte boundary and renews its deadline", async ({ page }) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => !!window.qa);
  const result = await page.evaluate(async () => {
    const bytes = new TextEncoder().encode("\x1b[?2026hTEXT\x1b[6n\x1b[?2026l\x1b[?2026$p");
    const failures: number[] = [];
    for (let split = 0; split <= bytes.length; split++) {
      const engine = new window.qa.EngineTerminal(40, 3);
      try {
        engine.feed(bytes.slice(0, split));
        engine.feed(bytes.slice(split));
        if (
          engine.rowText(0) !== "TEXT" ||
          new TextDecoder().decode(engine.takeOutput()) !== "\x1b[1;5R\x1b[?2026;2$y"
        )
          failures.push(split);
      } finally {
        engine.free();
      }
    }
    const engine = new window.qa.EngineTerminal(40, 3);
    try {
      const feed = (text: string) => engine.feed(new TextEncoder().encode(text));
      feed("\x1b[?2026hA");
      await new Promise((resolve) => setTimeout(resolve, 90));
      feed("\x1b[?2026hB");
      await new Promise((resolve) => setTimeout(resolve, 90));
      const earlyFlush = engine.flushSync(false);
      const before = engine.rowText(0);
      await new Promise((resolve) => setTimeout(resolve, 90));
      const expiredFlush = engine.flushSync(false);
      const after = engine.rowText(0);
      feed("\x1b[?2026hC\x1b[?2026l\x1b[?2026hD");
      const betweenBatches = engine.rowText(0);
      feed("\x1b[?2026l");
      return {
        failures,
        earlyFlush,
        before,
        expiredFlush,
        after,
        betweenBatches,
        final: engine.rowText(0),
      };
    } finally {
      engine.free();
    }
  });
  expect(result).toEqual({
    failures: [],
    earlyFlush: false,
    before: "",
    expiredFlush: true,
    after: "AB",
    betweenBatches: "ABC",
    final: "ABCD",
  });
});
