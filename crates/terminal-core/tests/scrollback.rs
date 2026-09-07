use terminal_core::{TerminalCore, TerminalSize, WORDS_PER_CELL};

fn terminal() -> TerminalCore {
    let mut core = TerminalCore::new(TerminalSize {
        columns: 12,
        screen_lines: 3,
    });
    core.feed(b"one\r\ntwo\r\nthree\r\nfour\r\nfive");
    core
}

fn rows(core: &mut TerminalCore) -> Vec<String> {
    core.refresh_snapshot();
    let rows: Vec<String> = core
        .snapshot()
        .chunks(core.columns() * WORDS_PER_CELL)
        .map(|row| {
            row.chunks(WORDS_PER_CELL)
                .map(|cell| char::from_u32(cell[0]).unwrap())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect();
    for (line, text) in rows.iter().enumerate() {
        assert_eq!(&core.row_text(line), text);
    }
    rows
}

#[test]
fn scroll_renders_history_in_both_directions_and_clamps() {
    let mut core = terminal();
    assert_eq!(rows(&mut core), ["three", "four", "five"]);
    core.scroll_lines(1);
    assert_eq!(rows(&mut core), ["two", "three", "four"]);
    core.scroll_lines(100);
    assert_eq!(rows(&mut core), ["one", "two", "three"]);
    core.scroll_lines(-1);
    assert_eq!(rows(&mut core), ["two", "three", "four"]);
    core.scroll_lines(-100);
    assert_eq!(rows(&mut core), ["three", "four", "five"]);
    core.scroll_lines(2);
    core.reset_scroll();
    assert_eq!(rows(&mut core), ["three", "four", "five"]);
}

#[test]
fn incoming_output_preserves_history_but_live_view_keeps_following() {
    let mut core = terminal();
    core.scroll_lines(2);
    for bytes in [b"".as_slice(), b"!", b"\r\nsix", b"\r\nseven"] {
        core.feed(bytes);
        assert_eq!(rows(&mut core), ["one", "two", "three"]);
    }
    core.reset_scroll();
    assert_eq!(rows(&mut core), ["five!", "six", "seven"]);
    core.feed(b"\r\neight");
    assert_eq!(core.display_offset(), 0);
    assert_eq!(rows(&mut core), ["six", "seven", "eight"]);
}

#[test]
fn history_eviction_and_resize_keep_viewport_valid() {
    let mut core = terminal();
    core.set_scrollback_lines(2);
    core.scroll_lines(100);
    core.feed(b"\r\nsix");
    assert_eq!(rows(&mut core), ["two", "three", "four"]);
    core.resize(TerminalSize {
        columns: 12,
        screen_lines: 2,
    });
    assert_eq!(rows(&mut core).len(), 2);
    core.set_scrollback_lines(0);
    assert_eq!(core.display_offset(), 0);
    assert_eq!(rows(&mut core), ["five", "six"]);
}

#[test]
fn cursor_moves_with_viewport_and_disappears_outside_it() {
    let mut core = terminal();
    // Inverse is the renderer's block-cursor marker (also an SGR attribute).
    let inverse = alacritty_terminal::term::cell::Flags::INVERSE.bits() as u32;
    core.feed(b"\x1b[1;1H");
    core.scroll_lines(1);
    core.refresh_snapshot();
    let marked: Vec<usize> = core
        .snapshot()
        .chunks(WORDS_PER_CELL)
        .enumerate()
        .filter_map(|(i, cell)| (cell[3] & inverse != 0).then_some(i))
        .collect();
    assert_eq!(marked, [12]);
    core.feed(b"\x1b[3;1H");
    core.refresh_snapshot();
    assert!(core
        .snapshot()
        .chunks(WORDS_PER_CELL)
        .all(|cell| cell[3] & inverse == 0));
    core.reset_scroll();
    core.refresh_snapshot();
    assert_ne!(core.snapshot()[24 * WORDS_PER_CELL + 3] & inverse, 0);
}

#[test]
fn selection_coordinates_match_visible_history() {
    let mut core = terminal();
    core.scroll_lines(2);
    let offset = core.display_offset() as i32;
    assert_eq!(core.selected_text(-offset, 0, -offset, 2), "one");
    assert_eq!(core.selected_text(1 - offset, 0, 1 - offset, 2), "two");
    assert_eq!(rows(&mut core), ["one", "two", "three"]);
}

#[test]
fn alternate_screen_has_no_history_and_restores_primary_view() {
    let mut core = terminal();
    core.scroll_lines(2);
    core.feed(b"\x1b[?1049h\x1b[Halt");
    core.scroll_lines(100);
    assert_eq!(core.display_offset(), 0);
    assert_eq!(rows(&mut core), ["alt", "", ""]);
    core.feed(b"\x1b[?1049l");
    assert_eq!(rows(&mut core), ["one", "two", "three"]);
}
