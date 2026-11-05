//! Supervisor tests with real processes: a crashing Node one-liner, a missing program, and
//! (when `dist/host.mjs` is built) the real host, killed from outside and restarted.

use super::*;
use std::sync::{Arc, Mutex};

fn node() -> Option<PathBuf> {
    crate::launch::which(if cfg!(windows) { "node.exe" } else { "node" }, std::env::var_os("PATH").as_deref())
}

fn fast(mut cfg: Config) -> Config {
    cfg.health_every = Duration::from_millis(200);
    cfg.health_timeout = Duration::from_millis(300);
    cfg.startup_grace = Duration::from_secs(10);
    cfg.stop_grace = Duration::from_millis(500);
    cfg.policy = RestartPolicy {
        delays: vec![Duration::from_millis(20), Duration::from_millis(40)],
        window: Duration::from_secs(60),
        max_crashes: 3,
    };
    cfg
}

fn recorder() -> (Arc<Mutex<Vec<State>>>, impl Fn(&State) + Send + 'static) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let l2 = log.clone();
    (log, move |s: &State| l2.lock().unwrap().push(s.clone()))
}

fn wait_for(sup: &Supervisor, secs: u64, pred: impl Fn(&State) -> bool) -> State {
    let t = Instant::now();
    loop {
        let s = sup.state();
        if pred(&s) || t.elapsed() > Duration::from_secs(secs) {
            return s;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn a_host_that_keeps_crashing_is_given_up_on_and_can_be_restarted() {
    let Some(node) = node() else { return eprintln!("skipped: node not on PATH") };
    let cfg = fast(Config::new(node, vec!["-e".into(), "process.exit(3)".into()], 1));
    let (log, cb) = recorder();
    let sup = Supervisor::start(cfg, cb);
    let s = wait_for(&sup, 10, |s| matches!(s, State::GaveUp { .. }));
    assert!(matches!(s, State::GaveUp { crashes: 3, .. }), "{s:?}");
    if let State::GaveUp { reason, .. } = &s {
        assert!(reason.contains("exited"), "{reason}");
    }
    let restarts = log.lock().unwrap().iter().filter(|s| matches!(s, State::Restarting { .. })).count();
    assert_eq!(restarts, 2);
    sup.restart();
    let s = wait_for(&sup, 10, |s| matches!(s, State::Starting { .. } | State::Restarting { .. }));
    assert!(matches!(s, State::Starting { .. } | State::Restarting { .. }), "{s:?}");
    sup.stop();
}

#[test]
fn a_missing_program_is_reported() {
    let cfg = fast(Config::new(PathBuf::from("/definitely/not/here/node"), vec![], 1));
    let sup = Supervisor::start(cfg, |_| {});
    let s = wait_for(&sup, 5, |s| matches!(s, State::GaveUp { .. }));
    match s {
        State::GaveUp { reason, .. } => assert!(reason.contains("could not start"), "{reason}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_initial_delay_waits_and_stop_ends_it() {
    let mut cfg = fast(Config::new(PathBuf::from("unused"), vec![], 1));
    cfg.initial_delay = Duration::from_secs(30);
    let sup = Supervisor::start(cfg, |_| {});
    let s = wait_for(&sup, 2, |s| matches!(s, State::Waiting { .. }));
    assert_eq!(s, State::Waiting { until_secs: 30 });
    let t = Instant::now();
    sup.stop();
    assert!(t.elapsed() < Duration::from_secs(2));
}

fn kill_pid(pid: u32) {
    if cfg!(windows) {
        let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status();
    } else {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

#[test]
fn supervises_the_real_host() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("dist").join("host.mjs");
    let (Some(node), true) = (node(), script.is_file()) else {
        return eprintln!("skipped: needs node on PATH and dist/host.mjs (npm run build)");
    };
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    let dir = std::env::temp_dir().join(format!("pt-sup-{}", std::process::id()));
    let mut cfg = fast(Config::new(node, crate::launch::host_args(&script, port), port));
    cfg.host_json = Some(dir.join("host.json"));
    cfg.log = Some(dir.join("logs").join("host.log"));
    let t0 = Instant::now();
    let sup = Supervisor::start(cfg, |_| {});
    let s = wait_for(&sup, 20, |s| matches!(s, State::Running { .. }));
    let State::Running { pid } = s else { panic!("host never became healthy: {s:?}") };
    eprintln!("host healthy after {} ms", t0.elapsed().as_millis());
    let info = hostinfo::read(&dir.join("host.json")).expect("host.json written");
    assert_eq!((info.port, info.pid), (port, pid));
    assert!(probe::probe(port, Duration::from_secs(1)).is_up());

    let t1 = Instant::now();
    kill_pid(pid);
    let s = wait_for(&sup, 20, |s| matches!(s, State::Running { pid: p } if *p != pid));
    assert!(matches!(s, State::Running { pid: p } if p != pid), "not restarted: {s:?}");
    eprintln!("host restarted and healthy {} ms after a kill", t1.elapsed().as_millis());

    sup.stop();
    assert!(!dir.join("host.json").exists(), "host.json removed on stop");
    assert!(!probe::probe(port, Duration::from_millis(300)).is_up(), "host gone after stop");
    assert!(std::fs::read_to_string(dir.join("logs").join("host.log")).unwrap().contains("Phylotank host"));
    let _ = std::fs::remove_dir_all(dir);
}
