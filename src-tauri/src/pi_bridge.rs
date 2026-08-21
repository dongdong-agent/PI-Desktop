/**
 * PI Bridge：Tauri 侧的子进程桥。
 * 职责：spawn Node sidecar（真 PI 驱动层），
 *       stdin 写入指令（JSONL），stdout 事件逐行转发为 Tauri 事件给前端，
 *       前端指令经 invoke 进入这里。
 */
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 下隐藏子进程控制台窗口（GUI 主进程 spawn 控制台型 node 子进程时，
/// 若不设此标志，每次启动都会弹出一个黑色终端窗口）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

pub struct PiBridge {
    _child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
}

/// 诊断日志：写到应用资源目录同级的 pi-bridge.log（安装根可写，per-user）
fn bridge_log(app: &AppHandle, line: &str) {
    let dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(_) => std::env::temp_dir(),
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let p = dir.join("pi-bridge.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{line}");
    }
}

/// 去掉 Windows verbatim 路径前缀（\\?\），否则 sidecar 用 pathToFileURL + import 无法解析 PI_GUI_PI_DIST。
fn clean_path(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    p
}

/// 定位 sidecar 脚本：资源目录（安装版）> 环境变量 > 项目 drivers/sidecar/sidecar.mjs（开发版）
fn sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    // 1) 安装版：从打包资源解析（bundle.resources 已包含 sidecar.mjs，位于 resources/drivers/…）
    if let Ok(resource_dir) = app.path().resource_dir() {
        let rd = clean_path(resource_dir);
        for rel in ["resources/drivers/sidecar/sidecar.mjs", "drivers/sidecar/sidecar.mjs"] {
            let candidate = rd.join(rel);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    // 2) 显式环境变量
    if let Ok(p) = std::env::var("PI_GUI_SIDECAR") {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return Ok(pb);
        }
        return Err(format!("PI_GUI_SIDECAR 指向不存在的文件: {p}"));
    }
    // 3) 开发版：项目相对路径
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest.parent().unwrap_or(&manifest);
    let candidate = project_root.join("drivers").join("sidecar").join("sidecar.mjs");
    if candidate.exists() {
        Ok(candidate)
    } else {
        Err(format!("sidecar 不存在: {:?}（请设置 PI_GUI_SIDECAR）", candidate))
    }
}

/// 定位捆绑的 Node runtime：资源目录 node-win-x64/node.exe > 系统 node
fn node_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let rd = clean_path(resource_dir);
        let bundled = rd.join("resources/node-win-x64/node.exe");
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    // 开发版：项目内资源目录
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let local = manifest.join("resources/node-win-x64/node.exe");
    if local.exists() {
        return Ok(local);
    }
    Ok(PathBuf::from("node")) // fallback 系统 node
}

impl PiBridge {
    pub fn spawn(app: &AppHandle) -> Result<Self, String> {
        bridge_log(app, "[spawn] begin");
        bridge_log(app, &format!("[spawn] resource_dir={:?}", app.path().resource_dir()));
        let sidecar = sidecar_path(app)?;
        let node = node_path(app)?;
        bridge_log(app, &format!("[spawn] sidecar={:?} node={:?}", sidecar, node));
        bridge_log(app, &format!("[spawn] env PI_GUI_SIDECAR={:?} PI_GUI_PI_DIST={:?} PI_GUI_RESOURCE_DIR={:?}",
            std::env::var("PI_GUI_SIDECAR").ok(),
            std::env::var("PI_GUI_PI_DIST").ok(),
            std::env::var("PI_GUI_RESOURCE_DIR").ok()));

        // 传给 sidecar 的资源定位（捆绑的 pi 包 / 资源目录）
        let mut cmd = Command::new(&node);
        cmd.arg(&sidecar)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // 隐藏 sidecar 控制台窗口，静默启动（不弹黑窗）
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(resource_dir) = app.path().resource_dir() {
            let rd = clean_path(resource_dir);
            bridge_log(app, &format!("[spawn] rd(clean)={:?}", rd));
            // 捆绑 pi 包：PI_GUI_PI_DIST 指向资源里的 dist/index.js
            let pi_dist = rd.join("resources/pi-package/dist/index.js");
            bridge_log(app, &format!("[spawn] pi_dist={:?} exists={}", pi_dist, pi_dist.exists()));
            if pi_dist.exists() {
                cmd.env("PI_GUI_PI_DIST", &pi_dist);
            }
            cmd.env("PI_GUI_RESOURCE_DIR", &rd);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| { bridge_log(app, &format!("[spawn] FAIL {e}")); format!("spawn sidecar 失败（node: {node:?}）: {e}") })?;
        bridge_log(app, &format!("[spawn] ok pid={:?} early_exit={:?}", child.id(), child.try_wait().ok().flatten()));

        let stdin = child.stdin.take().ok_or("sidecar stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout 不可用")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr 不可用")?;

        // 通道：stdout 读线程 → 事件 emit 线程 → 前端
        let (tx, rx) = mpsc::channel::<String>();
        let app2 = app.clone();
        std::thread::spawn(move || {
            while let Ok(line) = rx.recv() {
                let _ = app2.emit("pi_event", line);
            }
        });

        // stdout 逐行转发；只转发合法 JSON 行，过滤 pi 内部杂讯（如 "[pi-reasonix] Loaded…"）
        let tx2 = tx.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if serde_json::from_str::<serde_json::Value>(&l).is_err() {
                            // 非 JSON 行（pi 包 console 杂讯）直接丢弃，不污染事件流
                            println!("[sidecar-stdout-ignored] {l}");
                            continue;
                        }
                        if tx2.send(l).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx2.send(
                            format!(r#"{{"type":"bridge_error","error":"stdout: {e}"}}"#),
                        );
                        break;
                    }
                }
            }
        });

        // stderr 打日志（仅排查用）
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                println!("[pi-sidecar] {line}");
            }
        });

        let bridge = Self {
            _child: Mutex::new(child),
            stdin: Mutex::new(stdin),
        };

        // 启动即发 init：默认恢复最近的会话（fallback 新会话）
        // 启动即发 init：默认恢复最近的会话（fallback 新会话）
        let default_cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let init = serde_json::json!({
            "type": "init",
            "requestId": "boot-init",
            "cwd": std::env::var("PI_GUI_CWD").unwrap_or(default_cwd),
            "sessionMode": std::env::var("PI_GUI_SESSION_MODE").unwrap_or_else(|_| "recent".into()),
        });
        bridge.send(&init.to_string())?;

        Ok(bridge)
    }

    pub fn send(&self, line: &str) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "sidecar stdin lock poisoned")?;
        writeln!(stdin, "{line}").map_err(|e| format!("写 sidecar stdin 失败: {e}"))
    }
}

/// 前端 → sidecar：一整行 JSON 指令
#[tauri::command]
pub fn pi_send(state: tauri::State<'_, PiBridge>, line: String) -> Result<(), String> {
    state.send(&line)
}

/// 前端查询桥状态（sidecar 是否已建好）
#[tauri::command]
pub fn pi_bridge_ready(state: tauri::State<'_, PiBridge>) -> bool {
    let _ = state; // 只要能取到 state 就说明桥已初始化
    true
}

/// WebView 日志转发（供前端 console/错误打到 tauri 日志，便于排查）
#[tauri::command]
pub fn log_from_webview(level: String, message: String) {
    println!("[webview:{level}] {message}");
}