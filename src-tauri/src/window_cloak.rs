//! Keeps the hidden main window out of desktop composition on Windows until the renderer reveals
//! it.
//!
//! The window-state plugin restores a saved maximized state while the main window is still
//! hidden. On Windows tao implements that maximize with `ShowWindow(SW_MAXIMIZE)`, which shows and
//! activates a hidden window before tao hides it again, so the empty window appeared for a moment
//! on every maximized start. Every tao maximize path, including the builder's own `maximized`
//! attribute, goes through the same call, so no ordering of tao calls avoids it. A DWM-cloaked
//! window keeps its Win32 state (shown, maximized, focused) but is not drawn, so the main window is
//! cloaked as soon as it exists — before the window-state plugin's `on_window_ready` restores it —
//! and uncloaked at the reveal. Linux and macOS do not take this path; the functions are no-ops
//! there.

use tauri::plugin::TauriPlugin;
use tauri::Runtime;

/// The label of the one window that is cloaked at creation and uncloaked at its reveal.
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

/// Cloaks the main window as it is created. Must be registered before the window-state plugin:
/// plugins' window-ready hooks run in registration order.
pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("main-window-cloak")
        .on_window_ready(|window| {
            if window.label() == MAIN_WINDOW_LABEL {
                set_cloaked(&window, true);
            }
        })
        .build()
}

/// Lets the main window be drawn again. Called before every reveal, so a reveal retried after a
/// failed show uncloaks again; uncloaking a window that is not cloaked is a no-op.
pub(crate) fn uncloak<R: Runtime>(window: &tauri::Window<R>) {
    set_cloaked(window, false);
}

/// Best effort in both directions, logged on failure. A failed cloak leaves the old brief
/// appearance; a failed uncloak cannot be retried to better effect, and the show that follows
/// must still happen, because a window that was never cloaked has to appear.
#[cfg(windows)]
fn set_cloaked<R: Runtime>(window: &tauri::Window<R>, cloaked: bool) {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};

    let hwnd: HWND = match window.hwnd() {
        Ok(hwnd) => hwnd.0,
        Err(error) => {
            log::warn!(
                "could not get the main window handle to set its cloak to {cloaked}: {error:?}"
            );
            return;
        }
    };
    let value = BOOL::from(cloaked);
    // SAFETY: `hwnd` comes from the live tauri window, and the attribute pointer and size describe
    // the local `BOOL` for the duration of the call; DWM does not retain the pointer.
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK as u32,
            (&value as *const BOOL).cast(),
            std::mem::size_of::<BOOL>() as u32,
        )
    };
    if result < 0 {
        log::warn!(
            "DwmSetWindowAttribute(DWMWA_CLOAK, {cloaked}) failed with HRESULT {result:#010x}"
        );
    }
}

#[cfg(not(windows))]
fn set_cloaked<R: Runtime>(_window: &tauri::Window<R>, _cloaked: bool) {}
