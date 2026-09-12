use terminal_core::{TerminalCore, TerminalSize};

fn terminal() -> TerminalCore {
    TerminalCore::new(TerminalSize {
        columns: 40,
        screen_lines: 3,
    })
}

#[test]
fn begin_end_and_repeated_begins_buffer_until_commit() {
    let mut core = terminal();
    core.feed(b"before\x1b[?2026h");
    core.feed(b"FIRST\x1b[?2026hSECOND");
    assert_eq!(core.row_text(0), "before");
    assert!(!core.flush_sync(false));
    core.feed(b"\x1b[?2026l");
    assert_eq!(core.row_text(0), "beforeFIRSTSECOND");
    assert!(!core.flush_sync(true));
    core.feed(b"\x1b[?2026lAFTER");
    assert_eq!(core.row_text(0), "beforeFIRSTSECONDAFTER");
}

#[test]
fn every_split_and_single_byte_chunks_preserve_sync_and_protocol() {
    let bytes = b"\x1b[?2026hTEXT\x1b[6n\x1b[?2026l\x1b[?2026$p";
    for split in 0..=bytes.len() {
        let mut core = terminal();
        core.feed(&bytes[..split]);
        core.feed(&bytes[split..]);
        assert_eq!(core.row_text(0), "TEXT");
        assert_eq!(core.take_output(), b"\x1b[1;5R\x1b[?2026;2$y");
    }
    let mut core = terminal();
    for byte in bytes {
        core.feed(&[*byte]);
    }
    assert_eq!(core.row_text(0), "TEXT");
    assert_eq!(core.take_output(), b"\x1b[1;5R\x1b[?2026;2$y");
}

#[test]
fn timeout_flushes_without_new_bytes_and_render_and_replies_resume() {
    let mut core = terminal();
    core.feed(b"\x1b[?2026hTIMEOUT\x1b[6n");
    assert_eq!(core.row_text(0), "");
    assert!(core.take_output().is_empty());
    std::thread::sleep(std::time::Duration::from_millis(180));
    assert!(core.flush_sync(false));
    assert_eq!(core.row_text(0), "TIMEOUT");
    assert_eq!(core.take_output(), b"\x1b[1;8R");
    assert!(!core.flush_sync(false));
    core.feed(b"\x1b[?2026hOK\x1b[?2026l");
    core.refresh_snapshot();
    assert_eq!(core.row_text(0), "TIMEOUTOK");
}

#[test]
fn expired_data_precedes_new_feed_and_resize_remains_safe() {
    let mut core = terminal();
    core.feed(b"\x1b[?2026hOLD");
    core.resize(TerminalSize {
        columns: 10,
        screen_lines: 2,
    });
    std::thread::sleep(std::time::Duration::from_millis(180));
    core.feed(b"NEW");
    assert_eq!(core.row_text(0), "OLDNEW");
}
