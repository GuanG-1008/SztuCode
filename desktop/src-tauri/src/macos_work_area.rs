//! macOS：无动画铺满/还原工作区，并拦截系统 zoom，避免 WKWebView 与窗口框不同步。

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::{sel, ClassType};
use objc2_app_kit::{NSScreen, NSWindow};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use tauri::WebviewWindow;

type FrameTuple = (f64, f64, f64, f64);

fn restore_frames() -> &'static Mutex<HashMap<usize, FrameTuple>> {
    static FRAMES: OnceLock<Mutex<HashMap<usize, FrameTuple>>> = OnceLock::new();
    FRAMES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn frame_to_tuple(frame: NSRect) -> FrameTuple {
    (
        frame.origin.x,
        frame.origin.y,
        frame.size.width,
        frame.size.height,
    )
}

fn tuple_to_frame(parts: FrameTuple) -> NSRect {
    NSRect {
        origin: NSPoint {
            x: parts.0,
            y: parts.1,
        },
        size: NSSize {
            width: parts.2,
            height: parts.3,
        },
    }
}

fn frames_near_equal(a: NSRect, b: NSRect) -> bool {
    const EPS: f64 = 2.0;
    (a.origin.x - b.origin.x).abs() < EPS
        && (a.origin.y - b.origin.y).abs() < EPS
        && (a.size.width - b.size.width).abs() < EPS
        && (a.size.height - b.size.height).abs() < EPS
}

fn window_key(ns_window: &NSWindow) -> usize {
    ns_window as *const NSWindow as usize
}

/// 无动画在 visibleFrame 与已保存 frame 之间切换。
pub fn toggle_ns_window(ns_window: &NSWindow) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(screen) = ns_window.screen().or_else(|| NSScreen::mainScreen(mtm)) else {
        return;
    };
    let visible = screen.visibleFrame();
    let current = ns_window.frame();
    let key = window_key(ns_window);
    let mut frames = restore_frames()
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    if frames_near_equal(current, visible) {
        if let Some(saved) = frames.remove(&key) {
            ns_window.setFrame_display_animate(tuple_to_frame(saved), true, false);
        }
        return;
    }

    frames.insert(key, frame_to_tuple(current));
    ns_window.setFrame_display_animate(visible, true, false);
}

/// 从 Tauri WebviewWindow 执行无动画 work-area 切换。
pub fn toggle_work_area(window: &WebviewWindow) -> Result<(), String> {
    let window_for_thread = window.clone();
    window
        .run_on_main_thread(move || {
            let Ok(ptr) = window_for_thread.ns_window() else {
                return;
            };
            if ptr.is_null() {
                return;
            }
            // SAFETY: ptr 来自 Tauri 主窗口的 ns_window，主线程上有效
            unsafe {
                let ns_window = &*(ptr as *const NSWindow);
                toggle_ns_window(ns_window);
            }
        })
        .map_err(|e| e.to_string())
}

/// 替换 -[NSWindow zoom:]，标题栏双击与绿色按钮都走无动画 fill。
unsafe extern "C-unwind" fn intercepted_zoom(
    this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) {
    if this.is_null() {
        return;
    }
    // SAFETY: zoom: 的 receiver 为 NSWindow
    let ns_window = unsafe { &*(this as *const NSWindow) };
    toggle_ns_window(ns_window);
}

static ZOOM_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

/// 安装 zoom: 拦截（进程内只装一次）。
pub fn install_zoom_intercept() {
    ZOOM_HOOK_INSTALLED.get_or_init(|| {
        // SAFETY: 替换 NSWindow 的 zoom: IMP，签名与原方法一致
        unsafe {
            let cls = NSWindow::class();
            if let Some(method) = cls.instance_method(sel!(zoom:)) {
                let imp: Imp = std::mem::transmute(intercepted_zoom as unsafe extern "C-unwind" fn(
                    *mut AnyObject,
                    Sel,
                    *mut AnyObject,
                ));
                let _ = method.set_implementation(imp);
            }
        }
    });
}
