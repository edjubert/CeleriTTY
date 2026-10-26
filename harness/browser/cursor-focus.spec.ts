import { expect, test } from "@playwright/test";

test("two real WASM/WebGPU terminals show a cursor only in the focused pane", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  const states = await page.evaluate(async () => {
    const { qa } = window;
    const host = document.createElement("div");
    host.style.width = "333px";
    host.style.height = "201px";
    document.body.appendChild(host);
    let inverse: number[] = [];
    let frames = 0;
    const peer = new qa.Terminal(host, qa.options, async (canvas, atlas) => {
      const renderer = await qa.createWebGpuRenderer(canvas, atlas);
      const render = renderer.render.bind(renderer);
      renderer.render = (grid) => {
        inverse = [];
        for (let index = 3; index < grid.packed.length; index += 4) {
          if (grid.packed[index] & 1) inverse.push((index - 3) / 4);
        }
        frames++;
        render(grid);
      };
      return renderer;
    });
    peer.on("error", (error) => qa.errors.push(error.message));
    const field = document.createElement("input");
    document.body.appendChild(field);
    const state = async () => {
      // Give the scheduled draw (and resize, for the first frame) a turn.
      for (let i = 0; i < 2; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return {
        a: qa.state().inverse,
        b: [...inverse],
        focused: qa.host.contains(document.activeElement)
          ? "a"
          : host.contains(document.activeElement)
            ? "b"
            : "outside",
      };
    };
    try {
      await peer.ready;
      const initial = await state();
      qa.terminal.focus();
      const a = await state();
      const beforeBlur = qa.state().frames;
      qa.terminal.blur();
      peer.focus();
      const b = await state();
      const refreshed = qa.state().frames > beforeBlur && frames > 1;
      field.focus();
      const outside = await state();
      host.focus();
      const domFocus = await state();
      peer.write("\x1b[?25l");
      const appHidden = await state();
      peer.blur();
      peer.focus();
      const refocusHidden = await state();
      peer.blur();
      peer.write("\x1b[?25h");
      const unfocusedShow = await state();
      host.querySelector("textarea")!.focus();
      const textareaFocus = await state();
      peer.blur();
      const blurred = await state();
      return {
        initial,
        a,
        b,
        outside,
        domFocus,
        appHidden,
        refocusHidden,
        unfocusedShow,
        textareaFocus,
        blurred,
        refreshed,
      };
    } finally {
      peer.dispose();
      host.remove();
      field.remove();
    }
  });
  const none = { a: [], b: [], focused: "outside" };
  const peerCursor = { a: [], b: [0], focused: "b" };
  expect(states).toEqual({
    initial: none,
    a: { a: ["0:0"], b: [], focused: "a" },
    b: peerCursor,
    outside: none,
    domFocus: peerCursor,
    appHidden: { a: [], b: [], focused: "b" },
    refocusHidden: { a: [], b: [], focused: "b" },
    unfocusedShow: none,
    textareaFocus: peerCursor,
    blurred: none,
    refreshed: true,
  });
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
  expect(errors).toEqual([]);
});

test("real pointer clicks focus the cursor and hide it on leaving the terminal", async ({
  page,
}) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "outside";
    document.body.appendChild(field);
  });
  await expect.poll(() => page.evaluate(() => window.qa.state().inverse)).toEqual([]);
  await page.locator("canvas").click();
  await expect.poll(() => page.evaluate(() => window.qa.state().inverse)).toEqual(["0:0"]);
  await page.locator("#outside").click();
  await expect(page.locator("#outside")).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.qa.state().inverse)).toEqual([]);
});
