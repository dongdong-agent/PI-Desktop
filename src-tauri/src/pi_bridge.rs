/**
 * PI Bridge：Tauri 侧的子进程桥（带监督循环）。
 * 职责：spawn Node sidecar（真 PI 驱动层），stdin 写入指令（JSONL），
 *       stdout 事件逐行转发为 Tauri 事件给前端；
 *       监督线程监控 sidecar 退出 → 通知前端 → 自动重启并重接线。
 */
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 下隐藏子进程控制台窗口（GUI 主进程 spawn 控制台型 node 子进程时，
/// 若不设此标志，每次启动都会弹出一个黑色终端窗口）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use tauri::{AppHandle, Emitter, Manager};

pub struct PiBridge {
    /// 当前代理 sidecar 的 stdin（respawn 后替换为新代）
    stdin: Arc<Mutex<Option<ChildStdin>>>,
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
    if let Ok(resource_dir) = app.path().resource_dir() {
        let rd = clean_path(resource_dir);
        for rel in ["resources/drivers/sidecar/sidecar.mjs", "drivers/sidecar/sidecar.mjs"] {
            let candidate = rd.join(rel);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    if let Ok(p) = std::env::var("PI_GUI_SIDECAR") {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return Ok(pb);
        }
        return Err(format!("PI_GUI_SIDECAR 指向不存在的文件: {p}"));
    }
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
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let local = manifest.join("resources/node-win-x64/node.exe");
    if local.exists() {
        return Ok(local);
    }
    Ok(PathBuf::from("node"))
}

impl PiBridge {
    pub fn spawn(app: &AppHandle) -> Result<Self, String> {
        bridge_log(app, "[spawn] begin");
        let stdin: Arc<Mutex<Option<ChildStdin>>> = Arc::new(Mutex::new(None));
        let started = Arc::new(AtomicBool::new(false));

        // 事件通道：stdout 读线程 → emit 线程 → 前端（对全代 sidecar 生效，respawn 复用同一 channel）
        let (tx, rx) = mpsc::channel::<String>();
        let app2 = app.clone();
        std::thread::spawn(move || {
            while let Ok(line) = rx.recv() {
                let _ = app2.emit("pi_event", line);
            }
        });

        // 首代启动（后续重启由监督线程负责）
        let bridge = Self {
            stdin: stdin.clone(),
        };
        bridge.spawn_generation(app, stdin, started, tx)?;
        Ok(bridge)
    }

    /// 启动一代 sidecar：spawn 子进程 → 接线 stdin/stdout/stderr → 起观察线程
    fn spawn_generation(
        &self,
        app: &AppHandle,
        stdin_slot: Arc<Mutex<Option<ChildStdin>>>,
        started: Arc<AtomicBool>,
        tx: mpsc::Sender<String>,
    ) -> Result<(), String> {
        bridge_log(app, "[gen] spawn begin");
        let sidecar = sidecar_path(app)?;
        let node = node_path(app)?;
        bridge_log(app, &format!("[gen] sidecar={:?} node={:?}", sidecar, node));

        let mut cmd = Command::new(&node);
        cmd.arg(&sidecar)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(resource_dir) = app.path().resource_dir() {
            let rd = clean_path(resource_dir);
            let pi_dist = rd.join("resources/pi-package/dist/index.js");
            if pi_dist.exists() {
                cmd.env("PI_GUI_PI_DIST", &pi_dist);
            }
            cmd.env("PI_GUI_RESOURCE_DIR", &rd);
        }

        let mut child = cmd.spawn().map_err(|e| {
            bridge_log(app, &format!("[gen] spawn FAIL {e}"));
            format!("spawn sidecar 失败（node: {node:?}）: {e}")
        })?;
        let pid = child.id();
        bridge_log(app, &format!("[gen] ok pid={pid} early_exit={:?}", child.try_wait().ok().flatten()));

        let stdin = child.stdin.take().ok_or("sidecar stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout 不可用")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr 不可用")?;

        // 当前代 stdin 生效
        *stdin_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(stdin);
        started.store(true, Ordering::SeqCst);

        // stdout 转发（过滤非 JSON 行）
        let tx2 = tx.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if serde_json::from_str::<serde_json::Value>(&l).is_err() {
                            println!("[sidecar-stdout-ignored] {l}");
                            continue;
                        }
                        if tx2.send(l).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx2.send(format!(r#"{{"type":"bridge_error","error":"stdout: {e}"}}"#));
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

        // 观察线程：sidecar 退出 → 通知前端 → 自动重启（最多重试，避免死循环）
        let app2 = app.clone();
        let stdin_slot2 = stdin_slot.clone();
        let started2 = started.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            bridge_log(&app2, &format!("[gen] pid={pid} exited: {status:?}"));
            let _ = app2.emit(
                "pi_bridge_event",
                serde_json::json!({
                    "type": "sidecar_exit",
                    "pid": pid,
                })
                .to_string(),
            );
            // 稍等再重启，避免极小概率的快速崩溃风暴；每代失败会继续重启
            std::thread::sleep(std::time::Duration::from_millis(800));
            let started_was = started2.load(Ordering::SeqCst);
            match Self::spawn_generation_standalone(&app2, stdin_slot2, started2, tx) {
                Ok(pid2) => {
                    bridge_log(&app2, &format!("[gen] respawned pid={pid2}"));
                    let _ = app2.emit(
                        "pi_bridge_event",
                        serde_json::json!({
                            "type": "sidecar_start",
                            "pid": pid2,
                            "restart": started_was,
                        })
                        .to_string(),
                    );
                }
                Err(e) => {
                    bridge_log(&app2, &format!("[gen] respawn FAIL: {e}"));
                    let _ = app2.emit(
                        "pi_bridge_event",
                        serde_json::json!({
                            "type": "sidecar_error",
                            "error": e,
                        })
                        .to_string(),
                    );
                }
            }
        });

        // 启动即发 open_dialogue（recent）：保证 sidecar 立即就绪（等价旧 boot init）
        let default_cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let boot = serde_json::json!({
            "type": "open_dialogue",
            "requestId": "boot-init",
            "cwd": std::env::var("PI_GUI_CWD").unwrap_or(default_cwd),
            "sessionMode": std::env::var("PI_GUI_SESSION_MODE").unwrap_or_else(|_| "recent".into()),
        });
        self.send(&boot.to_string())?;
        Ok(())
    }

