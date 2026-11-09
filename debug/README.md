# Contributor debugger

Run the current checkout in a browser, with a real local PTY:

```bash
pnpm install
pnpm debug
```

Open **http://127.0.0.1:8124** in a WebGPU-capable browser, such as current
Chrome or Edge. The command builds the WASM engine and starts Vite and the PTY
bridge together. TypeScript and CSS edits reload through Vite; after Rust edits,
run `pnpm build:wasm` and reload the page.

Requires the root toolchain (Rust, `wasm-pack`, Node, pnpm) and a POSIX shell on
macOS or Linux. Fish and Neovim are optional and must be installed to test them.
The debugger uses the repository source, not a published version of CeleriTTY.

## Cursor playground

The page starts without launching a shell.

1. Choose **Default cursor**, **Blink**, and **Cursor color**. Changes apply
   immediately.
2. Click **Block**, **Beam**, or **Underline** in the ANSI playground. These
   send DECSCUSR sequences, like a real application.
3. Change the default again: the application override remains active.
4. Click **Restore default** to send DECSCUSR 0, or **Hide / show** to exercise
   DECTCEM.

**Rendered cursor** reports the marker actually passed to WebGPU, independently
of the default selector. **Phase** shows blink visibility. Font and theme
changes keep the same terminal and shell session.

## Real shell

Choose an installed shell and click **Start shell**. The default is to skip its
startup configuration so a custom prompt or plugin cannot affect the test.
Uncheck **Skip shell configuration** to reproduce your regular login shell.
The working directory is the checkout root.

**Restart shell** terminates the current PTY and starts a new one. **Stop shell**
terminates it and returns to the playground. Closing the page or stopping Vite
also cleans up its PTY. A shell overrides the configured cursor whenever it
sends its own cursor sequences.

### Fish Vi modes

Select Fish, start it, then run:

```fish
set -g fish_vi_force_cursor 1
fish_vi_key_bindings
set -g fish_cursor_default block
set -g fish_cursor_insert line
set -g fish_cursor_visual underscore
```

Type a few characters; use Escape for normal mode, `i` for insertion and `v`
for visual mode. Add `blink` to a variable value to enable blinking.
The force flag enables cursor updates in older Fish versions that do not
recognize a custom terminal. Set it before enabling the Vi bindings.

### Neovim modes

From a shell:

```bash
nvim -u NONE -i NONE -n
```

In Neovim:

```vim
:set guicursor=n-c:block-blinkon0,i:ver25-blinkon0,v:hor20-blinkon0
```

Switch with Escape, `i`, and `v`. This explicitly gives visual mode an
underline; Neovim's default normal and visual modes share a block.

## Diagnostics and configuration

- **Load Alacritty TOML** applies a file you choose, through the same
  `resolveAlacrittyToml` API an embedding app uses.
- **Trace PTY bytes** shows escaped RX/TX bytes, including cursor sequences.
  It is opt-in; the log retains 60 entries and truncates each byte chunk to
  256 bytes.
- **Download report** exports the options, rendered cursor, grid, browser,
  traffic counters, and current log as JSON. Review it before sharing: an
  enabled PTY trace can include shell input and output.
- Renderer failures and WebGPU diagnostics appear in the log.

## Implementation

The embedding follows CadencR's lifecycle: `Terminal` owns the renderer,
appearance changes use `setOptions`, and a separate transport owns the PTY
connection. This version uses plain TypeScript and the reference
`WebSocketTransport` / [binary protocol](../PROTOCOL.md). It has no session
persistence or framework dependency.

Vite's plugin serves `/__debug/config` and upgrades `/__debug/pty`; everything
uses one origin and one loopback-only port. The PTY endpoint requires the
page's origin and accepts only discovered shells. Keep this development server
local; it provides access to your shell.

```bash
pnpm test:debug
```

The Playwright regressions exercise the controls, application overrides,
report export, configuration import, and real shell input, exit and restart
on a separate port (`8125`). Fish and Neovim mode checks run when those
programs are installed.
