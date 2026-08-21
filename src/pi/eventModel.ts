import { friendlyError } from "./errorFriendly";
/**
 * PI 事件 → UI 视图模型（纯函数，无副作用、无 React 依赖）。
 * 把真实 AgentSession 事件流机械地折叠成可在 UI 渲染的消息列表。
 */

export type PiBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "thinking"; text: string; error?: string }
  | {
      kind: "toolCall";
      id: string;
      name: string;
      argsText: string;
      args?: unknown;
      status: "pending" | "running" | "done" | "error";
    }
  | { kind: "toolResult"; callId: string; text: string; isError: boolean }
  | { kind: "error"; text: string };

export interface PiViewMessage {
  id: string;
  role: "user" | "assistant";
  blocks: PiBlock[];
  status: "streaming" | "done" | "error";
  model?: string;
  ts: number;
}

export interface PiToolEvent {
  id: string;
  toolCallId: string;
  toolName: string;
  argsText: string;
  status: "pending" | "running" | "done" | "error";
  resultText?: string;
  ts: number;
}

export interface PiChatUiState {
  messages: PiViewMessage[];
  busy: boolean;
  statusText: string;
  modelLabel: string;
  lastError: string | null;
  /** 工具调用时间线（右信息面板） */
  tools: PiToolEvent[];
}

export function newUiState(): PiChatUiState {
  return { messages: [], busy: false, statusText: "", modelLabel: "", lastError: null, tools: [] };
}

let uidCounter = 0;
function vid(): string {
  return `v-${++uidCounter}-${Date.now().toString(36)}`;
}

function lastAssistant(state: PiChatUiState): PiViewMessage | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].role === "assistant") return state.messages[i];
  }
  return undefined;
}

function upsertMessage(state: PiChatUiState, msg: PiViewMessage): PiChatUiState {
  const existed = state.messages.some((m) => m.id === msg.id);
  return {
    ...state,
    messages: existed
      ? state.messages.map((m) => (m.id === msg.id ? msg : m))
      : [...state.messages, msg],
  };
}

/** 从完整的 assistant 消息内容数组提取块（message_start / message_end 使用） */
function blocksFromContent(content: unknown): PiBlock[] {
  const blocks: PiBlock[] = [];
  if (Array.isArray(content)) {
    for (const item of content as any[]) {
      if (!item || typeof item !== "object") continue;
      switch (item.type) {
        case "text":
          blocks.push({ kind: "text", text: item.text ?? "" });
          break;
        case "thinking":
          blocks.push({ kind: "thinking", text: item.thinking ?? "" });
          break;
        case "toolCall":
          blocks.push({
            kind: "toolCall",
            id: item.id ?? vid(),
            name: item.name ?? "tool",
            argsText: JSON.stringify(item.arguments ?? {}, null, 2),
            args: item.arguments,
            status: "done",
          });
          break;
        case "toolResult":
          blocks.push({
            kind: "toolResult",
            callId: item.toolCallId ?? vid(),
            text: extractText(item.content),
            isError: !!item.isError,
          });
          break;
        default:
          break;
      }
    }
  } else if (typeof content === "string") {
    blocks.push({ kind: "text", text: content });
  }
  return blocks;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n");
  }
  return "";
}

/** 当前流式 assistant 消息的最后一个可追加文本块 */
function appendToBlock(state: PiChatUiState, kind: "text" | "thinking", delta: string): PiChatUiState {
  const msg = lastAssistant(state);
  if (!msg) return state;
  const blocks = [...msg.blocks];
  const idx = blocks.length - 1;
  if (idx >= 0 && blocks[idx].kind === kind) {
    if (kind === "text") blocks[idx] = { ...blocks[idx], text: blocks[idx].text + delta } as PiBlock;
    else blocks[idx] = { ...blocks[idx], text: blocks[idx].text + delta } as PiBlock;
  } else {
    blocks.push(kind === "text" ? { kind: "text", text: delta } : { kind: "thinking", text: delta });
  }
  return upsertMessage(state, { ...msg, blocks });
}

