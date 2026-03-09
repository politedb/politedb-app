// macOS needs objc macros in THIS module (because msg_send! is used here).
use tauri::Manager;

pub fn apply(app: &tauri::App) {
    let win = get_main_webview_window(app);

    #[cfg(target_os = "macos")]
    macos_apply(&win);

    #[cfg(target_os = "windows")]
    windows_apply(&win);

    // Linux: no-op (WM/compositor dependent)
    #[cfg(target_os = "linux")]
    linux_apply(&win);
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
    // pass 1: immediate
    macos_tune_titlebar(win);

    // pass 2: after layout (must be on main thread)
    let win2 = win.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(160)).await;

        // IMPORTANT: AppKit calls should run on main thread
        let win3 = win2.clone();
        let _ = win2.run_on_main_thread(move || {
            macos_tune_titlebar(&win3);
        });
    });
}

#[cfg(target_os = "macos")]
fn macos_tune_titlebar(win: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    use objc2::msg_send;
    use objc2::runtime::{AnyObject, Bool};

    unsafe {
        // AppKit NSWindowButton:

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

        // IMPORTANT: don't allow dragging anywhere
        let _: () = msg_send![ns_win, setMovableByWindowBackground: Bool::NO];

        // ✅ Move the *container* of traffic lights (more stable than moving each button)
        offset_traffic_lights_container(ns_win, -2.0);

        // Optional: clean overlay titlebar
        // NSWindowTitleVisibilityHidden = 1
        let _: () = msg_send![ns_win, setTitleVisibility: 1i64];
        let _: () = msg_send![ns_win, setTitlebarAppearsTransparent: Bool::YES];
    }
}

#[cfg(target_os = "macos")]
unsafe fn offset_traffic_lights_container(ns_win: *mut objc2::runtime::AnyObject, dy: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSPoint, NSRect};

    const NS_WINDOW_CLOSE: i64 = 0;

    // 1) Get close button (exists if decorations enabled)
    let close_btn: *mut AnyObject = msg_send![ns_win, standardWindowButton: NS_WINDOW_CLOSE];
    if close_btn.is_null() {
        tracing::warn!("traffic_lights: close button is null");

        return;
    }

    // 2) Superview of close button usually hosts the 3 traffic lights
    let container: *mut AnyObject = msg_send![close_btn, superview];
    if container.is_null() {
        tracing::warn!("traffic_lights: container(superview) is null");

        return;
    }

    // 3) Move container frame origin Y by dy
    let frame_before: NSRect = msg_send![container, frame];

    // Try moving DOWN by dy. If you still don't see it, try dy = +2.0
    let new_origin = NSPoint::new(frame_before.origin.x, frame_before.origin.y + dy);
    let _: () = msg_send![container, setFrameOrigin: new_origin];

    let frame_after: NSRect = msg_send![container, frame];

    tracing::info!(
        "traffic_lights: moved container y {} -> {} (dy={})",
        frame_before.origin.y,
        frame_after.origin.y,
        dy
    );

    let _: () = msg_send![container, setNeedsLayout: objc2::runtime::Bool::YES];
    let _: () = msg_send![container, layoutSubtreeIfNeeded];
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

        let hwnd = HWND(hwnd_isize as *mut std::ffi::c_void);
        let pref: u32 = DWMWCP_ROUND;

        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(DWMWA_WINDOW_CORNER_PREFERENCE as i32),
            &pref as *const _ as _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(target_os = "linux")]
fn linux_apply(_win: &tauri::WebviewWindow) {
    // Keep this hook explicit for Linux-specific tuning later.
    // Window chrome behavior depends on the WM/compositor.
}
