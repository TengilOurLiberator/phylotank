//! `/p <hwnd>`: a light GDI animation inside the settings dialog's little monitor (05 §5.6.2:
//! a WebView2 in a 152 x 112 thumbnail is heavy and fragile). Dark water and a few drifting
//! motes at 15 fps; exits when the parent window goes away.
//! Still to do (v0.3): draw the host's `/thumbnail.png` when the host serves one.

use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateSolidBrush, DeleteDC, DeleteObject, Ellipse, EndPaint, FillRect,
    GetStockObject, InvalidateRect, SelectObject, BLACK_BRUSH, HBRUSH, NULL_PEN, PAINTSTRUCT, SRCCOPY,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW, IsWindow, KillTimer, PostQuitMessage,
    RegisterClassW, SetTimer, TranslateMessage, MSG, WM_DESTROY, WM_ERASEBKGND, WM_PAINT, WM_TIMER, WNDCLASSW, WS_CHILD, WS_VISIBLE,
};

use phylotank_common::win::wide;

static PARENT: AtomicIsize = AtomicIsize::new(0);
static FRAME: AtomicU32 = AtomicU32::new(0);

const fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

/// Mote positions as fractions of the preview, from a fixed LCG (pure, so it is the same each run).
fn mote(i: u32, frame: u32) -> (f32, f32, i32) {
    let mut s = i.wrapping_mul(2_654_435_761).wrapping_add(12345);
    let mut next = || {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (s >> 8) as f32 / 16_777_216.0
    };
    let x0 = next();
    let y0 = next();
    let speed = 0.002 + next() * 0.004;
    let r = 1 + (next() * 2.0) as i32;
    let y = (y0 - speed * frame as f32).rem_euclid(1.0);
    (x0, y, r)
}

unsafe fn paint(hwnd: HWND) {
    let mut ps: PAINTSTRUCT = std::mem::zeroed();
    let hdc = BeginPaint(hwnd, &mut ps);
    let mut rc: RECT = std::mem::zeroed();
    GetClientRect(hwnd, &mut rc);
    let (w, h) = (rc.right - rc.left, rc.bottom - rc.top);
    let mem = CreateCompatibleDC(hdc);
    let bmp = CreateCompatibleBitmap(hdc, w.max(1), h.max(1));
    let old_bmp = SelectObject(mem, bmp);
    // vertical gradient in 4 px bands: #04131f at the top to #000306 at the bottom
    let bands = (h / 4).max(1);
    for b in 0..bands {
        let d = b as f32 / bands as f32;
        let c = rgb((4.0 * (1.0 - d)) as u8, (19.0 * (1.0 - d) + 3.0 * d) as u8, (31.0 * (1.0 - d) + 6.0 * d) as u8);
        let brush = CreateSolidBrush(c);
        let band = RECT { left: 0, top: b * 4, right: w, bottom: if b == bands - 1 { h } else { b * 4 + 4 } };
        FillRect(mem, &band, brush);
        DeleteObject(brush);
    }
    let frame = FRAME.load(Ordering::Relaxed);
    let old_pen = SelectObject(mem, GetStockObject(NULL_PEN));
    for i in 0..14u32 {
        let (fx, fy, r) = mote(i, frame);
        let brush = CreateSolidBrush(if i % 4 == 3 { rgb(170, 110, 230) } else { rgb(90, 190, 220) });
        let old = SelectObject(mem, brush);
        let (x, y) = ((fx * w as f32) as i32, (fy * h as f32) as i32);
        Ellipse(mem, x - r, y - r, x + r + 1, y + r + 1);
        SelectObject(mem, old);
        DeleteObject(brush);
    }
    SelectObject(mem, old_pen);
    BitBlt(hdc, 0, 0, w, h, mem, 0, 0, SRCCOPY);
    SelectObject(mem, old_bmp);
    DeleteObject(bmp);
    DeleteDC(mem);
    EndPaint(hwnd, &ps);
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER => {
            if IsWindow(PARENT.load(Ordering::Relaxed) as HWND) == 0 {
                DestroyWindow(hwnd);
                return 0;
            }
            FRAME.fetch_add(1, Ordering::Relaxed);
            InvalidateRect(hwnd, std::ptr::null(), 0);
            0
        }
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            paint(hwnd);
            0
        }
        WM_DESTROY => {
            KillTimer(hwnd, 1);
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

pub fn run(parent: HWND) -> ! {
    unsafe {
        if parent.is_null() || IsWindow(parent) == 0 {
            std::process::exit(0);
        }
        PARENT.store(parent as isize, Ordering::Relaxed);
        let hinst = GetModuleHandleW(std::ptr::null());
        let class = wide("PhylotankPreview");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: hinst,
            lpszClassName: class.as_ptr(),
            hbrBackground: GetStockObject(BLACK_BRUSH) as HBRUSH,
            ..std::mem::zeroed()
        };
        RegisterClassW(&wc);
        let mut rc: RECT = std::mem::zeroed();
        GetClientRect(parent, &mut rc);
        let title = wide("Phylotank preview");
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            rc.right - rc.left,
            rc.bottom - rc.top,
            parent,
            std::ptr::null_mut(),
            hinst,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            std::process::exit(1);
        }
        SetTimer(hwnd, 1, 1000 / 15, None);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    std::process::exit(0)
}
