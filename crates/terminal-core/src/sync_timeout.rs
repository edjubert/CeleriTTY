//! VTE buffers synchronized updates, but its embedder owns timeout delivery.
//! Use the browser's monotonic clock on wasm32, never std::time::Instant.

use std::time::Duration;
use vte::ansi::Timeout;

#[cfg(not(target_arch = "wasm32"))]
type Timestamp = std::time::Instant;
#[cfg(target_arch = "wasm32")]
type Timestamp = f64;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn now() -> f64;
}

#[derive(Default)]
pub(crate) struct SyncTimeout {
    deadline: Option<Timestamp>,
}

impl SyncTimeout {
    pub(crate) fn expired(&self) -> bool {
        #[cfg(target_arch = "wasm32")]
        let expired = self.deadline.is_some_and(|deadline| now() >= deadline);
        #[cfg(not(target_arch = "wasm32"))]
        let expired = self
            .deadline
            .is_some_and(|deadline| Timestamp::now() >= deadline);
        expired
    }
}

impl Timeout for SyncTimeout {
    fn set_timeout(&mut self, duration: Duration) {
        #[cfg(target_arch = "wasm32")]
        let deadline = now() + duration.as_secs_f64() * 1000.0;
        #[cfg(not(target_arch = "wasm32"))]
        let deadline = Timestamp::now() + duration;
        self.deadline = Some(deadline);
    }

    fn clear_timeout(&mut self) {
        self.deadline = None;
    }

    // Pending is NOT the same as unexpired: buffered bytes must first be
    // applied through Processor::stop_sync, not bypassed by Processor::advance.
    fn pending_timeout(&self) -> bool {
        self.deadline.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiration_does_not_clear_pending_bytes_and_begin_renews_deadline() {
        let mut timer = SyncTimeout::default();
        assert!(!timer.pending_timeout());
        assert!(!timer.expired());
        timer.set_timeout(Duration::ZERO);
        assert!(timer.expired());
        assert!(timer.pending_timeout());
        timer.set_timeout(Duration::from_secs(60));
        assert!(!timer.expired());
        timer.clear_timeout();
        assert!(!timer.pending_timeout());
        assert!(!timer.expired());
    }
}
