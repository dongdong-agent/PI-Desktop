// PI Agent · Tauri 入口
mod pet;
mod pi_bridge;
mod window_cmd;

use pi_bridge::PiBridge;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 显示/切换主窗口（托盘点击 / 全局呼出）
fn toggle_main(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 显式呼出（全局快捷键：无论窗口是否可见都显示并聚焦）
fn show_main(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

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
                        // 全局呼出：Ctrl+Alt+P（始终生效）
                        Code::KeyP
                            if shortcut.mods.contains(Modifiers::CONTROL)
                                && shortcut.mods.contains(Modifiers::ALT) =>
                        {
                            show_main(app);
                            return;
                        }
                        // 应用内快捷键（仅窗口聚焦时生效，经 focus 注册管理）
                        Code::KeyK if shortcut.mods.contains(Modifiers::CONTROL) => "focus-input",
                        Code::KeyN if shortcut.mods.contains(Modifiers::CONTROL) => "new-session",
                        Code::KeyF if shortcut.mods.contains(Modifiers::CONTROL) => "focus-search",
                        _ => return,
                    };
                    let _ = app.emit("pi:hotkey", action);
                })
                .build(),
        )
        .setup(|app| {
            // 内核升级：若存在校验过的 pi-package.new（sidecar download_pi_update 产出），
            // 启动时替换为 pi-package（旧包备份为 pi-package.bak，失败可回滚）
            if let Ok(resource_dir) = app.path().resource_dir() {
                let mut rd = resource_dir.clone();
                #[cfg(windows)]
                {
                    let s = rd.to_string_lossy().to_string();
                    if let Some(stripped) = s.strip_prefix(r"\\?\") {
                        rd = std::path::PathBuf::from(stripped);
                    }
                }
                let new_dir = rd.join("resources/pi-package.new");
                let pkg_dir = rd.join("resources/pi-package");
                let bak_dir = rd.join("resources/pi-package.bak");
                let new_dist = new_dir.join("dist/index.js");
                if new_dist.exists() {
                    let _ = std::fs::remove_dir_all(&bak_dir);
                    if pkg_dir.exists() {
                        let _ = std::fs::rename(&pkg_dir, &bak_dir);
                    }
                    match std::fs::rename(&new_dir, &pkg_dir) {
                        Ok(()) => {
                            let _ = std::fs::remove_dir_all(&bak_dir);
                            println!("[pi-bridge] PI 内核已升级（pi-package.new → pi-package）");
                        }
                        Err(e) => {
                            // 回滚
                            if !pkg_dir.exists() && bak_dir.exists() {
                                let _ = std::fs::rename(&bak_dir, &pkg_dir);
                            }
                            println!("[pi-bridge] 内核升级失败并回滚: {e}");
                        }
                    }
                }
            }

            // 系统托盘：左键单击显示/隐藏，菜单含显示/退出
            if let Ok(show_item) = MenuItem::with_id(app.handle(), "show", "显示 / 隐藏", true, None::<&str>) {
                if let Ok(quit_item) = MenuItem::with_id(app.handle(), "quit", "退出", true, None::<&str>) {
                    if let Ok(menu) = Menu::with_items(app.handle(), &[&show_item, &quit_item]) {
                        let _ = TrayIconBuilder::with_id("main-tray")
                            .icon(app.default_window_icon().unwrap().clone())
                            .tooltip("PI Agent")
                            .menu(&menu)
                            .show_menu_on_left_click(false)
                            .on_menu_event(|app, event| match event.id.as_ref() {
                                "show" => show_main(app),
                                "quit" => app.exit(0),
                                _ => {}
                            })
                            .on_tray_icon_event(|tray, event| {
                                if let TrayIconEvent::Click {
                                    button: MouseButton::Left,
                                    button_state: MouseButtonState::Up,
                                    ..
                                } = event
                                {
                                    toggle_main(tray.app_handle());
                                }
                            })
                            .build(app.handle());
                    }
                }
            }

            // 全局呼出快捷键（Ctrl+Alt+P）——常驻注册，后台也能唤出
            let _ = app.handle().global_shortcut().register(
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyP),
            );

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
                Shortcut::new(Some(Modifiers::CONTROL), Code::KeyK),                  // Ctrl+K 聚焦输入
                Shortcut::new(Some(Modifiers::CONTROL), Code::KeyN),                  // Ctrl+N 新建会话
                Shortcut::new(Some(Modifiers::CONTROL), Code::KeyF),                  // Ctrl+F 聚焦搜索
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