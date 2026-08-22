/**
 * 多窗口工作区隔离：每个窗口用 URL 的 ?ws=<id> 标识自己的工作区。
 * 核心工作区状态（项目集/最近项目/最近会话/对话池）按窗口隔离，
 * 全局偏好（主题/缩放/历史/候选 key 等）保持共享。
 */
let cachedWsId: string | null = null;

/** 当前窗口的工作区 id（主窗口 = "main"） */
export function wsId(): string {
  if (cachedWsId !== null) return cachedWsId;
  try {
    const p = new URLSearchParams(window.location.search);
    cachedWsId = p.get("ws") ?? "main";
  } catch {
    cachedWsId = "main";
  }
  return cachedWsId;
}

/** 核心工作区 key：非主窗口时加窗口前缀 */
export function wsKey(key: string): string {
  const id = wsId();
  return id === "main" ? `aiwb:${key}` : `aiwb:w${id}:${key}`;
}

/** 是否多窗口隔离模式（非主窗口） */
export function isIsolatedWindow(): boolean {
  return wsId() !== "main";
}
