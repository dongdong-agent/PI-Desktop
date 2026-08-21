/**
 * PI 桥（前端侧）：封装 Tauri IPC → sidecar stdin + 事件监听。
 * 单例模块；StrictMode 下幂等。
 * 支持 request/response 关联：piSend 返回 Promise，由事件流中的 response 回包 resolve。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 是否运行在 Tauri 环境（网页版预览时为 false） */
export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let bound = false;
let unlistenPromise: Promise<UnlistenFn> | null = null;
let seq = 0;
const pending = new Map<string, (res: any) => void>();
const eventListeners = new Set<(event: any) => void>();

function dispatch(parsed: any) {
  // 1) response 回包 → resolve 对应请求
  if (parsed && parsed.type === "response") {
    const resolve = pending.get(parsed.requestId);
    if (resolve) {
      pending.delete(parsed.requestId);
      resolve(parsed);
      return; // 响应不回发给视图
    }
  }
  // 2) 解包 sidecar 事件层 {type:"event", dialogueId?, event:{...}} → 真实事件
  //    对话池：dialogueId 附加到事件上（_dialogueId），供视图按当前对话过滤后台流式事件
  if (parsed && parsed.type === "event" && parsed.event && typeof parsed.event === "object") {
    const dlgId = parsed.dialogueId ?? null;
    parsed = parsed.event;
    if (dlgId) parsed._dialogueId = dlgId;
  }
  // 3) 视图监听器
  for (const cb of [...eventListeners]) {
    try {
      cb(parsed);
    } catch {
      /* 忽略单个监听器错误 */
    }
  }
}

async function ensureBound(): Promise<void> {
  if (bound) return;
  if (!unlistenPromise) {
    unlistenPromise = listen<string>("pi_event", (e) => {
      const raw = (e.payload ?? "").trim();
      if (!raw) return; // 空行直接忽略，不视为解析失败
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 非 JSON 行：仅记录，便于排查，不再对空/噪声行弹出错误横幅
        console.warn("[bridge] 无法解析事件行:", raw.slice(0, 300));
        parsed = { type: "bridge_error", error: "事件解析失败" };
      }
      dispatch(parsed);
    }).then((unlisten) => {
      bound = true;
      return unlisten;
    });
  }
  await unlistenPromise;
}

/** 订阅视图事件（幂等绑定底层监听） */
export async function bindPiEvents(onEvent: (event: any) => void): Promise<void> {
  await ensureBound();
  eventListeners.add(onEvent);
}

/** 发送一行 JSON 指令；Promise 在对应 response 回包时 resolve */
export function piSend(cmd: Record<string, unknown>): Promise<any> {
  if (!isTauriEnv()) {
    return Promise.reject(new Error("网页预览模式：未连接 PI（请使用桌面版）"));
  }
  const requestId = (cmd.requestId as string) ?? `req-${++seq}`;
  const full: Record<string, unknown> = { ...cmd, requestId };
  return new Promise((resolve, reject) => {
    pending.set(requestId, resolve);
    invoke("pi_send", { line: JSON.stringify(full) }).catch((e) => {
      pending.delete(requestId);
      reject(e);
    });
  });
}

/** 桥是否就绪 */
export async function bridgeReady(): Promise<boolean> {
  if (!isTauriEnv()) return false;
  try {
    return (await invoke("pi_bridge_ready")) as boolean;
  } catch {
    return false;
  }
}

export function isBridgeBound(): boolean {
  return bound;
}

/** 仅供测试：清空 pending */
export function __resetBridgeForTest(): void {
  pending.clear();
  seq = 0;
}