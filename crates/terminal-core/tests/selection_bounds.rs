use terminal_core::{TerminalCore, TerminalSize};

#[test]
fn clamps_both_endpoints_before_normalizing_and_converting_scrollback() {
    let mut core = TerminalCore::new(TerminalSize {
        columns: 8,
        screen_lines: 3,
    });
    core.feed(b"abcdefgh\r\nijklmnop\r\nqrstuvwx\r\nyzABCDEF\r\nGHIJKLMN");
    for scroll in [0, 2] {
        core.scroll_lines(scroll);
        for columns in [8, 4, 1] {
            core.resize(TerminalSize {
                columns,
                screen_lines: 3,
            });
            for start_line in [i32::MIN, -1, 0, 1, 2, 3, i32::MAX] {
                for end_line in [i32::MIN, -1, 0, 1, 2, 3, i32::MAX] {
                    for start_col in [0, 1, 7, 8, usize::MAX] {
                        for end_col in [0, 1, 7, 8, usize::MAX] {
                            let mut start = (start_line.clamp(0, 2), start_col.min(columns - 1));
                            let mut end = (end_line.clamp(0, 2), end_col.min(columns - 1));
                            if start > end {
                                std::mem::swap(&mut start, &mut end);
                            }
                            let expected = core.selected_text(start.0, start.1, end.0, end.1);
                            assert_eq!(
                                core.selected_text(start_line, start_col, end_line, end_col),
                                expected
                            );
                        }
                    }
                }
            }
        }
        core.feed(b"\r\nALIVE");
        core.refresh_snapshot();
        assert!(!core.snapshot().is_empty());
    }
}

#[test]
fn scrollback_selection_still_uses_zero_based_viewport_rows() {
    let mut core = TerminalCore::new(TerminalSize {
        columns: 8,
        screen_lines: 3,
    });
    core.feed(b"one\r\ntwo\r\nthree\r\nfour\r\nfive");
    core.scroll_lines(2);
    assert_eq!(core.selected_text(-100, 0, 0, usize::MAX), "one");
    assert_eq!(
        core.selected_text(2, usize::MAX, -100, 0),
        "one\ntwo\nthree"
    );
    assert_eq!(core.selected_text(0, 0, 1, 2), "one\ntwo");
    core.feed(b"\r\nsix");
    assert_eq!(core.selected_text(0, 0, 0, usize::MAX), "one");
    core.resize(TerminalSize {
        columns: 4,
        screen_lines: 1,
    });
    assert_eq!(
        core.selected_text(i32::MAX, usize::MAX, i32::MIN, 0),
        core.row_text(0)
    );
}

#[test]
fn wide_character_wrap_at_the_first_row_keeps_selection_in_bounds() {
    let mut core = TerminalCore::new(TerminalSize {
        columns: 4,
        screen_lines: 3,
    });
    core.feed("abc界".as_bytes());
    assert_eq!(core.selected_text(0, 0, 0, usize::MAX), "abc界");
    assert_eq!(core.selected_text(1, 1, 0, 0), "abc界");
}
