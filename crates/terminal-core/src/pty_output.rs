//! Collect parser-generated protocol replies for the host to send to the PTY.
//! Answer color defaults in the callback so later CSI replies cannot overtake them.

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use vte::ansi::{NamedColor, Rgb};

#[derive(Default)]
struct Output {
    bytes: Vec<u8>,
    /// Host theme defaults. OSC overrides are resolved by the terminal before
    /// reaching the listener, while it still has the query's color state.
    named_colors: [Option<Rgb>; 3],
}

#[derive(Clone, Default)]
pub(crate) struct PtyOutput {
    output: Arc<Mutex<Output>>,
}

impl PtyOutput {
    pub(crate) fn take(&self) -> Vec<u8> {
        std::mem::take(&mut self.output.lock().expect("PTY output lock poisoned").bytes)
    }

    pub(crate) fn set_named_colors(&self, foreground: Rgb, background: Rgb, cursor: Rgb) {
        self.output
            .lock()
            .expect("PTY output lock poisoned")
            .named_colors = [Some(foreground), Some(background), Some(cursor)];
    }
}

impl EventListener for PtyOutput {
    fn send_event(&self, event: Event) {
        // Only protocol replies are automatic. In particular, clipboard reads
        // remain host policy and must never be answered through this channel.
        let text = match event {
            Event::PtyWrite(text) => text,
            Event::ColorRequest(index, formatter) => {
                let output = self.output.lock().expect("PTY output lock poisoned");
                let color = match index {
                    i if i == NamedColor::Foreground as usize => output.named_colors[0],
                    i if i == NamedColor::Background as usize => output.named_colors[1],
                    i if i == NamedColor::Cursor as usize => output.named_colors[2],
                    // The ANSI palette belongs to the renderer. Without an
                    // OSC override, stay silent rather than inventing a color.
                    _ => None,
                };
                let Some(color) = color else { return };
                formatter(color)
            }
            _ => return,
        };
        self.output
            .lock()
            .expect("PTY output lock poisoned")
            .bytes
            .extend_from_slice(text.as_bytes());
    }
}
