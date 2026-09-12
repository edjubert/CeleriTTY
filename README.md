<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="CeleriTTY" width="420">
  </picture>
</p>

# celeritty

Terminal emulator for the web. ANSI parsing runs in Rust compiled to
WebAssembly (a vendored `alacritty_terminal`); the grid is drawn with WebGPU.

Ships as a class and as a custom element. It has no network code: you supply a
transport.

## Requirements

- The bundled renderer needs WebGPU. There is no bundled Canvas 2D or DOM
  renderer; hosts can provide their own compatibility terminal as described
  below.
- A backend that speaks [`PROTOCOL.md`](PROTOCOL.md), or your own transport.

## Install

```bash
pnpm add celeritty
```

## Example

A complete, runnable client and server are in
[`examples/local-shell/`](examples/local-shell). The two halves:

```js
// main.js
import "celeritty/element";
import { WebSocketTransport } from "celeritty/transport/websocket";

const term = document.getElementById("term");

term.options = {
  font: { family: "monospace", size: 13 },
  colors: {
    black: "#000000", red: "#cd0000", green: "#00cd00", yellow: "#cdcd00",
    blue: "#0000ee", magenta: "#cd00cd", cyan: "#00cdcd", white: "#e5e5e5",
    brightBlack: "#7f7f7f", brightRed: "#ff0000", brightGreen: "#00ff00",
    brightYellow: "#ffff00", brightBlue: "#5c5cff", brightMagenta: "#ff00ff",
    brightCyan: "#00ffff", brightWhite: "#ffffff",
    foreground: "#e5e5e5", background: "#000000", cursor: "#e5e5e5",
  },
  cursor: { style: "block", blink: false },
  scrollback: 10000,
};

term.transport = new WebSocketTransport("ws://localhost:8080");

term.addEventListener("link-activate", (event) => {
  window.open(event.detail.url, "_blank", "noopener");
});
```

```js
// server.mjs
import pty from "node-pty";
import { WebSocketServer } from "ws";

new WebSocketServer({ port: 8080 }).on("connection", (socket) => {
  // encoding: null gives Buffers. Decoding as UTF-8 corrupts binary output
  // and multi-byte characters split across a read boundary.
  const term = pty.spawn(process.env.SHELL ?? "/bin/bash", [], {
    name: "xterm-256color", cols: 80, rows: 24, env: process.env, encoding: null,
  });

  socket.send(JSON.stringify({ type: "ready", columns: 80, rows: 24 }));
  term.onData((chunk) => socket.send(chunk, { binary: true }));
  term.onExit(({ exitCode }) => {
    socket.send(JSON.stringify({ type: "exit", code: exitCode }));
    socket.close();
  });

  socket.on("message", (payload, isBinary) => {
    if (isBinary) return term.write(payload);
    const message = JSON.parse(payload.toString("utf8"));
    if (message.type === "resize") term.resize(message.columns, message.rows);
  });

  socket.on("close", () => term.kill());
});
```

## Element

```html
<celeri-tty font-family="JetBrains Mono" font-size="13"></celeri-tty>
```

| Attribute | Default |
|---|---|
| `font-family` | `monospace` |
| `font-size` | `13` |
| `scrollback` | `10000` |

| Property | Type |
|---|---|
| `options` | `Partial<TerminalOptions>`, wins over attributes, applies live |
| `transport` | `TerminalTransport \| undefined`; assigning attaches, `undefined` detaches |
| `terminal` | the underlying `Terminal`, or `undefined` before it is connected |

| Event | `detail` |
|---|---|
| `data` | `Uint8Array` headed to the process |
| `resize` | `{ columns, lines }` |
| `selection-change` | `string \| null` |
| `link-activate` | `{ url, modifiers: { ctrl, alt, shift, meta } }` |
| `link-hover` | `string \| null` — the URL under the pointer, or `null` on leave |
| `error` | `Error` |
| `diagnostic` | `Error` — non-fatal GPU call failure; no automatic teardown |

Attributes cover font and scrollback only. A page that never assigns
`options` gets no colours.

Importing `celeritty/element` registers the tag. Importing the package
root does not.

## Class

```ts
import { Terminal } from "celeritty";

const term = new Terminal(document.getElementById("host"), options);
await term.ready;

term.attach(myTransport);
```

### WebGPU failure and fallback

