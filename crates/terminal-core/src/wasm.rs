//! JavaScript-facing façade. Type conversion only — every rule lives in
//! `terminal`, `input`, and `snapshot`, where it is tested natively.

use wasm_bindgen::prelude::*;

use vte::ansi::Rgb;

use crate::input::{
    encode_key, encode_mouse, KeyInput, MouseButton, MouseEventKind, MouseInput, MouseReporting,
};
use crate::terminal::{TerminalCore, TerminalSize};

/// Assemble a `KeyInput` from the flat arguments `wasm_bindgen` can pass.
/// Extracted so the conversion is testable without a JS runtime.
fn build_key_input(
    key: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    application_cursor: bool,
) -> KeyInput {
    KeyInput {
        key,
        ctrl,
        alt,
        shift,
        meta,
        application_cursor,
    }
}

/// A terminal grid driven from JavaScript.
#[wasm_bindgen]
pub struct Terminal {
    core: TerminalCore,
}

#[wasm_bindgen]
impl Terminal {
    #[wasm_bindgen(constructor)]
    pub fn new(columns: usize, screen_lines: usize) -> Terminal {
        Terminal {
            core: TerminalCore::new(TerminalSize {
                columns,
                screen_lines,
            }),
        }
    }

    /// Store the theme's named colors, used to answer OSC 10/11/12 queries.
    /// Programs like Vibe or Neovim detect the terminal's background this way
    /// before rendering; a terminal that stays silent leaves them guessing.
    ///
    /// Colors are `#rrggbb` strings, the palette format the host already uses.
    /// Throws when a color is malformed — the host's palette is configuration,
    /// and a silent default would hide the bug.
    #[wasm_bindgen(js_name = setNamedColors)]
    pub fn set_named_colors(
        &mut self,
        foreground: &str,
        background: &str,
        cursor: &str,
    ) -> Result<(), JsError> {
        self.core.set_named_colors(
            parse_hex_rgb(foreground, "foreground")?,
            parse_hex_rgb(background, "background")?,
            parse_hex_rgb(cursor, "cursor")?,
        );
        Ok(())
    }

