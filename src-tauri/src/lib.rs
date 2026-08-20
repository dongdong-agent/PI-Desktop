// PI Agent · Tauri 入口
mod pet;
mod pi_bridge;
mod window_cmd;

use pi_bridge::PiBridge;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let bridge = PiBridge::spawn(app.handle())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(bridge);
            println!("[pi-bridge] sidecar 已启动");
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}