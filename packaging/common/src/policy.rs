//! The tray's restart policy for the host (05 §5.2.3 step 5): restart after 1 s, 5 s, 30 s and
//! then 120 s; after 5 crashes within 10 minutes stop and tell the user. Pure, with explicit
//! instants, so it is tested without sleeping.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct RestartPolicy {
    pub delays: Vec<Duration>,
    pub window: Duration,
    pub max_crashes: usize,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        RestartPolicy {
            delays: [1, 5, 30, 120].iter().map(|s| Duration::from_secs(*s)).collect(),
            window: Duration::from_secs(600),
            max_crashes: 5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    RestartAfter(Duration),
    GiveUp,
}

#[derive(Debug, Clone)]
pub struct CrashLog {
    policy: RestartPolicy,
    crashes: VecDeque<Instant>,
}

impl CrashLog {
    pub fn new(policy: RestartPolicy) -> Self {
        CrashLog { policy, crashes: VecDeque::new() }
    }

    /// Crashes still inside the window at `now`.
    pub fn recent(&mut self, now: Instant) -> usize {
        while let Some(&t) = self.crashes.front() {
            if now.saturating_duration_since(t) > self.policy.window {
                self.crashes.pop_front();
            } else {
                break;
            }
        }
        self.crashes.len()
    }

    /// Record a crash (an exit, or failed health checks) and decide what to do.
    pub fn on_crash(&mut self, now: Instant) -> Decision {
        self.crashes.push_back(now);
        let n = self.recent(now);
        if n >= self.policy.max_crashes {
            return Decision::GiveUp;
        }
        let i = (n - 1).min(self.policy.delays.len().saturating_sub(1));
        Decision::RestartAfter(self.policy.delays.get(i).copied().unwrap_or(Duration::from_secs(1)))
    }

    /// Forget history, for a manual "Restart host" from the tray.
    pub fn reset(&mut self) {
        self.crashes.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backs_off_then_gives_up_after_five_crashes_in_ten_minutes() {
        let t0 = Instant::now();
        let mut log = CrashLog::new(RestartPolicy::default());
        let s = Duration::from_secs;
        assert_eq!(log.on_crash(t0), Decision::RestartAfter(s(1)));
        assert_eq!(log.on_crash(t0 + s(10)), Decision::RestartAfter(s(5)));
        assert_eq!(log.on_crash(t0 + s(20)), Decision::RestartAfter(s(30)));
        assert_eq!(log.on_crash(t0 + s(60)), Decision::RestartAfter(s(120)));
        assert_eq!(log.on_crash(t0 + s(200)), Decision::GiveUp);
    }

    #[test]
    fn old_crashes_fall_out_of_the_window() {
        let t0 = Instant::now();
        let mut log = CrashLog::new(RestartPolicy::default());
        let s = Duration::from_secs;
        for i in 0..4 {
            log.on_crash(t0 + s(i));
        }
        // 11 minutes later the history has expired: back to the first delay
        assert_eq!(log.on_crash(t0 + s(660)), Decision::RestartAfter(s(1)));
        assert_eq!(log.recent(t0 + s(660)), 1);
    }

    #[test]
    fn reset_forgets() {
        let t0 = Instant::now();
        let mut log = CrashLog::new(RestartPolicy::default());
        for _ in 0..4 {
            log.on_crash(t0);
        }
        log.reset();
        assert_eq!(log.on_crash(t0), Decision::RestartAfter(Duration::from_secs(1)));
    }
}
