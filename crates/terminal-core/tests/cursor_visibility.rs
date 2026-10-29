use terminal_core::terminal::{TerminalCore, TerminalSize};

fn core() -> TerminalCore {
    TerminalCore::new(TerminalSize {
        columns: 4,
        screen_lines: 2,
    })
}

fn inverse(core: &TerminalCore) -> Vec<usize> {
    core.snapshot()
        .chunks_exact(4)
        .enumerate()
        .filter_map(|(index, cell)| (cell[3] & 1 != 0).then_some(index))
        .collect()
}

#[test]
fn local_visibility_never_overrides_or_changes_application_visibility() {
    let mut core = core();
    core.refresh_snapshot_with_cursor(false);
    assert!(inverse(&core).is_empty());
    core.refresh_snapshot_with_cursor(true);
    assert_eq!(inverse(&core), [0]);

    core.feed(b"\x1b[?25l");
    for visible in [true, false, true] {
        core.refresh_snapshot_with_cursor(visible);
        assert!(inverse(&core).is_empty());
    }
    core.feed(b"\x1b[?25h");
    core.refresh_snapshot_with_cursor(false);
    assert!(inverse(&core).is_empty());
    core.refresh_snapshot_with_cursor(true);
    assert_eq!(inverse(&core), [0]);
    // Existing raw-engine callers keep the default cursor behavior.
    core.refresh_snapshot();
    assert_eq!(inverse(&core), [0]);
    assert!(core.take_output().is_empty());
}

#[test]
fn hiding_the_overlay_preserves_inverse_cells_and_all_other_snapshot_words() {
    let mut core = core();
    core.feed(b"\x1b[7;1;38;2;18;52;86mAB\x1b[0mCD\r");
    core.refresh_snapshot_with_cursor(false);
    let normal = core.snapshot().to_vec();
    assert_eq!(inverse(&core), [0, 1]);
    core.refresh_snapshot_with_cursor(true);
    assert_eq!(inverse(&core), [1]);
    for (index, (&actual, &expected)) in core.snapshot().iter().zip(&normal).enumerate() {
        assert_eq!(actual, if index == 3 { expected ^ 1 } else { expected });
    }
    core.refresh_snapshot_with_cursor(false);
    assert_eq!(core.snapshot(), normal);
    assert_eq!(core.row_text(0), "ABCD");
}

#[test]
fn a_cursor_outside_the_scrollback_view_is_not_drawn_when_focus_returns() {
    let mut core = core();
    core.feed(b"one\r\ntwo\r\ntri\r\nfour\r\nfive");
    core.scroll_lines(3);
    for visible in [false, true, false, true] {
        core.refresh_snapshot_with_cursor(visible);
        assert!(inverse(&core).is_empty());
    }
    core.reset_scroll();
    core.refresh_snapshot_with_cursor(true);
    assert_eq!(inverse(&core), [7]);
}
