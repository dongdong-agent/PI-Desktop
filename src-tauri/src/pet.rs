// PI Agent · 桌面宠物窗口（差异化占位）
// 独立小窗口：无边框、透明背景、置顶；内容 = 宠物页面（HTML/CSS 动画角色）。
// 接口：前端经 pet_toggle 开关；前端经 pet_event 驱动行为（busy/think/done 状态）。
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 向宠物窗口广播行为状态事件（busy=忙碌转圈 / think=思考 / done=空闲眨眼）
#[tauri::command]
pub async fn pet_event(app: AppHandle, state: String) -> Result<(), String> {
    // 仅当宠物窗口存在时广播（避免无谓 IPC）
    if app.get_webview_window("pet").is_some() {
        let _ = app.emit("pet_event", state.as_str());
    }
    Ok(())
}

/// 创建/聚焦宠物窗口；visible=false 时关闭它
#[tauri::command]
pub async fn pet_toggle(app: AppHandle, visible: bool) -> Result<bool, String> {
    let label = "pet";
    if !visible {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.close();
        }
        return Ok(false);
    }

    // 已存在则聚焦返回
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.set_focus();
        return Ok(true);
    }

    let win = WebviewWindowBuilder::new(&app, label, WebviewUrl::App("pet.html".into()))
        .title("宠物")
        .inner_size(140.0, 140.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("创建宠物窗口失败: {e}"))?;

    // 放到右下角
    if let Some(monitor) = app.primary_monitor().map_err(|e| e.to_string())? {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let w = 140.0 * scale;
        let h = 140.0 * scale;
        let x = (size.width as f64) - w - 48.0 * scale;
        let y = (size.height as f64) - h - 80.0 * scale;
        let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    }

    Ok(true)
}