Uncaptured GPU errors are non-fatal diagnostics: `Renderer.onDiagnostic` forwards
these to the terminal's `diagnostic` event without latching a fatal failure.
`Renderer.onError` is reserved for device loss, so an earlier diagnostic cannot
hide a later lost device. Both renderer subscription hooks are optional.

`Terminal.ready` rejects when WebAssembly or WebGPU initialization fails. This
includes a missing `navigator.gpu`, no adapter, device creation failure, and
canvas or pipeline setup failure. After initialization, asynchronous device
loss is reported through the terminal's `error`
event and makes that terminal instance unusable.

Register the runtime listener before awaiting `ready`, and use one guarded path
for both kinds of failure:

```ts
const term = new Terminal(host, options);
let usingFallback = false;

function useFallback(error: unknown) {
  if (usingFallback) return;
  usingFallback = true;
  term.dispose();
  mountCompatibilityTerminal(host, error);
}

term.on("error", useFallback);
// Diagnostics do not lose the device or discard the terminal's history.
term.on("diagnostic", (error) => console.warn(error));

try {
  await term.ready;
  term.attach(transport);
} catch (error) {
  useFallback(error);
}
```

The host owns fallback selection and loading, so a heavyweight compatibility
renderer does not enter bundles that only support WebGPU. Keep the PTY/session
outside either renderer. A fallback mounted after output has already arrived
must obtain a snapshot or replay from that session; CeleriTTY does not transfer
its private WASM grid into another terminal implementation.

### Text input and focus

CeleriTTY owns one native textarea per terminal. Physical keys still use the
terminal encoder, while the textarea supplies IME composition, dead keys,
Unicode input, mobile keyboards, and paste without duplicate commits. Paste
normalizes line endings and follows the application's bracketed-paste mode.
In bracketed-paste mode, literal ESC (`\x1b`) and C1 CSI (`\x9b`) control
characters are removed from the content to prevent premature termination;
scripts or logs containing those characters therefore lose those bytes.
Non-bracketed paste preserves them.

Call `term.focus()` to focus that native surface with `preventScroll`. The host
remains the only tab stop, and mounting or revealing another terminal never
moves focus on its own. Do not add a second hidden input around CeleriTTY.

`Meta`-modified keys remain available to the embedding application's shortcut
system. Product-specific mappings such as Cmd+Arrow to readline commands still
belong in the host; composition keystrokes never escape to those handlers.

### Embedding and resizing

Give the host a definite, non-zero content-box size. CeleriTTY sizes its canvas
and PTY grid from that content box, so padding and borders can safely live on
the host itself without stretching the canvas or overstating rows and columns.
Positioned and resizable containers are supported.

When a host becomes zero-sized (for example, a `display: none` tab), CeleriTTY
keeps its last grid instead of resizing a full-screen application to `1x1`.
`ResizeObserver` remeasures it when it becomes visible. The same `Terminal`
instance should stay mounted across split-pane and tab changes when its screen
and scrollback state must survive.

The WebGPU canvas uses premultiplied alpha, but current palette parsing accepts
only opaque `#rrggbb` values and every rendered cell background is opaque. The
sub-cell remainder at the right and bottom edges stays transparent. Put a host
background behind the canvas for those edges; translucent terminal themes are
not currently supported.

| Method | |
|---|---|
| `attach(transport)` / `detach()` | connect and disconnect |
| `feed(bytes, options?)` | live process output in; parser replies go to `data` / the attached transport. Set `{ replyToQueries: false }` for replayed history |
| `write(text)` | inject text locally; parser replies are discarded, so it does not reach the process |
| `setOptions(patch)` | applies live; a colour change does not rebuild the glyph atlas |
| `focus()` / `blur()` / `clearScreen()` | |
| `getSelection()` / `copySelection()` | |
| `scrollLines(delta)` / `scrollToBottom()` | |
| `on(event, cb)` | returns an unsubscribe function |
| `dispose()` | |

## Transport

```ts
interface TerminalTransport {
  write(bytes: Uint8Array): void;
  resize(columns: number, rows: number): void;
  onData(cb: (bytes: Uint8Array, options?: { replyToQueries?: boolean }) => void): () => void;
  onClose(cb: (reason?: string) => void): () => void;
}
```

`WebSocketTransport` implements it against [`PROTOCOL.md`](PROTOCOL.md). Hosts
with their own protocol — session reattachment, exit codes, scrollback replay
— implement the interface directly and do not import it.

