/**
 * 绑定层：把中枢的事件总线「投影」到应用状态层。
 * 事件驱动是这里的核心纪律 —— UI 不直接调用状态层的消息写入方法，
 * 统一由能力插件 emit 事件 → 本绑定层落库，保证写入路径唯一。
 */
import type { StoreApi } from "zustand";
import type { Hub, HubEvent } from "./types";
import type { AppState } from "./store";

export function bindHubToStore(hub: Hub, store: StoreApi<AppState>): () => void {
  return hub.events.subscribe((event: HubEvent) => {
    const s = store.getState();
    switch (event.type) {
      case "message:appended":
        s.appendMessage(event.sessionId, event.message);
        break;
      case "message:removed":
        s.removeMessage(event.sessionId, event.messageId);
        break;
      case "stream:started":
        s.setStreaming(event.sessionId, true);
        break;
      case "stream:delta":
        s.applyDelta(event.sessionId, event.messageId, event.delta);
        break;
      case "stream:done":
        s.setStreaming(event.sessionId, false);
        s.finishMessage(event.sessionId, event.messageId, event.usage);
        break;
      case "stream:error":
        s.setStreaming(event.sessionId, false);
        s.failMessage(event.sessionId, event.messageId, event.error);
        break;
      default:
        // 其他事件（能力注册/会话更新等）暂不投影到状态层
        break;
    }
  });
}