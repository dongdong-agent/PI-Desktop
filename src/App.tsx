/**
 * 应用根组件：布局「侧栏 + 主区」。主区 = PI 会话视图（真实 PI 驱动）。
 * 带 ErrorBoundary：渲染崩溃时显示错误详情而不是白屏。
 */
import { Component, useEffect, type ReactNode } from "react";
import { applyTheme, loadTheme } from "./app/theme";
import { Sidebar } from "./ui/Sidebar";
import { PiChatView } from "./ui/PiChatView";
import { TitleBar } from "./ui/TitleBar";
import "./styles.css";

const ZOOM_KEY = "aiwb:zoom";
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;
const BASE_FONT = 14; // px，与 styles.css 的 rem 基准一致

function loadZoom(): number {
  try {
    const v = parseFloat(localStorage.getItem(ZOOM_KEY) ?? "");
    if (Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX) return v;
  } catch {
    /* ignore */
  }
  return 1;
}

/**
 * 缩放 = 调整 html 基准字号（只影响 rem 文本，布局 px 不变 → 自适应换行/撑开）
 */
function applyZoom(level: number, persist = true): void {
  document.documentElement.style.fontSize = `${BASE_FONT * level}px`;
  if (persist) {
    try {
      localStorage.setItem(ZOOM_KEY, String(level));
    } catch {
      /* ignore */
    }
  }
}

function useZoomShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const cur = loadZoom();
      let next: number | null = null;
      if (e.key === "+" || e.key === "=" || e.key === "Add") {
        next = Math.min(cur + ZOOM_STEP, ZOOM_MAX);
      } else if (e.key === "-" || e.key === "Subtract") {
        next = Math.max(cur - ZOOM_STEP, ZOOM_MIN);
      } else if (e.key === "0") {
        next = 1;
      }
      if (next !== null) {
        e.preventDefault();
        applyZoom(next);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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