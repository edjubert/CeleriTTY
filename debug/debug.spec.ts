import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test("playground defaults, ANSI overrides, live font, theme and diagnostic report", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Playground ready");
  await page.getByLabel("Default cursor").selectOption("beam");
  await expect(page.locator("#effective-cursor")).toHaveText("beam");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.locator("#effective-cursor")).toHaveText("block");
  await page.getByLabel("Default cursor").selectOption("underline");
  await expect(page.locator("#effective-cursor")).toHaveText("block");
  await page.getByRole("button", { name: "Restore default" }).click();
  await expect(page.locator("#effective-cursor")).toHaveText("underline");
  await page.getByRole("button", { name: "Hide / show" }).click();
  await expect(page.locator("#effective-cursor")).toHaveText("hidden / off-screen");
  await page.getByRole("button", { name: "Hide / show" }).click();
  await expect(page.locator("#effective-cursor")).toHaveText("underline");
  await page.getByLabel("Blink", { exact: true }).check();
  await expect(page.locator("#cursor-phase")).toHaveText("blink off");
  const previousGrid = await page.locator("#grid").textContent();
  await page.getByLabel("Font size").fill("20");
  await page.getByLabel("Font size").press("Tab");
  await expect(page.locator("#grid")).not.toHaveText(previousGrid!);
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await expect(page.locator("#terminal")).toHaveCSS("background-color", "rgb(245, 247, 250)");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report" }).click();
  const path = await (await download).path();
  const report = JSON.parse(await readFile(path!, "utf8"));
  expect(report.options.cursor).toEqual({ style: "underline", blink: true });
  expect(report.frames).toBeGreaterThan(0);
  expect(report.log.join("\n")).not.toContain("ERROR");
  await page.getByLabel("Load Alacritty TOML").setInputFiles({
    name: "cursor.toml",
    mimeType: "text/plain",
    buffer: Buffer.from('[cursor.style]\nshape = "Beam"\nblinking = "Off"\n[font]\nsize = 17\n'),
  });
  await expect(page.getByLabel("Default cursor")).toHaveValue("beam");
  await expect(page.locator("#effective-cursor")).toHaveText("beam");
  await expect(page.getByLabel("Font size")).toHaveValue("17");
  expect(errors).toEqual([]);
});

test("real PTY changes cursor, routes keyboard input, exits, and can be restarted", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Playground ready");
  await page.getByLabel("Shell", { exact: true }).selectOption("sh");
  await page.getByRole("button", { name: "Start shell", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Shell connected");
  await expect(page.getByRole("button", { name: "Beam", exact: true })).toBeDisabled();
  await page.locator("#terminal textarea").focus();
  await page.keyboard.type("printf '\\033[6 q'");
  await page.keyboard.press("Enter");
  await expect(page.locator("#effective-cursor")).toHaveText("beam");
  await page.keyboard.type("printf '\\033[4 q'");
  await page.keyboard.press("Enter");
  await expect(page.locator("#effective-cursor")).toHaveText("underline");
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(page.locator("#status")).toHaveText("Shell exited (0)");
  await page.getByRole("button", { name: "Start shell", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Shell connected");
  await page.getByRole("button", { name: "Stop shell", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Playground ready");
  await expect(page.getByRole("button", { name: "Beam", exact: true })).toBeEnabled();
});

test("Fish Vi modes send block, beam and underline through the live session", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Playground ready");
  test.skip((await page.locator('#shell option[value="fish"]').count()) === 0, "Fish is optional");
  await page.getByLabel("Shell", { exact: true }).selectOption("fish");
  await page.getByRole("button", { name: "Start shell", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Shell connected");
  await page.locator("#terminal textarea").focus();
  await page.keyboard.type(
    "set -g fish_vi_force_cursor 1; fish_vi_key_bindings; set -g fish_cursor_default block; set -g fish_cursor_insert line; set -g fish_cursor_visual underscore",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator("#effective-cursor")).toHaveText("beam");
  await page.keyboard.type("demo");
  await page.keyboard.press("Escape");
  await expect(page.locator("#effective-cursor")).toHaveText("block");
  await page.keyboard.press("v");
  await expect(page.locator("#effective-cursor")).toHaveText("underline");
  await page.getByRole("button", { name: "Stop shell", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Playground ready");
});

test("Neovim modes change the rendered cursor in the embedded terminal", async ({ page }) => {
  test.skip(spawnSync("nvim", ["--version"]).status !== 0, "Neovim is optional");
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Playground ready");
  await page.getByLabel("Default cursor").selectOption("underline");
  await page.getByLabel("Shell", { exact: true }).selectOption("sh");
  await page.getByRole("button", { name: "Start shell", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Shell connected");
  await page.locator("#terminal textarea").focus();
  await page.keyboard.type(
    "nvim -u NONE -i NONE -n --cmd 'set guicursor=n-c:block-blinkon0,i:ver25-blinkon0,v:hor20-blinkon0'",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator("#effective-cursor")).toHaveText("block");
  await page.keyboard.press("i");
  await expect(page.locator("#effective-cursor")).toHaveText("beam");
  await page.keyboard.type("CeleriTTY debug");
  await page.keyboard.press("Escape");
  await expect(page.locator("#effective-cursor")).toHaveText("block");
  await page.keyboard.press("v");
  await expect(page.locator("#effective-cursor")).toHaveText("underline");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":q!");
  await page.keyboard.press("Enter");
  await expect(page.locator("#effective-cursor")).toHaveText("underline");
  await page.getByRole("button", { name: "Stop shell", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Playground ready");
});
