/**
 * 应用引导（bootstrap）：创建唯一中枢，注册内建插件，绑定状态层。
 * 这是唯一允许「手拉手接线」的地方；业务代码只依赖接口。
 */
import { Hub } from "../core/hub";
import { bindHubToStore } from "../core/bind";
import { useAppStore, ensureProviderConfig } from "../core/store";
import { chatCapability } from "../capabilities/chat";
import { echoProvider } from "../providers/echo";
import { openaiCompatProvider } from "../providers/openaiCompat";

let hub: Hub | null = null;

/** 获取全局唯一中枢（惰性创建） */
export function getHub(): Hub {
  if (hub) return hub;

  hub = new Hub();

  // 1) 注册 Provider（先注册，能力正好能拿到）
  const providers = [echoProvider, openaiCompatProvider];
  for (const p of providers) {
    hub.registerProvider(p);
    // 首次发现 provider 时把默认配置写入存储
    ensureProviderConfig(p);
  }

  // 2) 注册能力（插件）
  hub.registerCapability(chatCapability);

  // 3) 事件总线 → 状态层
  bindHubToStore(hub, useAppStore);

  return hub;
}

/** 应用启动：恢复持久化状态，返回中枢 */
export function bootstrap(): Hub {
  const api = getHub();
  useAppStore.getState().hydrate();
  return api;
}

/** 助手：给 UI 用的类型化调用 */
export function sendMessage(sessionId: string, text: string): Promise<unknown> {
  return getHub().call("chat", "send", { sessionId, text });
}

export function stopStream(sessionId: string): Promise<unknown> {
  return getHub().call("chat", "stop", { sessionId });
}

export function resendMessage(sessionId: string, messageId: string): Promise<unknown> {
  return getHub().call("chat", "resend", { sessionId, messageId });
}