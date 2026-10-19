use terminal_core::{TerminalCore, TerminalSize};

fn terminal(columns: usize, screen_lines: usize) -> TerminalCore {
    TerminalCore::new(TerminalSize {
        columns,
        screen_lines,
    })
}

fn rows(core: &TerminalCore) -> Vec<String> {
    (0..core.screen_lines())
        .map(|line| core.row_text(line))
        .collect()
}

#[test]
fn the_prompt_line_becomes_the_first_row_and_history_is_dropped() {
    let mut core = terminal(12, 4);
    core.feed(b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n$ ls");
    assert!(core.max_scroll() > 0);

    core.clear_to_cursor_line();

    assert_eq!(rows(&core), ["$ ls", "", "", ""]);
    assert_eq!((core.cursor_line(), core.cursor_column()), (0, 4));
    assert_eq!(core.max_scroll(), 0);
    // The shell keeps echoing where it left off.
    core.feed(b" -la");
    assert_eq!(core.row_text(0), "$ ls -la");
}

#[test]
fn a_wrapped_prompt_line_moves_whole() {
    let mut core = terminal(6, 4);
    core.feed(b"out\r\n$ abcdefgh");
    assert_eq!(rows(&core), ["out", "$ abcd", "efgh", ""]);

    core.clear_to_cursor_line();

    assert_eq!(rows(&core), ["$ abcd", "efgh", "", ""]);
    assert_eq!((core.cursor_line(), core.cursor_column()), (1, 4));
}

#[test]
fn rows_below_the_cursor_follow_it_up() {
    let mut core = terminal(12, 4);
    // A shell completion menu drawn below the prompt, cursor back on the prompt.
    core.feed(b"old\r\n$ gi\r\ngit  gist\x1b[A\x1b[5G");

    core.clear_to_cursor_line();

    assert_eq!(rows(&core), ["$ gi", "git  gist", "", ""]);
    assert_eq!((core.cursor_line(), core.cursor_column()), (0, 4));
}

#[test]
fn a_scrolled_back_view_returns_to_the_live_screen() {
    let mut core = terminal(12, 3);
    core.feed(b"one\r\ntwo\r\nthree\r\nfour\r\n$ ");
    core.scroll_lines(2);

    core.clear_to_cursor_line();

    assert_eq!(core.display_offset(), 0);
    assert_eq!(rows(&core), ["$", "", ""]);
}

#[test]
fn the_alternate_screen_is_left_to_its_program() {
    let mut core = terminal(12, 3);
    core.feed(b"one\r\ntwo\r\nthree\r\nfour\x1b[?1049h\x1b[Hvim\r\n~");
    let before = rows(&core);

    core.clear_to_cursor_line();

    assert_eq!(rows(&core), before);
    core.feed(b"\x1b[?1049l");
    assert_eq!(core.row_text(2), "four");
    assert!(core.max_scroll() > 0);
}
