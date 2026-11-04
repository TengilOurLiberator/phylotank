//! phylotank.scr: the Windows screensaver wrapper (source skeleton, not yet built in CI).
//!
//! Windows starts a screensaver with `/s` (show), `/c[:hwnd]` (configure) or `/p <hwnd>`
//! (preview inside the settings dialog). Arguments are case-insensitive and may use `-`.
//! The real wrapper opens `http://127.0.0.1:47615/screensaver.html` full screen on every
//! monitor with wry (WebView2), starts the host if it is not running (idle animation while it
//! waits, never black: review R25), and exits within 100 ms on input after a short grace
//! period that ignores launch jitter.

#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    Show,
    Configure,
    Preview(u64),
}

pub fn parse(args: &[String]) -> Mode {
    let first = args.get(1).map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    let flag = first.trim_start_matches(['/', '-']);
    if flag.starts_with('s') {
        Mode::Show
    } else if flag.starts_with('p') {
        let inline = flag.split_once(':').map(|(_, h)| h.to_string());
        let hwnd = inline.or_else(|| args.get(2).cloned()).and_then(|h| h.parse().ok()).unwrap_or(0);
        Mode::Preview(hwnd)
    } else {
        // no argument, or /c: Windows asks for the settings dialog
        Mode::Configure
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match parse(&args) {
        Mode::Show => println!("show: open screensaver.html full screen (not implemented yet)"),
        Mode::Configure => println!("configure: open the god window settings (not implemented yet)"),
        Mode::Preview(h) => println!("preview into window {h} (not implemented yet)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(a: &[&str]) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }
    #[test]
    fn parses_scr_arguments() {
        assert_eq!(parse(&v(&["x", "/S"])), Mode::Show);
        assert_eq!(parse(&v(&["x", "-s"])), Mode::Show);
        assert_eq!(parse(&v(&["x", "/c:1234"])), Mode::Configure);
        assert_eq!(parse(&v(&["x"])), Mode::Configure);
        assert_eq!(parse(&v(&["x", "/p", "5678"])), Mode::Preview(5678));
        assert_eq!(parse(&v(&["x", "/p:42"])), Mode::Preview(42));
    }
}
