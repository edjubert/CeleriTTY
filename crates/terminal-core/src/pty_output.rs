//! Collect parser-generated protocol replies for the host to send to the PTY.

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};

#[derive(Clone, Default)]
pub(crate) struct PtyOutput(Arc<Mutex<Vec<u8>>>);

impl PtyOutput {
    pub(crate) fn take(&self) -> Vec<u8> {
        std::mem::take(&mut *self.0.lock().expect("PTY output lock poisoned"))
    }
}

impl EventListener for PtyOutput {
    fn send_event(&self, event: Event) {
        // Only protocol replies are automatic. In particular, clipboard reads
        // remain host policy and must never be answered through this channel.
        if let Event::PtyWrite(text) = event {
            self.0
                .lock()
                .expect("PTY output lock poisoned")
                .extend_from_slice(text.as_bytes());
        }
    }
}
