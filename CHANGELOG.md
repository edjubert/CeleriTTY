# Changelog

## 1.2.6 — 2026-10-23

### Fixed

- Selection drags that auto-scroll beyond the viewport keep their original
  anchor, so copying includes all selected text, including off-screen rows.
  This works in both scroll directions and while the pointer rests outside
  the terminal.

## 1.2.5 — 2026-10-19

### Fixed

- A click no longer leaves a one-cell highlight that looks like a second
  cursor. A drag covers a cell once the pointer crosses its middle, as in
  Alacritty, so a click without a drag selects nothing and a single character
  can be selected.
  ([#21](https://github.com/edjubert/CeleriTTY/pull/21) by @rle-mino)
- `clearScreen()` keeps the prompt visible. It clears the scrollback and the
  rows above the cursor's line, which becomes the first row, instead of
  erasing the whole screen behind the shell's back and leaving an empty
  terminal until the next prompt. It no longer touches the alternate screen.
  ([#20](https://github.com/edjubert/CeleriTTY/pull/20) by @rle-mino)

### Added

- Double click selects a word and triple click selects a line, soft wraps
  included. Dragging afterwards extends the selection by words or lines.
  Word boundaries follow Alacritty's defaults.
  ([#21](https://github.com/edjubert/CeleriTTY/pull/21) by @rle-mino)

### Changed

- `link-activate` fires 500 ms after an isolated click that selects nothing,
  instead of on release. The first click of a double or triple click on a
  URL, or a drag selecting one of its characters, no longer opens it.
  ([#21](https://github.com/edjubert/CeleriTTY/pull/21) by @rle-mino)

## 1.2.4 — 2026-10-13

### Fixed

- Recover glyph-atlas image import failures on software WebGPU adapters by
  uploading RGBA pixels. Font changes keep rendering, and unchanged atlases
  require no CPU readback.
- Local wheel scrolling uses pixel, line and page deltas instead of moving
  three lines per event. Fractional movement accumulates per terminal; zero
  and horizontal-only events no longer scroll vertically.
- Alternate-screen wheel arrows work when mouse reporting is disabled or uses
  an unsupported protocol (for example Vim with `ttymouse=xterm`).
  Supported SGR mouse reporting takes priority over alternate-scroll arrows;
  application events never also move local history.

### Added

- Optional `TerminalOptions.scrollSensitivity` (default `1`), also supported by
  `setOptions`. A finite non-negative multiplier for local wheel scrolling;
  `0` disables it and permits host-page scrolling outside application mouse
  and alternate-screen modes, without suppressing application input. See the README
  for delta conversion and fractional-state behavior.
  ([#17](https://github.com/edjubert/CeleriTTY/pull/17) by @rle-mino)

## 1.2.3 — 2026-10-12

### Fixed

- Mouse reporting now takes precedence over alternate scroll. The wheel was
  translated to arrow keys whenever alternate scroll (mode 1007) was on with
  the alternate screen active, before checking whether the program had enabled
  mouse reporting. Zellij enables both 1007 and SGR reporting, so its wheel
  events arrived as arrows in the pane's shell instead of button 64/65 reports,
  and pane scrollback never scrolled.
  ([#18](https://github.com/edjubert/CeleriTTY/pull/18) by @edjubert)
- The viewport now auto-scrolls during selection drags. Dragging a selection
  past the top or bottom edge no longer clamps the anchor to the edge and
  stops there; the viewport scrolls so the selection extends into scrollback,
  matching Alacritty. The drag scroll runs on a 50 ms timer as well as
  mousemove, since no mousemove fires while the pointer rests outside the
  surface.
  ([#18](https://github.com/edjubert/CeleriTTY/pull/18) by @edjubert)
- OSC 10/11/12 color queries are now answered. Programs like Vibe ask for the
  terminal's background (OSC 11) before rendering anything, and wait when the
  terminal stays silent. Color requests now queue on the pty output and the
  core answers them with the theme's named colors, passed in at startup via
  `setNamedColors`. OSC-set colors take precedence over the theme, and OSC 4
  palette queries stay silent rather than inventing colors the core does not
  own.
  ([#18](https://github.com/edjubert/CeleriTTY/pull/18) by @edjubert)
- The selection highlight now stays anchored on the same content during wheel
  scroll. `scrollLines` and `scrollToBottom` previously moved the viewport but
  left the selection anchors at their old viewport coordinates, so the
  highlight stayed frozen on screen while the text scrolled underneath. Anchors
  now shift with the content, and may leave the viewport entirely: off-screen
  rows are not painted, and `getSelection` still resolves the full text via
  grid coordinates.
  ([#18](https://github.com/edjubert/CeleriTTY/pull/18) by @edjubert)

## 1.2.2 — 2026-09-17

### Changed

- Widen the supported Node range from `>=22.18.0 <23.0.0` to `>=22.18.0 <25.0.0`.
  The previous upper bound rejected Node 23 and 24 outright. Widening rather
  than moving it keeps every Node 22 consumer working.
  ([#15](https://github.com/edjubert/CeleriTTY/pull/15) by @edjubert)

### Internal

- The release workflow publishes with `npm publish` on Node 24.21.0 LTS, whose
  bundled npm 11.19.0 performs the OIDC exchange that npm trusted publishing
  needs. `pnpm publish` never could, which is why every release up to 1.2.1 was
  published by hand. Both CI jobs move to the same Node, so a tag cannot publish
  an artifact built on a runtime the pull requests never exercised.
  ([#15](https://github.com/edjubert/CeleriTTY/pull/15) by @edjubert)
- Pin the wasm-pack version used by CI and the release job. The action resolves
  `latest` on every run and handed out 0.9.1, which predates workspace
  inheritance and cannot parse `license.workspace = true`. Two runs of the same
  commit disagreed on whether the build worked.
  ([#16](https://github.com/edjubert/CeleriTTY/pull/16) by @edjubert)

## 1.2.1 — 2026-09-17

### Fixed

- Synchronized output (`CSI ?2026h`) no longer panics on WASM. The parser uses a
  monotonic `performance.now()` deadline instead of `std::time::Instant`, which
  is unsupported on `wasm32-unknown-unknown`. A missing end marker can no longer
  freeze rendering: the 150 ms deadline is polled before incoming data and on
  animation frames while a batch is open.
  ([#13](https://github.com/edjubert/CeleriTTY/pull/13) by @rle-mino)
- Selections no longer panic on coordinates outside the grid. Pixel-to-cell
  conversion is clamped against the allocated grid for both drag endpoints,
  stale anchors are re-clamped after a resize, and the WASM `selectedText`
  boundary clamps and normalizes before converting viewport rows to scrollback
  coordinates.
  ([#12](https://github.com/edjubert/CeleriTTY/pull/12) by @rle-mino)
- Selecting a line ending in a wrapped wide character returned text from the
  wrong row, and panicked on the topmost row with no history. The vendored
  `alacritty_terminal` patch reads the wrapped glyph from the next row, and
  guards the read when a restricted scroll region (DECSTBM) leaves the spacer on
  the bottom row.
  ([#12](https://github.com/edjubert/CeleriTTY/pull/12) by @rle-mino)
- Link hit testing no longer activates an edge cell's link from a pointer
  outside the grid.
  ([#12](https://github.com/edjubert/CeleriTTY/pull/12) by @rle-mino)

### Changed

- The low-level WASM binding's `selectedText` normalizes reversed corners and
  returns the selected text instead of the empty string it returned in 1.2.0.
  That binding is not exported from the package entry points and
  `Terminal.getSelection()` already normalized corners itself, so the published
  API is unchanged.
  ([#12](https://github.com/edjubert/CeleriTTY/pull/12) by @rle-mino)

### Internal

- A `browser` CI job runs the bundled WASM and WebGPU regressions headlessly on
  every pull request and main push, using Chromium's software WebGPU adapter.
  An opt-in `pnpm test:neovim` PTY integration suite lives outside the default
  browser suite.
  ([#14](https://github.com/edjubert/CeleriTTY/pull/14),
  [#13](https://github.com/edjubert/CeleriTTY/pull/13) by @rle-mino)

## 1.2.0

See the [v1.2.0 release](https://github.com/edjubert/CeleriTTY/releases/tag/v1.2.0).
