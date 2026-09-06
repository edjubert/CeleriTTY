use terminal_core::{TerminalCore, TerminalSize};

fn terminal() -> TerminalCore {
    TerminalCore::new(TerminalSize {
        columns: 80,
        screen_lines: 24,
    })
}

#[test]
fn cursor_position_query_replies_at_the_current_cursor() {
    let mut core = terminal();
    core.feed(b"\x1b[3;7H\x1b[6n");
    assert_eq!(core.take_output(), b"\x1b[3;7R");
    assert!(core.take_output().is_empty());
}

#[test]
fn split_queries_wait_for_completion_and_replies_stay_in_order() {
    let mut core = terminal();
    core.feed(b"hello\x1b[6");
    assert!(core.take_output().is_empty());
    core.feed(b"n\x1b[5n\x1b[2;4H\x1b[6n");
    assert_eq!(core.take_output(), b"\x1b[1;6R\x1b[0n\x1b[2;4R");
    assert!(core.take_output().is_empty());
}

#[test]
fn normal_text_and_clipboard_requests_do_not_generate_output() {
    let mut core = terminal();
    core.feed(b"hello\x1b]52;c;?\x07");
    assert!(core.take_output().is_empty());
}

#[test]
fn device_attributes_are_forwarded_and_terminals_are_isolated() {
    let mut first = terminal();
    let mut second = terminal();
    first.feed(b"\x1b[c");
    assert!(second.take_output().is_empty());
    let reply = first.take_output();
    assert_eq!(reply, b"\x1b[?6c");
    assert!(first.take_output().is_empty());
}

#[test]
fn each_byte_boundary_can_split_a_cursor_query() {
    let sequence = b"\x1b[8;13H\x1b[6n";
    for split in 0..sequence.len() {
        let mut core = terminal();
        core.feed(&sequence[..split]);
        assert!(core.take_output().is_empty());
        core.feed(&sequence[split..]);
        assert_eq!(core.take_output(), b"\x1b[8;13R");
    }
}

#[test]
fn reports_the_resized_alternate_screen_and_restored_primary_cursor() {
    let mut core = terminal();
    core.feed(b"\x1b[3;7H\x1b[?1049h");
    core.resize(TerminalSize {
        columns: 40,
        screen_lines: 10,
    });
    core.feed(b"\x1b[10;40H\x1b[6n\x1b[?1049l\x1b[6n");
    assert_eq!(core.take_output(), b"\x1b[10;40R\x1b[3;7R");
}