    /// Feed a chunk of PTY output. Safe to call with a sequence split across
    /// chunks — the parser keeps its state.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.core.feed(bytes);
    }

    /// Internal facade plumbing: only pending batches need animation polling.
    #[wasm_bindgen(getter, js_name = syncPending)]
    pub fn sync_pending(&self) -> bool {
        self.core.sync_pending()
    }

    /// Internal facade plumbing: poll a deadline or finish at a replay boundary.
    /// Returns whether buffered output was applied; drain takeOutput afterwards.
    #[wasm_bindgen(js_name = flushSync)]
    pub fn flush_sync(&mut self, force: bool) -> bool {
        self.core.flush_sync(force)
    }

    /// Drain protocol replies (for example cursor-position reports) to the PTY.
    #[wasm_bindgen(js_name = takeOutput)]
    pub fn take_output(&mut self) -> Vec<u8> {
        self.core.take_output()
    }

    pub fn resize(&mut self, columns: usize, screen_lines: usize) {
        self.core.resize(TerminalSize {
            columns,
            screen_lines,
        });
    }

    #[wasm_bindgen(getter)]
    pub fn columns(&self) -> usize {
        self.core.columns()
    }

    #[wasm_bindgen(getter, js_name = screenLines)]
    pub fn screen_lines(&self) -> usize {
        self.core.screen_lines()
    }

    #[wasm_bindgen(getter, js_name = cursorLine)]
    pub fn cursor_line(&self) -> usize {
        self.core.cursor_line()
    }

    #[wasm_bindgen(getter, js_name = cursorColumn)]
    pub fn cursor_column(&self) -> usize {
        self.core.cursor_column()
    }

    /// Whether DECCKM is on. Feed this back into `encodeKey` so the arrow keys
    /// emit what the running application expects.
    #[wasm_bindgen(getter, js_name = applicationCursor)]
    pub fn application_cursor(&self) -> bool {
        self.core.application_cursor()
    }

    /// Mouse reporting mode as a small integer: 0 none, 1 click, 2 drag,
    /// 3 motion. Feed it straight back into `encodeMouse`.
    #[wasm_bindgen(getter, js_name = mouseReporting)]
    pub fn mouse_reporting(&self) -> u8 {
        match self.core.mouse_reporting() {
            MouseReporting::None => 0,
            MouseReporting::Click => 1,
            MouseReporting::Drag => 2,
            MouseReporting::Motion => 3,
        }
    }

    #[wasm_bindgen(getter, js_name = sgrMouse)]
    pub fn sgr_mouse(&self) -> bool {
        self.core.sgr_mouse()
    }

    #[wasm_bindgen(getter, js_name = alternateScroll)]
    pub fn alternate_scroll(&self) -> bool {
        self.core.alternate_scroll()
    }

    #[wasm_bindgen(getter, js_name = altScreen)]
    pub fn alt_screen(&self) -> bool {
        self.core.alt_screen()
    }

    #[wasm_bindgen(getter, js_name = bracketedPaste)]
    pub fn bracketed_paste(&self) -> bool {
        self.core.bracketed_paste()
    }

    /// Rewrite the packed grid buffer. Call once per frame, before reading the
    /// snapshot pointer.
    #[wasm_bindgen(js_name = refreshSnapshot)]
    pub fn refresh_snapshot(&mut self) {
        self.core.refresh_snapshot();
    }

    /// Offset of the packed grid inside the module's linear memory.
    ///
    /// **The view built from this pointer expires.** Any Rust allocation can
    /// grow the module's memory, which replaces the underlying `ArrayBuffer`
    /// and detaches every existing view. Rebuild the `Uint32Array` after each
    /// `feed()` or `resize()` — never cache it across frames.
    #[wasm_bindgen(js_name = snapshotPtr)]
    pub fn snapshot_ptr(&self) -> *const u32 {
        self.core.snapshot().as_ptr()
    }

    /// Length of the packed grid, in `u32` words.
    #[wasm_bindgen(js_name = snapshotLen)]
    pub fn snapshot_len(&self) -> usize {
        self.core.snapshot().len()
    }

    /// Lines changed since the last call, as flat `(line, left, right)`
    /// triplets with an inclusive right column. Taking the damage clears it.
    #[wasm_bindgen(js_name = takeDamage)]
    pub fn take_damage(&mut self) -> Vec<u32> {
        self.core.take_damage().to_vec()
    }

    /// Text between two zero-based viewport points, inclusive. Both endpoints
    /// are clamped to the current viewport and their order is normalized.
    #[wasm_bindgen(js_name = selectedText)]
    pub fn selected_text(
        &self,
        start_line: i32,
        start_col: usize,
        end_line: i32,
        end_col: usize,
    ) -> String {
        self.core
            .selected_text(start_line, start_col, end_line, end_col)
    }

    /// One zero-based viewport row as text. Debugging aid — renderers use `snapshotPtr` and
    /// `snapshotLen`.
    #[wasm_bindgen(js_name = rowText)]
    pub fn row_text(&self, line: usize) -> String {
        self.core.row_text(line)
    }

    #[wasm_bindgen(js_name = scrollLines)]
    pub fn scroll_lines(&mut self, delta: i32) {
        self.core.scroll_lines(delta);
    }

    #[wasm_bindgen(getter, js_name = maxScroll)]
    pub fn max_scroll(&self) -> usize {
        self.core.max_scroll()
    }

    #[wasm_bindgen(getter, js_name = displayOffset)]
    pub fn display_offset(&self) -> usize {
        self.core.display_offset()
    }

    #[wasm_bindgen(js_name = resetScroll)]
    pub fn reset_scroll(&mut self) {
        self.core.reset_scroll();
    }

    #[wasm_bindgen(js_name = setScrollbackLines)]
    pub fn set_scrollback_lines(&mut self, lines: usize) {
        self.core.set_scrollback_lines(lines);
    }
}

/// Encode a `keydown` as PTY bytes.
///
/// Returns `undefined` when the key produces no terminal input — a bare
/// modifier, an unmapped key, or anything held with Meta, which belongs to the
/// host application's shortcuts. Distinguishable by the caller from a key that
/// legitimately sends nothing.
#[wasm_bindgen(js_name = encodeKey)]
pub fn encode_key_js(
    key: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    application_cursor: bool,
) -> Option<Vec<u8>> {
    let input = build_key_input(key, ctrl, alt, shift, meta, application_cursor);
    encode_key(&input)
}

