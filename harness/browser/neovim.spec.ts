import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";

test("real Neovim PTY: negotiate sync, insert, edit, save, quit, usable shell", async ({
  page,
}, info) => {
  test.setTimeout(45000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  await page.evaluate(() => {
    window.qa.host.style.width = "900px";
    window.qa.host.style.height = "480px";
  });
  await expect.poll(() => page.evaluate(() => window.qa.state().grid.columns)).toBeGreaterThan(80);
  const grid = await page.evaluate(() => window.qa.state().grid);
  const directory = await mkdtemp(join(tmpdir(), "celeritty-neovim-"));
  const file = join(directory, "saved.txt");
  const bridge = spawn(
    "python3",
    ["harness/browser/pty_bridge.py", directory, String(grid.columns), String(grid.lines)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const output: Buffer[] = [];
  const input: Buffer[] = [];
  let stderr = "";
  let delivery = Promise.resolve();
  const closed = new Promise<void>((resolve) => bridge.once("close", () => resolve()));
  bridge.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  bridge.on("error", (error) => errors.push(error.message));
  const send = (command: object) => bridge.stdin.write(JSON.stringify(command) + "\n");
  await page.exposeBinding("ptyInput", (_source, bytes: number[]) => {
    const chunk = Buffer.from(bytes);
    input.push(chunk);
    send({ input: chunk.toString("base64") });
  });
  const reader = createInterface({ input: bridge.stdout });
  reader.on("line", (line) => {
    const chunk = Buffer.from(JSON.parse(line).output, "base64");
    output.push(chunk);
    delivery = delivery
      .then(async () => {
        await page.evaluate(
          (bytes) => window.qa.terminal.feed(Uint8Array.from(bytes)),
          Array.from(chunk),
        );
      })
      .catch((error) => {
        errors.push(
          String(error).replace(/data:application\/wasm;base64,[A-Za-z0-9+/=]+/g, "<wasm>"),
        );
      });
  });
  const screen = () => page.evaluate(() => window.qa.state().rows.join("\n"));
  try {
    await expect.poll(screen).toContain("QA_SHELL>");
    await page.locator("textarea").focus();
    await page.keyboard.type("nvim -u NONE -i NONE -n saved.txt");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("saved.txt");
    await expect.poll(() => Buffer.concat(output).includes(Buffer.from("\x1b[?2026h"))).toBe(true);
    await page.keyboard.press("i");
    await page.keyboard.insertText("CeleriTTY WASM Neovim verified");
    await page.keyboard.press("Escape");
    await page.keyboard.type(":w");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => readFile(file, "utf8").catch(() => ""))
      .toBe("CeleriTTY WASM Neovim verified\n");
    await page.keyboard.press("A");
    await page.keyboard.insertText(" - edited");
    await page.keyboard.press("Escape");
    await expect.poll(screen).toContain("CeleriTTY WASM Neovim verified - edited");
    await page.screenshot({ path: info.outputPath("neovim-edit.png") });
    await page.keyboard.type(":wq");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => readFile(file, "utf8"))
      .toBe("CeleriTTY WASM Neovim verified - edited\n");
    await expect.poll(screen).toContain("QA_SHELL>");
    await page.keyboard.type("printf 'SHELL_%s\\n' 'ALIVE'");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("SHELL_ALIVE");
    await page.screenshot({ path: info.outputPath("shell-after-neovim.png") });
    expect(Buffer.concat(input).includes(Buffer.from("\x1b[?2026;2$y"))).toBe(true);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
    await writeFile(
      info.outputPath("neovim-result.json"),
      JSON.stringify(
        {
          directory,
          file,
          saved: await readFile(file, "utf8"),
          synchronizedBegin: true,
          shellAlive: true,
          errors,
          stderr,
        },
        null,
        2,
      ),
    );
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
  } finally {
    if (bridge.exitCode === null && !bridge.stdin.destroyed) send({ close: true });
    await closed;
    reader.close();
    await delivery;
    await writeFile(info.outputPath("pty-output.bin"), Buffer.concat(output));
    await writeFile(info.outputPath("pty-input.bin"), Buffer.concat(input));
  }
});
