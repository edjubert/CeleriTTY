import { expect, test } from "@playwright/test";

const visibleRows = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.qa.state().rows.filter(Boolean));

test("clearScreen keeps the prompt line and drops the history", async ({ page }) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  await page.evaluate(() => {
    window.qa.feed(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n$ ls");
    window.qa.terminal.clearScreen();
    window.qa.feed(" -la");
    window.qa.terminal.scrollLines(10);
  });
  await expect.poll(() => visibleRows(page)).toEqual(["$ ls -la"]);
});

test("clearScreen applies a pending synchronized update first", async ({ page }) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  await page.evaluate(() => {
    window.qa.feed("\x1b[2J\x1b[Hbefore\r\n$ old");
    window.qa.feed("\x1b[?2026h\r\nresult\r\n$ new");
    window.qa.terminal.clearScreen();
    window.qa.feed("\x1b[?2026l");
  });
  await expect.poll(() => visibleRows(page)).toEqual(["$ new"]);
});
