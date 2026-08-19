/**
 * 全局错误/日志转发：WebView 的 console 与未捕获错误 → Rust 日志（排查白屏等）
 */
import { invoke } from "@tauri-apps/api/core";

const LOG_KEY = "__pi_gui_log_hooked";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function toRust(level: string, message: string) {
  if (!isTauri()) {
    // 浏览器环境：直接打到 console
    if (level === "error") console.error("[webview]", message);
    else console.log("[webview]", message);
    return;
  }
  try {
    void invoke("log_from_webview", { level, message });
  } catch {
    /* 转发失败不影响运行 */
  }
}

/** 挂载一次（幂等） */
export function installGlobalErrorHooks(): void {
  if ((window as any)[LOG_KEY]) return;
  (window as any)[LOG_KEY] = true;

  window.addEventListener("error", (e) => {
    toRust("error", `[uncaught] ${e.message} @ ${e.filename}:${e.lineno}`);
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason =
      e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ""}` : String(e.reason);
    toRust("error", `[unhandledrejection] ${reason}`);
  });

  // console 转发（防止无限循环：只转发真实输出）
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    origError(...args);
    toRust("error", args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    toRust("warn", args.map(String).join(" "));
  };
}