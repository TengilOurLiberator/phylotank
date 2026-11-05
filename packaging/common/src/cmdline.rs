//! Windows command-line quoting (the `CommandLineToArgvW` rules), for the `HKCU\...\Run` value
//! and for spawning the tray from the screensaver.

/// Quote one argument so `CommandLineToArgvW` gives it back unchanged.
pub fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '"']) {
        return arg.to_string();
    }
    let mut s = String::from('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                s.push_str(&"\\".repeat(backslashes * 2 + 1));
                s.push('"');
                backslashes = 0;
            }
            _ => {
                s.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                s.push(c);
            }
        }
    }
    s.push_str(&"\\".repeat(backslashes * 2));
    s.push('"');
    s
}

/// `"C:\path\Phylotank.exe" --tray`: the executable is always quoted.
pub fn command_line(exe: &str, args: &[&str]) -> String {
    let mut s = format!("\"{exe}\"");
    for a in args {
        s.push(' ');
        s.push_str(&quote(a));
    }
    s
}

/// The program path of a command line (quoted or not), for "does the Run key point at me?".
pub fn program_of(cmd: &str) -> &str {
    let t = cmd.trim_start();
    if let Some(rest) = t.strip_prefix('"') {
        rest.split('"').next().unwrap_or("")
    } else {
        t.split_whitespace().next().unwrap_or("")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_follows_commandlinetoargvw() {
        assert_eq!(quote("--tray"), "--tray");
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        assert_eq!(quote(r"C:\plain\path"), r"C:\plain\path");
    }

    #[test]
    fn run_key_value() {
        let exe = r"C:\Users\William\AppData\Local\Programs\Phylotank\Phylotank.exe";
        let v = command_line(exe, &["--tray"]);
        assert_eq!(v, format!("\"{exe}\" --tray"));
        assert_eq!(program_of(&v), exe);
        assert_eq!(program_of(r"C:\x\y.exe --a"), r"C:\x\y.exe");
    }
}
