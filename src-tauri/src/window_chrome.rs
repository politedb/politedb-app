// macOS needs objc macros in THIS module (because msg_send! is used here).
#[cfg(target_os = "macos")]
use tauri::Manager;

pub fn apply(app: &tauri::App) {
    let win = get_main_webview_window(app);

    #[cfg(target_os = "macos")]
    macos_apply(&win);

    #[cfg(target_os = "windows")]
    windows_apply(&win);

    // Linux: no-op (WM/compositor dependent)
}

fn get_main_webview_window(app: &tauri::App) -> tauri::WebviewWindow {
    if let Some(win) = app.get_webview_window("main") {
        return win;
    }

    app.webview_windows()
        .values()
        .next()
        .cloned()
        .expect("No webview window found")
}

#[cfg(target_os = "macos")]
fn macos_apply(win: &tauri::WebviewWindow) {
    // Requires tauri.conf.json: decorations=true + titleBarStyle=Overlay for native rounded corners.
    hide_traffic_lights(win);
}

#[cfg(target_os = "macos")]
fn hide_traffic_lights(win: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    // objc2 replaces cocoa::base::{id, YES}
    use objc2::msg_send;
    use objc2::runtime::{AnyObject, Bool};

    unsafe {
        // AppKit NSWindowButton:
        // 0 = close, 1 = minimize, 2 = zoom
        const NS_WINDOW_CLOSE: i64 = 0;
        const NS_WINDOW_MINIMIZE: i64 = 1;
        const NS_WINDOW_ZOOM: i64 = 2;

        let Ok(handle) = win.window_handle() else {
            return;
        };
        let RawWindowHandle::AppKit(h) = handle.as_raw() else {
            return;
        };

        // raw_window_handle gives us an NSView*
        let ns_view: *mut AnyObject = h.ns_view.as_ptr().cast();
        if ns_view.is_null() {
            return;
        }

        // NSWindow* ns_win = [ns_view window];
        let ns_win: *mut AnyObject = msg_send![ns_view, window];
        if ns_win.is_null() {
            return;
        }

        // NSWindowStyleMaskFullSizeContentView = 1 << 15 (0x8000)
        const NSWINDOW_STYLE_MASK_FULL_SIZE_CONTENT_VIEW: u64 = 1 << 15;

        let style_mask: u64 = msg_send![ns_win, styleMask];
        let new_mask: u64 = style_mask | NSWINDOW_STYLE_MASK_FULL_SIZE_CONTENT_VIEW;
        let _: () = msg_send![ns_win, setStyleMask: new_mask];

        let _: () = msg_send![ns_win, setMovableByWindowBackground: Bool::YES];

        let close_btn: *mut AnyObject = msg_send![ns_win, standardWindowButton: NS_WINDOW_CLOSE];
        let mini_btn: *mut AnyObject = msg_send![ns_win, standardWindowButton: NS_WINDOW_MINIMIZE];
        let zoom_btn: *mut AnyObject = msg_send![ns_win, standardWindowButton: NS_WINDOW_ZOOM];

        if !close_btn.is_null() {
            let _: () = msg_send![close_btn, setHidden: Bool::YES];
        }
        if !mini_btn.is_null() {
            let _: () = msg_send![mini_btn, setHidden: Bool::YES];
        }
        if !zoom_btn.is_null() {
            let _: () = msg_send![zoom_btn, setHidden: Bool::YES];
        }

        // Optional: clean overlay titlebar
        // NSWindowTitleVisibilityHidden = 1
        let _: () = msg_send![ns_win, setTitleVisibility: 1i64];
        let _: () = msg_send![ns_win, setTitlebarAppearsTransparent: Bool::YES];
    }
}

#[cfg(target_os = "windows")]
fn windows_apply(win: &tauri::WebviewWindow) {
    force_rounded_corners(win);
}

#[cfg(target_os = "windows")]
fn force_rounded_corners(win: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    // Windows 11 DWM corner preference
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;

    let Ok(handle) = win.window_handle() else {
        return;
    };
    let RawWindowHandle::Win32(h) = handle.as_raw() else {
        return;
    };

    let hwnd_isize = h.hwnd.get() as isize;

    unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};

        let hwnd = HWND(hwnd_isize);
        let pref: u32 = DWMWCP_ROUND;

        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(DWMWA_WINDOW_CORNER_PREFERENCE as i32),
            &pref as *const _ as _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}
