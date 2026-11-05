//! Host supervision (05 §5.2.3 steps 3 and 5), host-agnostic so it is tested on Linux.
//!
//! Spawns the host, writes `host.json`, polls `GET /health`, and restarts the host when it
//! exits or misses 3 health checks in a row, with the backoff of `phylotank_common::policy`.
//! After 5 crashes in 10 minutes it stops and waits for a manual restart. Stopping closes the
//! host's stdin first (a host that follows `docs/contract-requests/packaging.md` flushes and
//! exits on EOF) and kills it after a grace period.

use phylotank_common::hostinfo::{self, HostInfo};
use phylotank_common::policy::{CrashLog, Decision, RestartPolicy};
use phylotank_common::probe;
use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct Config {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub port: u16,
    /// Wait before the first start (20 s at logon, so the desktop's own start-up goes first).
    pub initial_delay: Duration,
    pub health_every: Duration,
    pub health_timeout: Duration,
    /// Missed health checks in a row that count as a crash.
    pub max_missed: u32,
    /// How long a fresh host may take before missed checks count.
    pub startup_grace: Duration,
    pub stop_grace: Duration,
    pub policy: RestartPolicy,
    pub host_json: Option<PathBuf>,
    pub log: Option<PathBuf>,
}

impl Config {
    pub fn new(program: PathBuf, args: Vec<String>, port: u16) -> Self {
        Config {
            program,
            args,
            port,
            initial_delay: Duration::ZERO,
            health_every: Duration::from_secs(5),
            health_timeout: Duration::from_secs(1),
            max_missed: 3,
            startup_grace: Duration::from_secs(15),
            stop_grace: Duration::from_secs(3),
            policy: RestartPolicy::default(),
            host_json: None,
            log: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Waiting { until_secs: u64 },
    Starting { pid: u32 },
    Running { pid: u32 },
    Restarting { after: Duration, crashes: usize, reason: String },
    GaveUp { crashes: usize, reason: String },
    Stopped,
}

impl State {
    /// One line for the tray menu.
    pub fn describe(&self, port: u16) -> String {
        match self {
            State::Waiting { until_secs } => format!("Host: starting in {until_secs} s"),
            State::Starting { .. } => "Host: starting...".into(),
            State::Running { .. } => format!("Host: running on port {port}"),
            State::Restarting { after, crashes, .. } => format!("Host: restarting in {} s (crash {crashes})", after.as_secs().max(1)),
            State::GaveUp { crashes, .. } => format!("Host: stopped after {crashes} crashes; see the log"),
            State::Stopped => "Host: stopped".into(),
        }
    }
}

#[derive(Default)]
struct Flags {
    stop: bool,
    restart: bool,
}

type Shared = Arc<(Mutex<(State, Flags)>, Condvar)>;

pub struct Supervisor {
    shared: Shared,
    thread: Option<JoinHandle<()>>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn open_log(path: &Option<PathBuf>) -> Option<File> {
    let p = path.as_ref()?;
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // keep one old log: host.log -> host.1.log once it passes 5 MB
    if std::fs::metadata(p).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(p, p.with_extension("1.log"));
    }
    OpenOptions::new().create(true).append(true).open(p).ok()
}

fn spawn(cfg: &Config) -> std::io::Result<Child> {
    let mut cmd = Command::new(&cfg.program);
    cmd.args(&cfg.args).stdin(Stdio::piped());
    match open_log(&cfg.log) {
        Some(f) => {
            let f2 = f.try_clone()?;
            cmd.stdout(Stdio::from(f)).stderr(Stdio::from(f2));
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

impl Supervisor {
    /// Start supervising. `on_change` is called from the supervisor thread on every state change.
    pub fn start(cfg: Config, on_change: impl Fn(&State) + Send + 'static) -> Supervisor {
        let shared: Shared = Arc::new((Mutex::new((State::Stopped, Flags::default())), Condvar::new()));
        let s2 = shared.clone();
        let thread = std::thread::Builder::new()
            .name("phylotank-supervisor".into())
            .spawn(move || run(cfg, s2, on_change))
            .expect("spawn supervisor thread");
        Supervisor { shared, thread: Some(thread) }
    }

    #[cfg_attr(not(test), allow(dead_code))] // the tests and a future status page read it
    pub fn state(&self) -> State {
        self.shared.0.lock().unwrap_or_else(|e| e.into_inner()).0.clone()
    }

    /// Restart the host now, forgetting the crash history (tray "Restart host").
    pub fn restart(&self) {
        let (m, cv) = &*self.shared;
        m.lock().unwrap_or_else(|e| e.into_inner()).1.restart = true;
        cv.notify_all();
    }

    /// Stop the host and the supervisor thread.
    pub fn stop(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        let (m, cv) = &*self.shared;
        m.lock().unwrap_or_else(|e| e.into_inner()).1.stop = true;
        cv.notify_all();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

enum Wake {
    Timeout,
    Stop,
    Restart,
}

/// Sleep up to `d`, waking early for stop or restart requests.
fn wait(shared: &Shared, d: Duration) -> Wake {
    let (m, cv) = &**shared;
    let deadline = Instant::now() + d;
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if g.1.stop {
            return Wake::Stop;
        }
        if g.1.restart {
            g.1.restart = false;
            return Wake::Restart;
        }
        let now = Instant::now();
        if now >= deadline {
            return Wake::Timeout;
        }
        g = cv.wait_timeout(g, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
    }
}

fn set(shared: &Shared, st: State, on_change: &impl Fn(&State)) {
    let changed = {
        let mut g = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        let changed = g.0 != st;
        g.0 = st.clone();
        changed
    };
    if changed {
        on_change(&st);
    }
}

fn shut_down(child: &mut Child, grace: Duration) {
    drop(child.stdin.take()); // EOF on stdin: the host's cue to flush and exit
    let t = Instant::now();
    while t.elapsed() < grace {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn clear_host_json(cfg: &Config) {
    if let Some(p) = &cfg.host_json {
        let _ = std::fs::remove_file(p);
    }
}

fn run(cfg: Config, shared: Shared, on_change: impl Fn(&State)) {
    let mut crashes = CrashLog::new(cfg.policy.clone());
    if !cfg.initial_delay.is_zero() {
        set(&shared, State::Waiting { until_secs: cfg.initial_delay.as_secs() }, &on_change);
        match wait(&shared, cfg.initial_delay) {
            Wake::Stop => {
                set(&shared, State::Stopped, &on_change);
                return;
            }
            Wake::Restart | Wake::Timeout => {}
        }
    }
    let tick = Duration::from_millis(100).min(cfg.health_every);
    'outer: loop {
        let mut child = match spawn(&cfg) {
            Ok(c) => c,
            Err(e) => {
                let reason = format!("could not start {}: {e}", cfg.program.display());
                if !after_crash(&shared, &on_change, &mut crashes, reason) {
                    break 'outer;
                }
                continue;
            }
        };
        let pid = child.id();
        if let Some(p) = &cfg.host_json {
            let _ = hostinfo::write(p, &HostInfo { port: cfg.port, pid, started_at: now_secs(), view_token_local: None });
        }
        set(&shared, State::Starting { pid }, &on_change);
        let started = Instant::now();
        let mut last_probe = Instant::now() - cfg.health_every;
        let mut missed = 0u32;
        let mut ready = false;
        let reason = loop {
            match wait(&shared, tick) {
                Wake::Stop => {
                    shut_down(&mut child, cfg.stop_grace);
                    clear_host_json(&cfg);
                    set(&shared, State::Stopped, &on_change);
                    break 'outer;
                }
                Wake::Restart => {
                    shut_down(&mut child, cfg.stop_grace);
                    crashes.reset();
                    continue 'outer;
                }
                Wake::Timeout => {}
            }
            if let Ok(Some(status)) = child.try_wait() {
                break format!("host exited ({status})");
            }
            if last_probe.elapsed() >= cfg.health_every || (!ready && last_probe.elapsed() >= tick * 5) {
                last_probe = Instant::now();
                if probe::probe(cfg.port, cfg.health_timeout).is_up() {
                    missed = 0;
                    if !ready {
                        ready = true;
                        set(&shared, State::Running { pid }, &on_change);
                    }
                } else if ready || started.elapsed() > cfg.startup_grace {
                    missed += 1;
                    if missed >= cfg.max_missed {
                        shut_down(&mut child, Duration::ZERO);
                        break format!("host missed {missed} health checks");
                    }
                }
            }
        };
        clear_host_json(&cfg);
        if !after_crash(&shared, &on_change, &mut crashes, reason) {
            break 'outer;
        }
    }
}

/// Handle a crash: wait out the backoff (true: start again) or give up until a manual restart.
fn after_crash(shared: &Shared, on_change: &impl Fn(&State), crashes: &mut CrashLog, reason: String) -> bool {
    match crashes.on_crash(Instant::now()) {
        Decision::RestartAfter(d) => {
            let n = crashes.recent(Instant::now());
            set(shared, State::Restarting { after: d, crashes: n, reason }, on_change);
            match wait(shared, d) {
                Wake::Stop => {
                    set(shared, State::Stopped, on_change);
                    false
                }
                Wake::Restart => {
                    crashes.reset();
                    true
                }
                Wake::Timeout => true,
            }
        }
        Decision::GiveUp => {
            let n = crashes.recent(Instant::now());
            set(shared, State::GaveUp { crashes: n, reason }, on_change);
            loop {
                match wait(shared, Duration::from_secs(3600)) {
                    Wake::Stop => {
                        set(shared, State::Stopped, on_change);
                        return false;
                    }
                    Wake::Restart => {
                        crashes.reset();
                        return true;
                    }
                    Wake::Timeout => {}
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "supervisor_tests.rs"]
mod tests;