function appendToToolArgs(state: PiChatUiState, delta: string): PiChatUiState {
  const msg = lastAssistant(state);
  if (!msg) return state;
  const blocks = [...msg.blocks];
  const idx = [...blocks].reverse().findIndex((b) => b.kind === "toolCall");
  if (idx < 0) return state;
  const real = blocks.length - 1 - idx;
  const tb = blocks[real] as Extract<PiBlock, { kind: "toolCall" }>;
  blocks[real] = { ...tb, argsText: tb.argsText + delta };
  return upsertMessage(state, { ...msg, blocks });
}

export function applyEvent(state: PiChatUiState, ev: any): PiChatUiState {
  if (!ev || typeof ev.type !== "string") return state;

  switch (ev.type) {
    case "bridge_error":
      return { ...state, lastError: ev.error ?? "桥错误", statusText: `桥错误: ${ev.error ?? ""}` };

    case "agent_start":
      return { ...state, busy: true, statusText: "PI 处理中…" };

    case "agent_settled":
      return { ...state, busy: false, statusText: "" };

    case "stream:error":
      return { ...state, lastError: friendlyError(ev?.error ?? "生成失败"), statusText: "" };

    case "auto_retry_start":
      return { ...state, statusText: `自动重试 ${ev.attempt}/${ev.maxAttempts}…` };

    case "auto_retry_end":
      return {
        ...state,
        statusText: ev.success ? "" : `重试失败: ${ev.finalError ?? ""}`,
        lastError: ev.success ? state.lastError : (ev.finalError ?? null),
      };

    case "tool_execution_start": {
      const msg = lastAssistant(state);
      if (!msg) return state;
      const blocks = msg.blocks.map((b) =>
        b.kind === "toolCall" && b.id === ev.toolCallId
          ? { ...b, status: "running" as const }
          : b,
      );
      const toolEvent: PiToolEvent = {
        id: `${ev.toolCallId}-${Date.now()}`,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName ?? "tool",
        argsText: JSON.stringify(ev.args ?? {}),
        status: "running",
        ts: Date.now(),
      };
      return {
        ...upsertMessage(state, { ...msg, blocks }),
        tools: [...state.tools, toolEvent],
      };
    }

    case "tool_execution_update": {
      const msg = lastAssistant(state);
      if (!msg) return state;
      const text = extractText(ev.partialResult?.content);
      if (!text) return state;
      const blocks = [...msg.blocks];
      const idx = blocks.findIndex((b) => b.kind === "toolResult" && b.callId === ev.toolCallId);
      if (idx >= 0) {
        blocks[idx] = {
          kind: "toolResult",
          callId: ev.toolCallId,
          text,
          isError: false,
        };
      } else {
        blocks.push({ kind: "toolResult", callId: ev.toolCallId, text, isError: false });
      }
      const tools = state.tools.map((t) =>
        t.toolCallId === ev.toolCallId ? { ...t, resultText: text } : t,
      );
      return { ...upsertMessage(state, { ...msg, blocks }), tools };
    }

    case "tool_execution_end": {
      const msg = lastAssistant(state);
      if (!msg) return state;
      const text = extractText(ev.result?.content) || "(无输出)";
      let blocks = msg.blocks.map((b) =>
        b.kind === "toolCall" && b.id === ev.toolCallId
          ? { ...b, status: ev.isError ? ("error" as const) : ("done" as const) }
          : b,
      );
      const hasResult = blocks.some((b) => b.kind === "toolResult" && b.callId === ev.toolCallId);
      if (!hasResult) {
        blocks = [
          ...blocks,
          { kind: "toolResult" as const, callId: ev.toolCallId, text, isError: !!ev.isError },
        ];
      }
      const tools = state.tools.map((t) =>
        t.toolCallId === ev.toolCallId
          ? { ...t, status: ev.isError ? ("error" as const) : ("done" as const), resultText: text }
          : t,
      );
      return { ...upsertMessage(state, { ...msg, blocks }), tools };
    }

    case "message_start": {
      const m = ev.message;
      if (m?.role === "user") return state; // 用户消息 UI 本地已有
      const msg: PiViewMessage = {
        id: m?.id ?? vid(),
        role: "assistant",
        blocks: blocksFromContent(m?.content),
        status: "streaming",
        model: m?.model,
        ts: m?.timestamp ?? Date.now(),
      };
      return upsertMessage(state, msg);
    }

    case "message_update": {
      const a = ev.assistantMessageEvent;
      if (!a) return state;
      switch (a.type) {
        case "text_delta":
          return appendToBlock(state, "text", a.delta ?? "");
        case "thinking_delta":
          return appendToBlock(state, "thinking", a.delta ?? "");
        case "toolcall_delta":
          return appendToToolArgs(state, a.delta ?? "");
        default:
          return state;
      }
    }

    case "message_end": {
      const msg = lastAssistant(state);
      if (!msg) return state;
      const m = ev.message;
      const blocks = blocksFromContent(m?.content);
      const final: PiViewMessage = {
        ...msg,
        blocks: blocks.length > 0 ? blocks : msg.blocks,
        status: "done",
        model: m?.model ?? msg.model,
      };
      return upsertMessage(state, final);
    }

    case "turn_end": {
      // turn 结束：若流式消息未定稿则定稿
      const msg = lastAssistant(state);
      if (msg && msg.status === "streaming") {
        return upsertMessage(state, { ...msg, status: "done" });
      }
      return state;
    }

    case "compaction_start":
      return { ...state, statusText: `上下文压缩中（${ev.reason ?? ""}）…` };

    case "compaction_end":
      return {
        ...state,
        statusText: ev.aborted
          ? "压缩已取消"
          : ev.result
            ? `已压缩：${ev.result.tokensBefore ?? "?"} → ${ev.result.estimatedTokensAfter ?? "?"} token`
            : ev.errorMessage
              ? `压缩失败: ${ev.errorMessage}`
              : "",
      };

    case "queue_update":
      return {
        ...state,
        statusText:
          ev.steering?.length || ev.followUp?.length
            ? `队列：steer×${ev.steering?.length ?? 0} / followup×${ev.followUp?.length ?? 0}`
            : state.statusText,
      };

    case "set_model":
      // 保留：模型信息以后端 state 为准
      return state;

    default:
      return state;
  }
}