    /// 监督线程内重启用：与 spawn_generation 相同的 spawn 逻辑，但不需要 self
    fn spawn_generation_standalone(
        app: &AppHandle,
        stdin_slot: Arc<Mutex<Option<ChildStdin>>>,
        started: Arc<AtomicBool>,
        tx: mpsc::Sender<String>,
    ) -> Result<u32, String> {
        let sidecar = sidecar_path(app)?;
        let node = node_path(app)?;
        let mut cmd = Command::new(&node);
        cmd.arg(&sidecar)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(resource_dir) = app.path().resource_dir() {
            let rd = clean_path(resource_dir);
            let pi_dist = rd.join("resources/pi-package/dist/index.js");
            if pi_dist.exists() {
                cmd.env("PI_GUI_PI_DIST", &pi_dist);
            }
            cmd.env("PI_GUI_RESOURCE_DIR", &rd);
        }
        let mut child = cmd.spawn().map_err(|e| format!("respawn sidecar 失败: {e}"))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("sidecar stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout 不可用")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr 不可用")?;
        *stdin_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(stdin);
        started.store(true, Ordering::SeqCst);

        let tx2 = tx.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if serde_json::from_str::<serde_json::Value>(&l).is_err() {
                            println!("[sidecar-stdout-ignored] {l}");
                            continue;
                        }
                        if tx2.send(l).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx2.send(format!(r#"{{"type":"bridge_error","error":"stdout: {e}"}}"#));
                        break;
                    }
                }
            }
        });
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                println!("[pi-sidecar] {line}");
            }
        });

        // 这一代的观察线程也要继续监督（退出再重启）
        let app3 = app.clone();
        let stdin_slot3 = stdin_slot.clone();
        let started3 = started.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            bridge_log(&app3, &format!("[gen] pid={pid} exited: {status:?}"));
            let _ = app3.emit(
                "pi_bridge_event",
                serde_json::json!({ "type": "sidecar_exit", "pid": pid }).to_string(),
            );
            std::thread::sleep(std::time::Duration::from_millis(800));
            let started_was = started3.load(Ordering::SeqCst);
            match Self::spawn_generation_standalone(&app3, stdin_slot3, started3, tx) {
                Ok(pid2) => {
                    bridge_log(&app3, &format!("[gen] respawned pid={pid2}"));
                    let _ = app3.emit(
                        "pi_bridge_event",
                        serde_json::json!({
                            "type": "sidecar_start",
                            "pid": pid2,
                            "restart": started_was,
                        })
                        .to_string(),
                    );
                }
                Err(e) => {
                    bridge_log(&app3, &format!("[gen] respawn FAIL: {e}"));
                    let _ = app3.emit(
                        "pi_bridge_event",
                        serde_json::json!({ "type": "sidecar_error", "error": e }).to_string(),
                    );
                }
            }
        });

        // boot open_dialogue
        let default_cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let boot = serde_json::json!({
            "type": "open_dialogue",
            "requestId": "boot-restart",
            "cwd": std::env::var("PI_GUI_CWD").unwrap_or(default_cwd),
            "sessionMode": std::env::var("PI_GUI_SESSION_MODE").unwrap_or_else(|_| "recent".into()),
        });
        if let Some(stdin) = stdin_slot.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = writeln!(stdin, "{}", boot.to_string());
        }
        Ok(pid)
    }

    pub fn send(&self, line: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().map_err(|_| "sidecar stdin lock poisoned")?;
        match guard.as_mut() {
            Some(stdin) => writeln!(stdin, "{line}").map_err(|e| format!("写 sidecar stdin 失败: {e}")),
            None => Err("sidecar 未启动".into()),
        }
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
    let _ = state;
    true
}

/// WebView 日志转发
#[tauri::command]
pub fn log_from_webview(level: String, message: String) {
    println!("[webview:{level}] {message}");
}