/**
 * 应用根组件：布局「侧栏 + 主区」。主区 = PI 会话视图（真实 PI 驱动）。
 * 带 ErrorBoundary：渲染崩溃时显示错误详情而不是白屏。
 */
import { Component, useEffect, type ReactNode } from "react";
import { applyTheme, loadTheme } from "./app/theme";
import { applyZoom, loadZoom, zoomIn, zoomOut, zoomReset } from "./app/zoom";
import { Sidebar } from "./ui/Sidebar";
import { PiChatView } from "./ui/PiChatView";
import { TitleBar } from "./ui/TitleBar";
import { usePiUiStore } from "./pi/piUiStore";
import "./styles.css";

/** 缩放快捷键：Ctrl/Cmd + - / + / 0（上下限与步进在 zoom.ts 定义）。
 * WebView2 会把 Ctrl+±/0 当浏览器加速键吃掉，网页收不到 keydown；
 * 故由 Rust 侧（global-shortcut 插件，窗口聚焦时注册）发 pi:zoom-shortcut 事件驱动。 */
function useZoomShortcut(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("pi:zoom-shortcut", (e) => {
          const a = e.payload;
          if (a === "zoom-in") zoomIn();
          else if (a === "zoom-out") zoomOut();
          else if (a === "zoom-reset") zoomReset();
        });
        if (disposed) unlisten();
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** F12 打开开发者工具（仅 Tauri 环境，便于调试） */
function useDevtoolsShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "F12") return;
      e.preventDefault();
      void (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("open_devtools");
        } catch {
          /* 非 Tauri 环境忽略 */
        }
      })();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[React] 渲染崩溃:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", fontSize: 13, whiteSpace: "pre-wrap" }}>
          <h3 style={{ color: "#d93026" }}>界面渲染出错</h3>
          <pre style={{ background: "#f4f5f7", padding: 12, borderRadius: 8 }}>
            {this.state.error.stack ?? String(this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  // 启动时恢复主题与缩放
  useEffect(() => {
    applyTheme(loadTheme(), false);
    applyZoom(loadZoom(), false);
    // 全局禁用浏览器默认右键菜单（改由应用菜单接管，各区域自行注册 contextmenu）
    const blockMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", blockMenu);
    return () => window.removeEventListener("contextmenu", blockMenu);
  }, []);

  // Ctrl/Cmd + +/-/0 缩放
  useZoomShortcut();
  // F12 开发者工具
  useDevtoolsShortcut();

  // sidecar 崩溃/重启：重启完成后自动重新加载（对话池恢复）+ 提示
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const { bindPiBridgeEvents } = await import("./pi/bridge");
        await bindPiBridgeEvents((ev) => {
          if (disposed) return;
          if (ev.type === "sidecar_exit") {
            usePiUiStore.setState({
              error: "PI 驱动进程异常退出，正在自动重启…",
              loading: true,
            });
            window.dispatchEvent(new CustomEvent("pi:session-changed"));
          } else if (ev.type === "sidecar_start") {
            if (ev.restart) {
              void usePiUiStore.getState().loadAll();
              window.dispatchEvent(new CustomEvent("pi:session-changed"));
            }
          } else if (ev.type === "sidecar_error") {
            usePiUiStore.setState({ error: `PI 驱动重启失败：${ev.error ?? "未知"}` });
          }
        });
      } catch {
        /* 桥未就绪忽略 */
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar />
        <div className="app__body">
          <Sidebar />
          <main className="main">
            <PiChatView />
          </main>
        </div>
      </div>
    </ErrorBoundary>
  );
}