/** 追加一条本地用户消息（发送 prompt 前调用）。可选附带图片块（粘贴的截图等）。 */
export function addUserMessage(
  state: PiChatUiState,
  text: string,
  images: { data: string; mimeType: string }[] = [],
): PiChatUiState {
  const blocks: PiBlock[] = [
    ...images.map((img) => ({ kind: "image" as const, data: img.data, mimeType: img.mimeType })),
    { kind: "text", text },
  ];
  const msg: PiViewMessage = {
    id: vid(),
    role: "user",
    blocks,
    status: "done",
    ts: Date.now(),
  };
  return { ...state, messages: [...state.messages, msg] };
}

/** 把 get_messages 返回的 AgentMessage[] 转成视图消息（历史恢复） */
export function historyToMessages(messages: any[]): PiViewMessage[] {
  const out: PiViewMessage[] = [];
  for (const m of messages ?? []) {
    if (!m || typeof m.role !== "string") continue;
    const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
    if (m.role === "user") {
      out.push({
        id: `hist-u-${ts}-${out.length}`,
        role: "user",
        blocks: [{ kind: "text", text: extractText(m.content) }],
        status: "done",
        ts,
      });
      continue;
    }
    const blocks = blocksFromContent(m.content);
    if (blocks.length > 0) {
      out.push({
        id: `hist-a-${ts}-${out.length}`,
        role: "assistant",
        blocks,
        status: "done",
        model: m.model,
        ts,
      });
    }
  }
  return out;
}

/** 标记最后一条消息为错误（prompt 被拒绝等） */
export function markLastError(state: PiChatUiState, error: string): PiChatUiState {
  return { ...state, lastError: friendlyError(error), statusText: "" };
}