`attach()` replaces the current transport without replacing the terminal
engine. The grid, scrollback, alternate-screen state, selection, and live
options therefore survive `detach()` / `attach()` reconnects. A transport may
synchronously replay buffered output from `onData()` or report closure from
`onClose()` while it is being attached; CeleriTTY installs and tears down the
whole attachment atomically. Gap recovery and server-side session replay remain
the transport's responsibility.

## Configuration

`options` is fully resolved. The component applies it and resolves nothing:
which source won, and which overrides applied, is the host's decision.

To resolve an `alacritty.toml`:

```ts
import { loadEngine, resolveAlacrittyToml } from "celeritty";

await loadEngine();
const options = resolveAlacrittyToml(tomlText, fallbackPalette);
```

`fallbackPalette` supplies every colour the file does not set. Alacritty
documents its scalar defaults, so those are built in; it documents no default
palette.

The same resolver is the Rust crate `alacritty-config`, for backends reading
the file from disk — the one part of this a browser cannot do.

## Limits

- The package includes only a WebGPU renderer; fallback selection belongs to
  the host and follows the contract above.
- No accessibility tree. The grid is a canvas; a screen reader sees nothing.
- No addon API.
- One font face. The atlas rasterizes `font.normal`; bold and italic render in
  the same face.
- Palette values are opaque `#rrggbb`; translucent cell backgrounds are not
  supported.
- Wide and combining glyph layout still needs dedicated renderer coverage; the
  atlas clips every rasterized glyph to one cell.
- `cursor.style` and `cursor.blink` are carried in the options but not drawn.
- No `bell` or `title` events; the engine does not surface them.

## Development

```bash
pnpm install
pnpm build      # wasm module, bundled ES output, type declarations
pnpm test       # cargo test --workspace, then vitest
pnpm harness    # http://localhost:8123
pnpm exec playwright install chromium
pnpm test:browser # rebuild, then real bundled WASM/WebGPU regressions
```

Requires Rust 1.85 with the `wasm32-unknown-unknown` target, `wasm-pack`, and
Node 22.18.

Browser regressions require a WebGPU-capable Chromium and exercise the built
`dist/index.js` with the real WASM and renderer, without a Cadencr server.
Run `pnpm test:browser --headed` for visually inspectable GPU captures (some
headless GPU backends capture blank canvases). Results and screenshots are
kept in `test-results/`.

| Path | Contents |
|---|---|
| `crates/terminal-core/` | wasm engine: ANSI grid, key and mouse encoding, snapshot packing |
| `crates/alacritty-config/` | `alacritty.toml` to `TerminalOptions`, no wasm dependency |
| `src/core/` | the `Terminal` class |
| `src/renderer/` | WebGPU renderer |
| `src/element/`, `src/transport/` | the element and the reference transport |
| `fixtures/` | configuration fixtures asserted from both Rust and TypeScript |

## License

Apache-2.0 — see [`LICENSE`](LICENSE).

`assets/` is the exception. The brand artwork is CC BY 4.0, not Apache-2.0,
so the mascot can be reused *and reworked* — see
[`assets/LICENSE`](assets/LICENSE). Neither licence grants any right in the
celeritty name: use it to refer to this project, not to brand yours.

`crates/terminal-core/vendor/alacritty_terminal/` is a patched copy of
[`alacritty_terminal`](https://github.com/alacritty/alacritty), Copyright The
Alacritty Project, also Apache-2.0. It keeps its own licence file alongside
the vendored source.

### Live output versus replay

`feed(bytes)` answers terminal protocol queries by default. Replayed history
must not generate new input for the live shell. A host feeding history directly
must use `terminal.feed(history, { replyToQueries: false })`. A custom transport
must pass the same option as the second argument to its `onData` callback for
every replay chunk; omit it again for live output. The terminal cannot infer
whether a byte stream is live or historical. Suppressed replies are drained and
discarded immediately, never deferred until the next live chunk. `write(text)`
is always local-only and uses this suppression internally.

The host must place the replay-to-live boundary between escape sequences, not
inside one. Reply suppression applies to the chunk that completes a query:
if replay ends with `\x1b[6` and live output starts with `n`, the completed
cursor-position query is answered and a reply for historical content reaches
the live shell. Byte-capped replay buffers must therefore end at a sequence
boundary; suppressing the first live chunk instead could discard legitimate
live queries.
