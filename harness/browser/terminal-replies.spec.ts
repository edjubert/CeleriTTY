import { expect, test } from "@playwright/test";

test("OSC then CPR stays ordered through real WASM at every byte boundary", async ({ page }) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => !!window.qa);
  const result = await page.evaluate(() => {
    const input = new TextEncoder().encode("\x1b]11;?\x1b\\\x1b[6n");
    const replies: string[] = [];
    for (let split = 0; split <= input.length; split++) {
      const engine = new window.qa.EngineTerminal(40, 3);
      try {
        engine.setNamedColors("#eeeeee", "#08090b", "#eeeeee");
        engine.feed(input.slice(0, split));
        const first = new TextDecoder().decode(engine.takeOutput());
        engine.feed(input.slice(split));
        replies.push(first + new TextDecoder().decode(engine.takeOutput()));
      } finally {
        engine.free();
      }
    }
    // Also exercise the built package's public facade and reply delivery.
    window.qa.terminal.feed(input);
    return { replies, facade: window.qa.replies.flat() };
  });
  const expected = "\x1b]11;rgb:0808/0909/0b0b\x1b\\\x1b[1;1R";
  expect(result.replies).toEqual(Array(13).fill(expected));
  expect(new TextDecoder().decode(new Uint8Array(result.facade))).toBe(
    "\x1b]11;rgb:1a1a/1b1b/2626\x1b\\\x1b[1;1R",
  );
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
});

test("timeout answers mixed queries in order and discards replay colors without a later feed", async ({
  page,
}) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  await page.evaluate(() => {
    window.qa.feed("\x1b[?2026hLIVE\x1b]11;?\x1b\\\x1b[6n");
  });
  const output = () =>
    page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.qa.replies.flat())));
  await expect.poll(output).toBe("\x1b]11;rgb:1a1a/1b1b/2626\x1b\\\x1b[1;5R");
  await page.evaluate(() => {
    window.qa.replies.length = 0;
    window.qa.feed("\x1b[?2026hREPLAY\x1b]11;?\x1b\\\x1b[6n", false);
  });
  await expect.poll(() => page.evaluate(() => window.qa.state().rows[0])).toBe("LIVEREPLAY");
  expect(await output()).toBe("");
  await page.evaluate(() => window.qa.feed("\x1b]11;?\x1b\\\x1b[6n"));
  expect(await output()).toBe("\x1b]11;rgb:1a1a/1b1b/2626\x1b\\\x1b[1;11R");
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
});
