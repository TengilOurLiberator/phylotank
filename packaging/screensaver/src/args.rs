//! The screensaver command line ([Microsoft: screen saver command-line arguments], 05 §5.6.2).
//!
//! | Invocation              | Meaning                                                   |
//! |-------------------------|-----------------------------------------------------------|
//! | no arguments            | settings                                                  |
//! | `/c` or `/c:<HWND>`     | settings, modal to the foreground window or `<HWND>`      |
//! | `/p <HWND>`, `/p:<HWND>`| preview as a child of `<HWND>` (decimal)                  |
//! | `/s`                    | run the screensaver                                       |
//!
//! `/` or `-`, any letter case, `:` or a space before the HWND; unknown arguments are ignored.
//!
//! [Microsoft: screen saver command-line arguments]: https://learn.microsoft.com/en-us/previous-versions/troubleshoot/windows/win32/screen-saver-command-line

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// `/s`: full screen on every monitor.
    Show,
    /// `/c[:hwnd]` or no arguments: the settings dialog, owned by `hwnd` when given.
    Configure(Option<u64>),
    /// `/p <hwnd>`: draw into the settings dialog's little monitor. 0 if the HWND was missing.
    Preview(u64),
}

fn hwnd_after(flag: &str, next: Option<&String>) -> Option<u64> {
    // flag is the lower-cased token without its leading / or -, e.g. "p:1234" or "p"
    let inline = flag.get(1..).map(|r| r.trim_start_matches([':', '='])).filter(|r| !r.is_empty());
    match inline {
        Some(h) => h.parse().ok(),
        None => next.and_then(|n| n.trim().parse().ok()),
    }
}

/// Parse `std::env::args()` (the first element is the program).
pub fn parse(args: &[String]) -> Mode {
    let rest = args.get(1..).unwrap_or(&[]);
    for (i, raw) in rest.iter().enumerate() {
        let tok = raw.trim().to_ascii_lowercase();
        let Some(flag) = tok.strip_prefix(['/', '-']) else { continue };
        let next = rest.get(i + 1);
        match flag.chars().next() {
            Some('s') => return Mode::Show,
            Some('p') => return Mode::Preview(hwnd_after(flag, next).unwrap_or(0)),
            Some('c') => return Mode::Configure(hwnd_after(flag, next)),
            _ => continue,
        }
    }
    Mode::Configure(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        std::iter::once("phylotank.scr").chain(a.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn table() {
        let cases: &[(&[&str], Mode)] = &[
            (&[], Mode::Configure(None)),
            (&["/s"], Mode::Show),
            (&["/S"], Mode::Show),
            (&["-s"], Mode::Show),
            (&["/s", "extra"], Mode::Show),
            (&["/c"], Mode::Configure(None)),
            (&["/C:1234"], Mode::Configure(Some(1234))),
            (&["-c", "99"], Mode::Configure(Some(99))),
            (&["/p", "5678"], Mode::Preview(5678)),
            (&["/P:42"], Mode::Preview(42)),
            (&["/p=42"], Mode::Preview(42)),
            (&["/p"], Mode::Preview(0)),
            (&["/p", "junk"], Mode::Preview(0)),
            (&["/x", "/s"], Mode::Show),
            (&["unknown"], Mode::Configure(None)),
            (&["  /s  "], Mode::Show),
            (&["/p", "18446744073709551615"], Mode::Preview(u64::MAX)),
        ];
        for (a, want) in cases {
            assert_eq!(parse(&v(a)), *want, "{a:?}");
        }
    }

    #[test]
    fn empty_argv_is_configure() {
        assert_eq!(parse(&[]), Mode::Configure(None));
    }
}
