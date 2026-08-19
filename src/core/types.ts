/**
 * AI 工作台 · 核心类型契约
 *
 * 架构心智模型：中枢(Hub) + 插件(Capability/Provider) + 注册表(Registry)
 * 本文件只定义「契约」，不包含实现 —— 所有扩展能力都向这些接口对齐。
 */

// ---------------------------------------------------------------------------
// 消息与会话（会话层）
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  /** 流式生成中（尚未结束） */
  pending?: boolean;
  /** 生成失败信息 */
  error?: string;
  /** 生成所用的模型标识 */
  model?: string;
  /** 用量统计（可选） */
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** 本会话使用的 Provider ID */
  providerId: string;
  systemPrompt?: string;
  options?: ChatOptions;
}

// ---------------------------------------------------------------------------
// Provider 契约（可插拔的模型后端）
// ---------------------------------------------------------------------------

/** 流式输出的数据块 */
export type StreamChunk =
  | { type: "delta"; text: string }
  | {
      type: "done";
      usage?: { promptTokens?: number; completionTokens?: number };
    }
  | { type: "error"; error: string };

export interface ChatRequest {
  messages: ChatMessage[];
  systemPrompt?: string;
  options?: ChatOptions;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly kind: "local" | "remote";
  /** 是否需要在设置面板填参数 */
  readonly configurable: boolean;
  /** 默认配置（用于设置面板回填） */
  defaultConfig?: Record<string, string>;
  /**
   * 流式对话。实现方必须：
   * - 尊重 signal 中止（抛出或直接返回）
   * - 以 async generator 产出 StreamChunk
   */
  streamChat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk>;
  /** 应用运行期配置（来自设置面板） */
  configure(config: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// Capability 契约（可插拔的能力插件）
// ---------------------------------------------------------------------------

/** 能力执行上下文：给插件回传事件、访问中枢 */
export interface CapabilityContext {
  /** 中枢引用（只读使用，避免插件反向修改中枢注册表） */
  readonly hub: Hub;
  /** 向事件总线投递事件 */
  emit(event: HubEvent): void;
  /** 订阅事件总线，返回退订函数 */
  subscribe(listener: (event: HubEvent) => void): () => void;
}

export interface Capability {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /**
   * 注册回调：插件在此挂载自己的资源、订阅事件。
   * 对应「不断增加的技能」——每个技能就是实现了本接口的插件。
   */
  onRegister?(ctx: CapabilityContext): void | Promise<void>;
  /** 注销回调：清理订阅、定时器、连接 */
  onDispose?(ctx: CapabilityContext): void | Promise<void>;
  /**
   * 能力调用协议：中枢统一通过「动作(action) + 载荷(payload)」调用能力。
   * 具体动作集由各能力自行定义并在文档中声明，前端 UI 经 hub.call 触发。
   */
  execute?(ctx: CapabilityContext, action: string, payload: unknown): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// 事件总线（中枢内部通信，也用于 UI 层与能力的解耦）
// ---------------------------------------------------------------------------

export type HubEvent =
  | { type: "capability:registered"; capabilityId: string }
  | { type: "message:appended"; sessionId: string; message: ChatMessage }
  | { type: "message:removed"; sessionId: string; messageId: string }
  | { type: "stream:started"; sessionId: string; messageId: string; providerId: string }
  | { type: "stream:delta"; sessionId: string; messageId: string; delta: string }
  | {
      type: "stream:done";
      sessionId: string;
      messageId: string;
      usage?: { promptTokens?: number; completionTokens?: number };
    }
  | { type: "stream:error"; sessionId: string; messageId: string; error: string }
  | { type: "provider:changed"; providerId: string };

// ---------------------------------------------------------------------------
// Hub 接口（类型上用接口声明，避免与实现循环引用）
// ---------------------------------------------------------------------------

export interface HubCapabilityRegistry {
  register(cap: Capability): void;
  unregister(id: string): boolean;
  get<T extends Capability = Capability>(id: string): T | undefined;
  list(): Capability[];
  has(id: string): boolean;
}

export interface HubProviderRegistry {
  register(p: Provider): void;
  unregister(id: string): boolean;
  get(id: string): Provider | undefined;
  list(): Provider[];
  has(id: string): boolean;
}

export interface Hub {
  readonly capabilities: HubCapabilityRegistry;
  readonly providers: HubProviderRegistry;
  readonly events: {
    subscribe(listener: (event: HubEvent) => void): () => void;
    emit(event: HubEvent): void;
  };
  /** 调用某个能力的某个动作（能力扩展通用入口） */
  call<T = unknown>(capabilityId: string, action: string, payload?: unknown): Promise<T>;
}

// ---------------------------------------------------------------------------
// 工具：ID 生成（WebView2 环境下 crypto.randomUUID 通常可用）
// ---------------------------------------------------------------------------

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}