// PI Agent · Tauri 入口
mod pet;
mod pi_bridge;
mod window_cmd;

use pi_bridge::PiBridge;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let action = match shortcut.key {
                        Code::Equal => "zoom-in",
                        Code::Minus => "zoom-out",
                        Code::Digit0 => "zoom-reset",
                        _ => return,
                    };
                    // 仅当主窗口聚焦时响应（后台时忽略，避免误缩放）
                    if let Some(w) = app.get_webview_window("main") {
                        if w.is_focused().unwrap_or(false) {
                            let _ = app.emit("pi:zoom-shortcut", action);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let bridge = PiBridge::spawn(app.handle())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(bridge);
            println!("[pi-bridge] sidecar 已启动");

            // 界面缩放快捷键：WebView2 会吃掉 Ctrl+±/0（浏览器加速键），网页收不到 keydown，
            // 故改用系统级注册；窗口聚焦时注册、失焦注销，避免劫持其他应用的同名快捷键。
            let handle = app.handle().clone();
            let shortcuts = [
                Shortcut::new(Some(Modifiers::CONTROL), Code::Equal),                 // Ctrl+=
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Equal), // Ctrl+Shift+=
                Shortcut::new(Some(Modifiers::CONTROL), Code::Minus),                 // Ctrl+-
                Shortcut::new(Some(Modifiers::CONTROL), Code::Digit0),                // Ctrl+0
            ];
            if let Some(window) = handle.get_webview_window("main") {
                // 初始注册（窗口创建后通常处于聚焦状态；后续由 Focused 事件管理）
                for sc in &shortcuts {
                    let _ = handle.global_shortcut().register(sc.clone());
                }
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        let gs = handle.global_shortcut();
                        for sc in &shortcuts {
                            if *focused {
                                let _ = gs.register(sc.clone());
                            } else {
                                let _ = gs.unregister(sc.clone());
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi_bridge::pi_send,
            pi_bridge::pi_bridge_ready,
            pi_bridge::log_from_webview,
            pet::pet_toggle,
            pet::pet_event,
            window_cmd::win_minimize,
            window_cmd::win_maximize,
            window_cmd::win_close,
            window_cmd::win_is_maximized,
            window_cmd::write_text_file,
            window_cmd::open_devtools,
            window_cmd::win_new,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}