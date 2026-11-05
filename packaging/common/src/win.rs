//! Small Win32 helpers (per-user only, never elevated): the `HKCU\...\Run` value, a named-mutex
//! single-instance lock, opening a URL in the default browser, and message boxes.

#![allow(clippy::missing_safety_doc)]

use std::ffi::c_void;
use std::io;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HANDLE, HWND};
use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, SW_SHOWNORMAL};

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const RUN_VALUE: &str = "Phylotank";

/// A NUL-terminated UTF-16 string.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn win_err(code: u32) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}

/// Read a `REG_SZ` under `HKCU\<subkey>`.
pub fn hkcu_get(subkey: &str, value: &str) -> Option<String> {
    let (k, v) = (wide(subkey), wide(value));
    let mut bytes: u32 = 0;
    unsafe {
        if RegGetValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, null_mut(), null_mut(), &mut bytes) != ERROR_SUCCESS {
            return None;
        }
        let mut buf = vec![0u16; (bytes as usize).div_ceil(2) + 1];
        let mut len = (buf.len() * 2) as u32;
        if RegGetValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, null_mut(), buf.as_mut_ptr() as *mut c_void, &mut len)
            != ERROR_SUCCESS
        {
            return None;
        }
        let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]))
    }
}

/// Write a `REG_SZ` under `HKCU\<subkey>` (the key is created if needed).
pub fn hkcu_set(subkey: &str, value: &str, data: &str) -> io::Result<()> {
    let (k, v, d) = (wide(subkey), wide(value), wide(data));
    let rc =
        unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr(), REG_SZ, d.as_ptr() as *const c_void, (d.len() * 2) as u32) };
    if rc == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(win_err(rc))
    }
}

/// Delete a value under `HKCU\<subkey>`; a missing value is not an error.
pub fn hkcu_delete(subkey: &str, value: &str) -> io::Result<()> {
    let (k, v) = (wide(subkey), wide(value));
    let rc = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr()) };
    if rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(win_err(rc))
    }
}

/// The `Run` value, if any.
pub fn autostart_get() -> Option<String> {
    hkcu_get(RUN_KEY, RUN_VALUE)
}

/// Start with Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Phylotank`.
pub fn autostart_set(enabled: bool, command_line: &str) -> io::Result<()> {
    if enabled {
        hkcu_set(RUN_KEY, RUN_VALUE, command_line)
    } else {
        hkcu_delete(RUN_KEY, RUN_VALUE)
    }
}

/// Holds a named mutex for the life of the process.
pub struct SingleInstance(HANDLE);

impl SingleInstance {
    /// `None` when another process already holds `name` (for example `Local\Phylotank`).
    pub fn acquire(name: &str) -> Option<SingleInstance> {
        let n = wide(name);
        unsafe {
            let h = CreateMutexW(null(), 0, n.as_ptr());
            if h.is_null() {
                return None;
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                CloseHandle(h);
                return None;
            }
            Some(SingleInstance(h))
        }
    }
}

impl Drop for SingleInstance {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Open a URL with the default browser. Only `http://127.0.0.1` and `http://localhost` URLs are
/// accepted, so nothing else can be launched through this helper.
pub fn open_local_url(url: &str) -> io::Result<()> {
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "only loopback URLs"));
    }
    shell_open(url)
}

/// `ShellExecuteW(open)` on a path or URL.
pub fn shell_open(target: &str) -> io::Result<()> {
    let (op, t) = (wide("open"), wide(target));
    let r = unsafe { ShellExecuteW(null_mut(), op.as_ptr(), t.as_ptr(), null(), null(), SW_SHOWNORMAL) };
    // ShellExecute returns a value greater than 32 on success
    if (r as isize) > 32 {
        Ok(())
    } else {
        Err(io::Error::other(format!("ShellExecute failed: {}", r as isize)))
    }
}

/// `MessageBoxW`; returns the button id. The owner HWND is only handed to the OS, which
/// validates it (a stale or null handle gives an unowned box).
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn message_box(owner: HWND, text: &str, caption: &str, style: u32) -> i32 {
    let (t, c) = (wide(text), wide(caption));
    unsafe { MessageBoxW(owner, t.as_ptr(), c.as_ptr(), style) }
}
