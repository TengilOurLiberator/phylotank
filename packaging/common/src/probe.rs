//! A dependency-free loopback HTTP probe: `GET /health` on `127.0.0.1:<port>`.
//!
//! Any HTTP answer below 500 counts as alive. The phase-0 host has no `/health` route yet and
//! answers 404, which still proves it is listening (contract request in
//! `docs/contract-requests/packaging.md`). A 200 answer's JSON body is kept for the status line.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Health {
    /// Nothing listening, a timeout, or a server error.
    Down,
    /// An HTTP status below 500; `body` only for a 200.
    Up { status: u16, body: Option<String> },
}

impl Health {
    pub fn is_up(&self) -> bool {
        matches!(self, Health::Up { .. })
    }
}

/// Parse `HTTP/1.x NNN ...` and return the status code.
pub fn parse_status_line(line: &str) -> Option<u16> {
    let mut parts = line.split_whitespace();
    let proto = parts.next()?;
    if !proto.starts_with("HTTP/1.") {
        return None;
    }
    let code: u16 = parts.next()?.parse().ok()?;
    (100..600).contains(&code).then_some(code)
}

/// One GET with a total time budget. Returns the status code and up to 64 KB of body.
pub fn http_get(port: u16, path: &str, timeout: Duration) -> io::Result<(u16, Vec<u8>)> {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut s = TcpStream::connect_timeout(&addr, timeout)?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;
    // The Host header must name the loopback address: the host rejects others (DNS rebinding).
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: phylotank-native\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes())?;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 64 * 1024 {
                    break;
                }
            }
            Err(e) if buf.is_empty() => return Err(e),
            Err(_) => break,
        }
    }
    let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4).unwrap_or(buf.len());
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let status = head
        .lines()
        .next()
        .and_then(parse_status_line)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not an HTTP response"))?;
    Ok((status, buf[head_end..].to_vec()))
}

/// Probe the host's health endpoint.
pub fn probe(port: u16, timeout: Duration) -> Health {
    match http_get(port, "/health", timeout) {
        Ok((status, body)) if status < 500 => {
            Health::Up { status, body: (status == 200).then(|| String::from_utf8_lossy(&body).into_owned()) }
        }
        _ => Health::Down,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn serve_once(response: &'static str) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut c, _)) = l.accept() {
                let mut req = [0u8; 1024];
                let n = c.read(&mut req).unwrap_or(0);
                let text = String::from_utf8_lossy(&req[..n]).to_string();
                assert!(text.starts_with("GET /health HTTP/1.1\r\n"));
                assert!(text.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
                let _ = c.write_all(response.as_bytes());
            }
        });
        port
    }

    #[test]
    fn status_lines() {
        assert_eq!(parse_status_line("HTTP/1.1 200 OK"), Some(200));
        assert_eq!(parse_status_line("HTTP/1.0 404 Not Found"), Some(404));
        assert_eq!(parse_status_line("SSH-2.0-OpenSSH"), None);
        assert_eq!(parse_status_line("HTTP/1.1 abc"), None);
        assert_eq!(parse_status_line("HTTP/1.1 999 x"), None);
    }

    #[test]
    fn a_200_is_up_with_its_body() {
        let port = serve_once("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"tick\":5}");
        assert_eq!(probe(port, Duration::from_secs(2)), Health::Up { status: 200, body: Some("{\"ok\":true,\"tick\":5}".into()) });
    }

    #[test]
    fn a_404_from_an_older_host_still_counts_as_up() {
        let port = serve_once("HTTP/1.1 404 Not Found\r\n\r\nnot found");
        assert_eq!(probe(port, Duration::from_secs(2)), Health::Up { status: 404, body: None });
    }

    #[test]
    fn a_server_error_or_garbage_is_down() {
        let port = serve_once("HTTP/1.1 503 Busy\r\n\r\n");
        assert_eq!(probe(port, Duration::from_secs(2)), Health::Down);
        let port = serve_once("hello\r\n\r\n");
        assert_eq!(probe(port, Duration::from_secs(2)), Health::Down);
    }

    #[test]
    fn nothing_listening_is_down_quickly() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let t = std::time::Instant::now();
        assert_eq!(probe(port, Duration::from_millis(200)), Health::Down);
        assert!(t.elapsed() < Duration::from_secs(1));
    }
}
