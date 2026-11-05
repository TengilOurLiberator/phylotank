//! When does input end the screensaver (05 §5.6.2)?
//!
//! - A key press, a mouse button press or the wheel: at once (key and button releases never
//!   count, so the click on "Preview" in the settings dialog does not end it).
//! - Mouse movement: only after a 500 ms grace period (Windows sends spurious moves at launch)
//!   and only beyond 8 px (Chebyshev distance) from where the cursor was at start.

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    /// The cursor is now at this screen position.
    MouseAt {
        x: i32,
        y: i32,
    },
    ButtonDown,
    ButtonUp,
    Wheel,
    KeyDown,
    KeyUp,
}

#[derive(Debug, Clone)]
pub struct ExitGate {
    start: Instant,
    grace: Duration,
    threshold_px: i32,
    origin: Option<(i32, i32)>,
}

impl ExitGate {
    pub const GRACE: Duration = Duration::from_millis(500);
    pub const THRESHOLD_PX: i32 = 8;

    /// `origin` is the cursor position at launch, if known.
    pub fn new(start: Instant, origin: Option<(i32, i32)>) -> Self {
        ExitGate { start, grace: Self::GRACE, threshold_px: Self::THRESHOLD_PX, origin }
    }

    pub fn in_grace(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.start) < self.grace
    }

    /// True if this input should end the screensaver.
    pub fn should_exit(&mut self, now: Instant, input: Input) -> bool {
        match input {
            Input::KeyDown | Input::ButtonDown | Input::Wheel => true,
            Input::KeyUp | Input::ButtonUp => false,
            Input::MouseAt { x, y } => {
                if self.in_grace(now) {
                    return false;
                }
                match self.origin {
                    None => {
                        self.origin = Some((x, y));
                        false
                    }
                    Some((ox, oy)) => (x - ox).abs() > self.threshold_px || (y - oy).abs() > self.threshold_px,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    #[test]
    fn keys_buttons_and_wheel_exit_at_once_releases_never() {
        let t0 = Instant::now();
        let mut g = ExitGate::new(t0, Some((100, 100)));
        assert!(!g.should_exit(t0, Input::KeyUp));
        assert!(!g.should_exit(t0 + MS(900), Input::ButtonUp));
        assert!(g.should_exit(t0 + MS(1), Input::KeyDown));
        assert!(g.should_exit(t0 + MS(1), Input::ButtonDown));
        assert!(g.should_exit(t0 + MS(1), Input::Wheel));
    }

    #[test]
    fn launch_jitter_is_ignored_for_500_ms() {
        let t0 = Instant::now();
        let mut g = ExitGate::new(t0, Some((100, 100)));
        assert!(!g.should_exit(t0 + MS(10), Input::MouseAt { x: 400, y: 400 }));
        assert!(!g.should_exit(t0 + MS(499), Input::MouseAt { x: 400, y: 400 }));
        assert!(g.should_exit(t0 + MS(500), Input::MouseAt { x: 400, y: 400 }));
    }

    #[test]
    fn small_moves_after_the_grace_do_not_exit() {
        let t0 = Instant::now();
        let mut g = ExitGate::new(t0, Some((100, 100)));
        let later = t0 + MS(2000);
        assert!(!g.should_exit(later, Input::MouseAt { x: 108, y: 92 }));
        assert!(!g.should_exit(later, Input::MouseAt { x: 100, y: 100 }));
        assert!(g.should_exit(later, Input::MouseAt { x: 109, y: 100 }));
        assert!(g.should_exit(later, Input::MouseAt { x: 100, y: 91 }));
    }

    #[test]
    fn an_unknown_origin_is_taken_from_the_first_move_after_the_grace() {
        let t0 = Instant::now();
        let mut g = ExitGate::new(t0, None);
        let later = t0 + MS(600);
        assert!(!g.should_exit(later, Input::MouseAt { x: 0, y: 0 }));
        assert!(!g.should_exit(later, Input::MouseAt { x: 8, y: 8 }));
        assert!(g.should_exit(later, Input::MouseAt { x: 9, y: 0 }));
    }
}
