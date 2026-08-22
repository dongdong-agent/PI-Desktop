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

/// 写文本文件（保存对话结果 / 导出文档用），自动创建父目录。
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    std::fs::write(&path, content).map_err(|e| format!("写入失败: {e}"))
}

/// 打开开发者工具（F12 调试）
#[tauri::command]
pub fn open_devtools(app: AppHandle) -> Result<(), String> {
    let wv = app.get_webview("main").ok_or("主窗口不存在")?;
    wv.open_devtools();
    Ok(())
}

/// 新建窗口：干净启动（?fresh=1，前端据此跳过“上次项目/会话”恢复），方便新建工作区或打开新项目。
#[tauri::command]
pub fn win_new(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("new").is_some() {
        return Ok(()); // 已存在则复用，避免同 label 冲突
    }
    let label = "new";
    // 新窗口 = 新工作区：带唯一 ws id（前端据此隔离项目/对话/对话池的本地存储）
    let ws_id = format!("{}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis()).unwrap_or(0), std::process::id());
    let _w = tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(format!("index.html?fresh=1&ws={ws_id}").into()),
    )
    .title("PI Agent")
    .inner_size(1080.0, 720.0)
    .min_inner_size(900.0, 600.0)
    .decorations(false)
    .transparent(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
