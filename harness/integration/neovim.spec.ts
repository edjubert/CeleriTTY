import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";

test("real Neovim PTY: wheel routing, negotiate sync, insert, edit, save, quit, usable shell", async ({
  page,
}, info) => {
  test.setTimeout(45000);
  // Fail explicitly rather than silently skipping the optional integration.
  expect(process.platform, "Neovim PTY integration requires POSIX").not.toBe("win32");
  expect(
    spawnSync("python3", ["-c", "import sys; assert sys.version_info >= (3, 8)"]).status,
    "Install Python >=3.8 on PATH",
  ).toBe(0);
  const nvim = spawnSync("nvim", ["--version"], { encoding: "utf8" });
  expect(nvim.status, "Install Neovim >=0.11 on PATH").toBe(0);
  const version = /NVIM v(\d+)\.(\d+)/.exec(nvim.stdout);
  expect(
    version !== null && (Number(version[1]) > 0 || Number(version[2]) >= 11),
    "Synchronized-output integration requires Neovim >=0.11",
  ).toBe(true);
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
  await writeFile(
    join(directory, "wheel.txt"),
    Array.from({ length: 200 }, (_, i) => `WHEEL_${String(i).padStart(3, "0")}`).join("\n") + "\n",
  );
  const bridge = spawn(
    "python3",
    ["harness/integration/pty_bridge.py", directory, String(grid.columns), String(grid.lines)],
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
    await page.keyboard.type("nvim -u NONE -i NONE -n wheel.txt");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("wheel.txt");
    await page.evaluate(() => window.qa.terminal.setOptions({ scrollSensitivity: 0 }));
    await page.keyboard.type(":lua vim.o.mouse='a'; vim.cmd('normal! gg'); print('MOUSE_READY')");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("MOUSE_READY");
    const topLine = () =>
      page.evaluate(() => {
        const row = window.qa.state().rows.find((row) => /^WHEEL_\d+/.test(row));
        return row === undefined ? -1 : Number(row.slice(6));
      });
    await expect.poll(topLine).toBe(0);
    const box = await page.locator("canvas").boundingBox();
    await page.mouse.move(box!.x + 100, box!.y + 100);
    const mouseInputStart = input.length;
    await page.mouse.wheel(0, 100);
    await expect.poll(topLine).toBeGreaterThan(0);
    const mouseTop = await topLine();
    expect(Buffer.concat(input.slice(mouseInputStart)).toString()).toContain("\x1b[<65;");
    await page.mouse.wheel(0, -100);
    await expect.poll(topLine).toBeLessThan(mouseTop);
    await page.keyboard.type(":lua vim.o.mouse=''; vim.cmd('normal! gg'); print('ARROWS_READY')");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("ARROWS_READY");
    await expect.poll(topLine).toBe(0);
    const arrowsInputStart = input.length;
    // One application arrow per wheel event, independent of local sensitivity.
    for (let i = 0; i < grid.lines + 5; i++) await page.mouse.wheel(0, 20);
    await expect.poll(topLine).toBeGreaterThan(0);
    const arrowTop = await topLine();
    const arrows = Buffer.concat(input.slice(arrowsInputStart)).toString();
    expect(arrows).toContain("\x1bOB");
    expect(arrows).not.toContain("\x1b[<65;");
    await page.screenshot({ path: info.outputPath("neovim-wheel.png") });
    await writeFile(
      info.outputPath("neovim-wheel.json"),
      JSON.stringify({ mouseTop, arrowTop, localSensitivity: 0 }, null, 2),
    );
    await info.attach("neovim-wheel.json", {
      body: JSON.stringify({ mouseTop, arrowTop, localSensitivity: 0 }),
      contentType: "application/json",
    });
    await page.keyboard.type(":q");
    await page.keyboard.press("Enter");
    await expect.poll(screen).toContain("QA_SHELL>");
    await page.evaluate(() => window.qa.terminal.setOptions({ scrollSensitivity: 1 }));
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
