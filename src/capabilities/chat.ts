/**
 * ChatCapability：第一个能力插件 —— 对话/编码终端（≈ PI 终端的最小能力）。
 *
 * 行为：
 * - action "send"   : 追加用户消息 → 创建 pending 回复 → 走 Provider 流式 → 逐帧 emit
 * - action "resend" : 删除一条失败(或历史)的助手消息，用其前一条用户消息重新生成
 * - action "stop"   : 中止当前会话的流式生成
 *
 * 纪律：
 * - 本插件不直接写状态层；一切通过 ctx.emit 事件，由绑定层投影入 store。
 * - 并发控制：每个会话同时只允许一条流；重入时先中止旧流。
 */
import type {
  Capability,
  CapabilityContext,
  ChatMessage,
  Provider,
  StreamChunk,
} from "../core/types";
import { uid } from "../core/types";
import { getProviderConfig, getSession } from "../core/store";

interface SendPayload {
  sessionId: string;
  text: string;
}

interface ResendPayload {
  sessionId: string;
  messageId: string;
}

interface StopPayload {
  sessionId: string;
}

/** 每个会话的活动流控制器 */
const activeStreams = new Map<string, AbortController>();

function emitStream(ctx: CapabilityContext, event: Parameters<CapabilityContext["emit"]>[0]) {
  ctx.emit(event);
}

export const chatCapability: Capability = {
  id: "chat",
  name: "对话/编码终端",
  description: "多轮对话与流式输出，是工作台的基础能力（≈ PI 终端）。",

  onRegister(ctx) {
    // 预留：将来可在此订阅 / 初始化资源
    void ctx;
  },

  async execute(ctx, action, payload) {
    switch (action) {
      case "send":
        await handleSend(ctx, payload as SendPayload);
        break;
      case "resend":
        await handleResend(ctx, payload as ResendPayload);
        break;
      case "stop":
        handleStop(payload as StopPayload);
        break;
      default:
        throw new Error(`[chat] 未知动作: ${action}`);
    }
  },
};

async function handleSend(ctx: CapabilityContext, payload: SendPayload): Promise<void> {
  const trimmed = payload.text.trim();
  if (!trimmed) return;
  await runStream(ctx, payload.sessionId, { appendUserMessage: trimmed });
}

async function handleResend(ctx: CapabilityContext, payload: ResendPayload): Promise<void> {
  const { sessionId, messageId } = payload;
  const session = getSession(sessionId);
  if (!session) throw new Error(`[chat] 会话不存在: ${sessionId}`);

  const index = session.messages.findIndex((m) => m.id === messageId);
  if (index < 0) return; // 消息已不存在，静默忽略

  // 找这条消息之前的最后一条用户消息
  const prevUser = [...session.messages.slice(0, index)]
    .reverse()
    .find((m) => m.role === "user");
  if (!prevUser) {
    throw new Error("[chat] 无法重试：前一条用户消息不存在。");
  }

  // 移除失败的旧消息，重新生成（用户消息保留，不再重复追加）
  emitStream(ctx, { type: "message:removed", sessionId, messageId });
  await runStream(ctx, sessionId, { appendUserMessage: null });
}

/**
 * 流式生成核心：追加（可选）用户消息 → 创建 pending 助手消息 → Provider 流式 → 逐帧 emit。
 * send 与 resend 共用，保证链路唯一。
 */
async function runStream(
  ctx: CapabilityContext,
  sessionId: string,
  opts: { appendUserMessage: string | null },
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`[chat] 会话不存在: ${sessionId}`);

  // 并发保护：同一会话只允许一条流
  const previous = activeStreams.get(sessionId);
  if (previous && !previous.signal.aborted) {
    previous.abort();
  }
  const controller = new AbortController();
  activeStreams.set(sessionId, controller);

  // 1) 追加用户消息（可选）
  let requestMessages = session.messages;
  if (opts.appendUserMessage) {
    const userMessage: ChatMessage = {
      id: uid(),
      role: "user",
      content: opts.appendUserMessage,
      createdAt: Date.now(),
    };
    emitStream(ctx, { type: "message:appended", sessionId, message: userMessage });
    requestMessages = [...session.messages, userMessage];
  }

  // 2) 创建 pending 助手消息
  const assistantMessage: ChatMessage = {
    id: uid(),
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    pending: true,
  };
  emitStream(ctx, { type: "message:appended", sessionId, message: assistantMessage });

  // 3) 取 Provider 并流式执行
  const provider =
    ctx.hub.providers.get(session.providerId) ??
    ctx.hub.providers.get("echo") ??
    ctx.hub.providers.list()[0];

  if (!provider) {
    emitStream(ctx, {
      type: "stream:error",
      sessionId,
      messageId: assistantMessage.id,
      error: "未注册任何 Provider。",
    });
    return;
  }

  // 运行时配置生效
  provider.configure(getProviderConfig(provider.id));

  emitStream(ctx, {
    type: "stream:started",
    sessionId,
    messageId: assistantMessage.id,
    providerId: provider.id,
  });

  const request = {
    messages: requestMessages,
    systemPrompt: session.systemPrompt,
    options: session.options,
  };

  let completed = false;
  try {
    for await (const chunk of consume(provider, request, controller.signal)) {
      if (controller.signal.aborted) break;
      switch (chunk.type) {
        case "delta":
          emitStream(ctx, {
            type: "stream:delta",
            sessionId,
            messageId: assistantMessage.id,
            delta: chunk.text,
          });
          break;
        case "done":
          completed = true;
          emitStream(ctx, {
            type: "stream:done",
            sessionId,
            messageId: assistantMessage.id,
            usage: chunk.usage,
          });
          break;
        case "error":
          completed = true;
          emitStream(ctx, {
            type: "stream:error",
            sessionId,
            messageId: assistantMessage.id,
            error: chunk.error,
          });
          break;
      }
    }

    // 兜底：流因任何原因（中止/静默结束）未产出 done/error 时补发 done 定稿，
    // 避免 pending 状态残留（长会话稳定性关键点）；正常完成时 completed 已置真，不重复。
    if (!completed) {
      emitStream(ctx, {
        type: "stream:done",
        sessionId,
        messageId: assistantMessage.id,
      });
    }
  } catch (err) {
    if (controller.signal.aborted) {
      // 用户主动停止：把已生成的内容定稿，不报错
      emitStream(ctx, {
        type: "stream:done",
        sessionId,
        messageId: assistantMessage.id,
      });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      emitStream(ctx, {
        type: "stream:error",
        sessionId,
        messageId: assistantMessage.id,
        error: message,
      });
    }
  } finally {
    activeStreams.delete(sessionId);
  }
}

async function* consume(
  provider: Provider,
  request: Parameters<Provider["streamChat"]>[0],
  signal: AbortSignal,
): AsyncGenerator<StreamChunk> {
  try {
    for await (const chunk of provider.streamChat(request, signal)) {
      yield chunk;
    }
  } catch (err) {
    // 把 provider 抛出的错误统一转成 error 块
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      yield { type: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function handleStop(payload: StopPayload): void {
  const controller = activeStreams.get(payload.sessionId);
  controller?.abort();
}