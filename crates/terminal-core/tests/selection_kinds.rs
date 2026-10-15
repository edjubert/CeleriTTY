use terminal_core::{SelectionKind, SelectionPoint, TerminalCore, TerminalSize};

fn terminal(columns: usize, screen_lines: usize, text: &str) -> TerminalCore {
    let mut core = TerminalCore::new(TerminalSize {
        columns,
        screen_lines,
    });
    core.feed(text.as_bytes());
    core
}

fn at(line: i32, column: usize, right: bool) -> SelectionPoint {
    SelectionPoint {
        line,
        column,
        right,
    }
}

/// Resolve a selection and read its text back the way the browser does.
fn select(
    core: &TerminalCore,
    kind: SelectionKind,
    anchor: SelectionPoint,
    focus: SelectionPoint,
) -> Option<String> {
    let [(start_line, start_col), (end_line, end_col)] =
        core.selection_range(kind, anchor, focus)?;
    Some(core.selected_text(start_line, start_col, end_line, end_col))
}

#[test]
fn a_click_without_a_drag_selects_nothing() {
    let core = terminal(20, 3, "hello world");
    for right in [false, true] {
        let point = at(0, 3, right);
        assert_eq!(
            core.selection_range(SelectionKind::Simple, point, point),
            None
        );
    }
    // Right half of one cell to the left half of the next: still no cell crossed.
    assert_eq!(
        core.selection_range(SelectionKind::Simple, at(0, 3, true), at(0, 4, false)),
        None
    );
}

#[test]
fn a_drag_covers_only_the_cells_it_crosses_the_middle_of() {
    let core = terminal(20, 3, "hello world");
    // Crossing one cell's middle selects exactly that character.
    let single = select(
        &core,
        SelectionKind::Simple,
        at(0, 1, false),
        at(0, 1, true),
    );
    assert_eq!(single.as_deref(), Some("e"));
    let word = select(
        &core,
        SelectionKind::Simple,
        at(0, 0, false),
        at(0, 4, true),
    );
    assert_eq!(word.as_deref(), Some("hello"));
    // Backwards drags resolve to the same cells.
    let reversed = select(
        &core,
        SelectionKind::Simple,
        at(0, 4, true),
        at(0, 0, false),
    );
    assert_eq!(reversed.as_deref(), Some("hello"));
    let trimmed = select(
        &core,
        SelectionKind::Simple,
        at(0, 0, true),
        at(0, 4, false),
    );
    assert_eq!(trimmed.as_deref(), Some("ell"));
}

#[test]
fn a_double_click_selects_the_word_under_the_pointer() {
    let core = terminal(40, 3, "cd /usr/local/bin && ls -la");
    let point = at(0, 9, false);
    let word = select(&core, SelectionKind::Word, point, point);
    assert_eq!(word.as_deref(), Some("/usr/local/bin"));
    // Dragging after a double click extends word by word.
    let words = select(&core, SelectionKind::Word, point, at(0, 18, true));
    assert_eq!(words.as_deref(), Some("/usr/local/bin &&"));
}

#[test]
fn a_double_click_on_a_bracket_selects_up_to_its_pair() {
    let core = terminal(40, 3, "call(a, b) done");
    let bracket = at(0, 4, false);
    let selected = select(&core, SelectionKind::Word, bracket, bracket);
    assert_eq!(selected.as_deref(), Some("(a, b)"));
}

#[test]
fn a_word_soft_wrapped_across_rows_is_selected_whole() {
    let core = terminal(6, 3, "$ abcdefgh");
    let selected = select(&core, SelectionKind::Word, at(1, 1, false), at(1, 1, false));
    assert_eq!(selected.as_deref(), Some("abcdefgh"));
}

#[test]
fn a_triple_click_selects_the_whole_logical_line() {
    let core = terminal(6, 4, "first\r\n$ abcdefgh\r\nlast");
    // Clicked on the wrapped continuation: the line starts one row above.
    let line = select(&core, SelectionKind::Line, at(2, 1, false), at(2, 1, false));
    assert_eq!(line.as_deref(), Some("$ abcdefgh"));
    let range = core.selection_range(SelectionKind::Line, at(2, 1, false), at(2, 1, false));
    assert_eq!(range, Some([(1, 0), (2, 5)]));
    // Dragging extends line by line.
    let lines = select(&core, SelectionKind::Line, at(0, 3, true), at(1, 0, false));
    assert_eq!(lines.as_deref(), Some("first\n$ abcdefgh"));
}

#[test]
fn ranges_follow_the_scrolled_viewport() {
    let mut core = terminal(12, 2, "alpha beta\r\ngamma\r\ndelta\r\nomega");
    core.scroll_lines(2);
    // Viewport row 0 now shows "alpha beta", two rows above the live screen.
    let range = core.selection_range(SelectionKind::Word, at(0, 7, false), at(0, 7, false));
    assert_eq!(range, Some([(0, 6), (0, 9)]));
    let word = select(&core, SelectionKind::Word, at(0, 7, false), at(0, 7, false));
    assert_eq!(word.as_deref(), Some("beta"));
}

#[test]
fn out_of_range_points_are_clamped_rather_than_panicking() {
    let core = terminal(8, 3, "one\r\ntwo\r\nthree");
    for line in [i32::MIN, -1, 0, 2, 3, i32::MAX] {
        for column in [0, 7, 8, usize::MAX] {
            for kind in [
                SelectionKind::Simple,
                SelectionKind::Word,
                SelectionKind::Line,
            ] {
                let _ = core.selection_range(
                    kind,
                    at(line, column, false),
                    at(line.saturating_neg(), column, true),
                );
            }
        }
    }
}
