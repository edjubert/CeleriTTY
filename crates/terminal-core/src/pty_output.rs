//! Collect parser-generated protocol replies for the host to send to the PTY.

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use vte::ansi::Rgb;

/// An OSC color query awaiting an answer: the requested palette index and the
/// formatter that turns the RGB value into the reply escape sequence.
pub(crate) type ColorRequest = (usize, Arc<dyn Fn(Rgb) -> String + Sync + Send + 'static>);

#[derive(Clone, Default)]
pub(crate) struct PtyOutput {
    bytes: Arc<Mutex<Vec<u8>>>,
    color_requests: Arc<Mutex<Vec<ColorRequest>>>,
}

impl PtyOutput {
    pub(crate) fn take(&self) -> Vec<u8> {
        std::mem::take(&mut *self.bytes.lock().expect("PTY output lock poisoned"))
    }

    pub(crate) fn push(&self, bytes: &[u8]) {
        self.bytes
            .lock()
            .expect("PTY output lock poisoned")
            .extend_from_slice(bytes);
    }

    /// Color queries cannot be answered from inside the event listener: the
    /// listener has no access to the theme, and the reply must reflect it.
    /// They queue here for the core to resolve once the parser is done.
    pub(crate) fn take_color_requests(&self) -> Vec<ColorRequest> {
        std::mem::take(
            &mut *self
                .color_requests
                .lock()
                .expect("color request lock poisoned"),
        )
    }
}

impl EventListener for PtyOutput {
    fn send_event(&self, event: Event) {
        // Only protocol replies are automatic. In particular, clipboard reads
        // remain host policy and must never be answered through this channel.
        match event {
            Event::PtyWrite(text) => self.push(text.as_bytes()),
            Event::ColorRequest(index, formatter) => self
                .color_requests
                .lock()
                .expect("color request lock poisoned")
                .push((index, formatter)),
            _ => {}
        }
    }
}
