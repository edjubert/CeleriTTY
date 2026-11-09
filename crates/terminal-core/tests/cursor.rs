use terminal_core::snapshot::{CURSOR_BEAM, CURSOR_BLOCK, CURSOR_MASK, CURSOR_UNDERLINE};
use terminal_core::{TerminalCore, TerminalSize, WORDS_PER_CELL};
use vte::ansi::CursorShape;

fn terminal() -> TerminalCore {
    TerminalCore::new(TerminalSize {
        columns: 8,
        screen_lines: 2,
    })
}

fn cursor(core: &mut TerminalCore) -> Vec<(usize, u32)> {
    core.refresh_snapshot();
    core.snapshot()
        .chunks(WORDS_PER_CELL)
        .enumerate()
        .filter_map(|(index, cell)| (cell[3] & CURSOR_MASK != 0).then_some((index, cell[3])))
        .collect()
}

#[test]
fn decscusr_changes_shape_and_blink_without_moving_or_rewriting_text() {
    let mut core = terminal();
    // Cursor over inverse text: its attributes must survive every shape.
    core.feed(b"\x1b[7mA\x1b[H");
    for (parameter, shape, blinking) in [
        (1, CURSOR_BLOCK, true),
        (2, CURSOR_BLOCK, false),
        (3, CURSOR_UNDERLINE, true),
        (4, CURSOR_UNDERLINE, false),
        (5, CURSOR_BEAM, true),
        (6, CURSOR_BEAM, false),
    ] {
        core.feed(format!("\x1b[{parameter} q").as_bytes());
        assert_eq!(cursor(&mut core), [(0, shape | 1)]);
        assert_eq!(core.cursor_blinking(), blinking);
        assert_eq!(core.snapshot()[0], 'A' as u32);
    }
}

#[test]
fn cursor_sequences_can_split_at_every_byte_boundary() {
    let sequence = b"\x1b[6 q";
    for split in 0..=sequence.len() {
        let mut core = terminal();
        core.feed(&sequence[..split]);
        core.feed(&sequence[split..]);
        assert_eq!(cursor(&mut core), [(0, CURSOR_BEAM)]);
    }
}

#[test]
fn defaults_survive_scrollback_changes_and_application_overrides_reset() {
    let mut core = terminal();
    core.set_cursor_style(CursorShape::Beam, true);
    core.set_scrollback_lines(10);
    assert_eq!(cursor(&mut core), [(0, CURSOR_BEAM)]);
    assert!(core.cursor_blinking());
    core.feed(b"\x1b[4 q");
    core.set_cursor_style(CursorShape::Block, true);
    assert_eq!(cursor(&mut core), [(0, CURSOR_UNDERLINE)]);
    assert!(!core.cursor_blinking());
    for reset in [b"\x1b[0 q".as_slice(), b"\x1b[ q", b"\x1bc"] {
        core.feed(b"\x1b[6 q");
        core.feed(reset);
        assert_eq!(cursor(&mut core), [(0, CURSOR_BLOCK)]);
        assert!(core.cursor_blinking());
    }
}

#[test]
fn hiding_and_showing_preserves_shape_and_blink() {
    let mut core = terminal();
    core.feed(b"\x1b[5 q\x1b[?25l");
    assert!(cursor(&mut core).is_empty());
    assert!(!core.cursor_blinking());
    core.feed(b"\x1b[?25h");
    assert_eq!(cursor(&mut core), [(0, CURSOR_BEAM)]);
    assert!(core.cursor_blinking());
    core.feed(b"\x1b[?12l");
    assert!(!core.cursor_blinking());
    core.feed(b"\x1b[?12h");
    assert!(core.cursor_blinking());
}

#[test]
fn cursor_is_anchored_to_the_leading_cell_of_a_wide_character() {
    let mut core = terminal();
    core.feed("界\x1b[1;2H\x1b[6 q".as_bytes());
    let marked = cursor(&mut core);
    assert_eq!(marked.len(), 1);
    assert_eq!(marked[0].0, 0);
    assert_eq!(marked[0].1 & CURSOR_MASK, CURSOR_BEAM);
}

#[test]
fn synchronized_cursor_changes_wait_for_the_end_of_the_batch() {
    let mut core = terminal();
    core.feed(b"\x1b[?2026h\x1b[6 q");
    assert_eq!(cursor(&mut core), [(0, CURSOR_BLOCK)]);
    core.feed(b"\x1b[?2026l");
    assert_eq!(cursor(&mut core), [(0, CURSOR_BEAM)]);
}