/// Encode a mouse event as PTY bytes.
///
/// `kind`: 0 press, 1 release, 2 move, 3 scroll up, 4 scroll down.
/// Parse a `#rrggbb` palette color into an RGB triple.
fn parse_hex_rgb(value: &str, field: &str) -> Result<Rgb, JsError> {
    let hex = value.strip_prefix('#').unwrap_or(value);
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(JsError::new(&format!(
            "invalid {field} color: expected #rrggbb, got \"{value}\""
        )));
    }
    let channel = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).unwrap_or(0);
    Ok(Rgb {
        r: channel(0..2),
        g: channel(2..4),
        b: channel(4..6),
    })
}

/// `button`: 0 none, 1 left, 2 middle, 3 right.
/// `reporting`: 0 none, 1 click, 2 drag, 3 motion — take it from the
/// terminal's `mouseReporting` getter.
///
/// Returns `undefined` when the event must not be reported.
#[wasm_bindgen(js_name = encodeMouse)]
#[allow(clippy::too_many_arguments)]
pub fn encode_mouse_js(
    kind: u8,
    button: u8,
    line: usize,
    column: usize,
    ctrl: bool,
    alt: bool,
    shift: bool,
    sgr_enabled: bool,
    reporting: u8,
    alternate_scroll: bool,
    alt_screen: bool,
    application_cursor: bool,
) -> Option<Vec<u8>> {
    let kind = match kind {
        0 => MouseEventKind::Press,
        1 => MouseEventKind::Release,
        2 => MouseEventKind::Move,
        3 => MouseEventKind::ScrollUp,
        4 => MouseEventKind::ScrollDown,
        _ => return None,
    };
    let button = match button {
        0 => MouseButton::None,
        1 => MouseButton::Left,
        2 => MouseButton::Middle,
        3 => MouseButton::Right,
        _ => return None,
    };
    let reporting = match reporting {
        0 => MouseReporting::None,
        1 => MouseReporting::Click,
        2 => MouseReporting::Drag,
        3 => MouseReporting::Motion,
        _ => return None,
    };

    encode_mouse(&MouseInput {
        kind,
        button,
        line,
        column,
        ctrl,
        alt,
        shift,
        sgr_enabled,
        reporting,
        alternate_scroll,
        alt_screen,
        application_cursor,
    })
}

/// Resolve an `alacritty.toml` into terminal options, in the browser.
///
/// `fallback` is a `TerminalPalette` object; every colour the file does not
/// set comes from it. Throws a JavaScript `Error` when the TOML is malformed
/// or the fallback is not a valid palette — both mean the caller's input is
/// wrong, and returning a silently defaulted object would hide it.
#[wasm_bindgen(js_name = resolveAlacrittyToml)]
pub fn resolve_alacritty_toml_js(source: &str, fallback: JsValue) -> Result<JsValue, JsValue> {
    let fallback: alacritty_config::options::TerminalPalette =
        serde_wasm_bindgen::from_value(fallback)
            .map_err(|e| JsValue::from_str(&format!("invalid fallback palette: {e}")))?;

    let options =
        alacritty_config::options::resolve(source, &fallback).map_err(|e| JsValue::from_str(&e))?;

    serde_wasm_bindgen::to_value(&options).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_input_is_built_verbatim_from_its_parts() {
        let input = build_key_input("ArrowUp".to_string(), false, true, false, false, true);
        assert_eq!(input.key, "ArrowUp");
        assert!(!input.ctrl);
        assert!(input.alt);
        assert!(!input.shift);
        assert!(!input.meta);
        assert!(input.application_cursor);
    }

    #[test]
    fn built_key_input_encodes_the_same_as_a_hand_written_one() {
        // The façade must not reorder or drop flags on the way through.
        let built = build_key_input("c".to_string(), true, false, false, false, false);
        let expected = crate::input::KeyInput {
            key: "c".to_string(),
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
            application_cursor: false,
        };
        assert_eq!(
            crate::input::encode_key(&built),
            crate::input::encode_key(&expected)
        );
        assert_eq!(crate::input::encode_key(&built), Some(vec![0x03]));
    }
}
