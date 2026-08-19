// PI Agent · 自定义标题栏窗口控制命令（decorations:false 后替代系统标题栏按钮）。
use tauri::{AppHandle, Manager};

/// 最小化主窗口
#[tauri::command]
pub fn win_minimize(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("主窗口不存在")?;
    win.minimize().map_err(|e| e.to_string())
}

/// 最大化/还原主窗口（切换）
#[tauri::command]
pub fn win_maximize(app: AppHandle) -> Result<bool, String> {
    let win = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let is_max = win.is_maximized().map_err(|e| e.to_string())?;
    if is_max {
        win.unmaximize().map_err(|e| e.to_string())?;
    } else {
        win.maximize().map_err(|e| e.to_string())?;
    }
    Ok(!is_max)
}

/// 关闭主窗口（退出应用）
#[tauri::command]
pub fn win_close(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("主窗口不存在")?;
    win.close().map_err(|e| e.to_string())
}

/// 是否处于最大化（前端同步按钮状态）
#[tauri::command]
pub fn win_is_maximized(app: AppHandle) -> Result<bool, String> {
    let win = app.get_webview_window("main").ok_or("主窗口不存在")?;
    win.is_maximized().map_err(|e| e.to_string())
}
