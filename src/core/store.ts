/**
 * 应用状态层（zustand）：UI 的唯一数据源。
 *
 * 设计要点（对应「长对话稳定性」工程规范）：
 * 1. 所有对会话/消息的写操作，都必须经由这里的方法 —— 状态变更单一入口。
 * 2. 流式更新只做「最后一帧追加」（applyDelta），不做整列表重建。
 * 3. 会话持久化统一走 storage adapter（当前 localStorage；接口留好，将来可换 Tauri store）。
 */
import { create } from "zustand";
import type { ChatMessage, Provider, Session } from "./types";
import { uid } from "./types";

const STORAGE_KEY = "aiwb:state:v1";
const DEFAULT_PROVIDER_ID = "echo";
const DEFAULT_SESSION_TITLE = "新会话";

export interface StoredProviderConfig {
  config: Record<string, string>;
}

interface PersistedState {
  version: 1;
  sessions: Session[];
  activeSessionId: string | null;
  providerConfigs: Record<string, StoredProviderConfig>;
  theme: ThemeName;
}

export type ThemeName = "light" | "dark";

export interface AppState {
  sessions: Session[];
  activeSessionId: string | null;
  /** sessionId -> 是否正在流式生成 */
  streamingSessions: Record<string, boolean>;
  /** providerId -> 运行期配置（设置面板保存） */
  providerConfigs: Record<string, StoredProviderConfig>;
  /** 主题（皮肤系统的最小落地） */
  theme: ThemeName;

  // ---- 会话 CRUD ----
  createSession: () => string;
  deleteSession: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  setProvider: (sessionId: string, providerId: string) => void;
  setSystemPrompt: (sessionId: string, prompt: string) => void;
  setSessionOptions: (sessionId: string, patch: Partial<Session["options"]>) => void;
  setTheme: (theme: ThemeName) => void;

  // ---- 消息写入（事件绑定层 / 插件回调目标）----
  appendMessage: (sessionId: string, message: ChatMessage) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  applyDelta: (sessionId: string, messageId: string, delta: string) => void;
  finishMessage: (
    sessionId: string,
    messageId: string,
    usage?: ChatMessage["usage"],
  ) => void;
  failMessage: (sessionId: string, messageId: string, error: string) => void;
  setStreaming: (sessionId: string, streaming: boolean) => void;

  // ---- Provider 配置 ----
  saveProviderConfig: (providerId: string, config: Record<string, string>) => void;

  // ---- 持久化 ----
  persist: () => void;
  hydrate: () => void;
}

/** localStorage 写盘（供外部按需调用，避免在每次 action 内重复） */
const storage = {
  load(): PersistedState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return null;
      return parsed;
    } catch {
      return null;
    }
  },
  save(state: Pick<AppState, "sessions" | "activeSessionId" | "providerConfigs" | "theme">): void {
    try {
      const payload: PersistedState = {
        version: 1,
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        providerConfigs: state.providerConfigs,
        theme: state.theme,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.error("[store] 持久化失败", err);
    }
  },
};

function makeDefaultSession(providerId = DEFAULT_PROVIDER_ID): Session {
  const now = Date.now();
  return {
    id: uid(),
    title: DEFAULT_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
    messages: [],
    providerId,
  };
}

function truncateTitle(text: string, max = 24): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export const useAppStore = create<AppState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  streamingSessions: {},
  providerConfigs: {},
  theme: "light",

  createSession: () => {
    const session = makeDefaultSession();
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: session.id,
    }));
    return session.id;
  },

  deleteSession: (sessionId) => {
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== sessionId);
      const activeSessionId =
        s.activeSessionId === sessionId ? sessions[0]?.id ?? null : s.activeSessionId;
      return { sessions, activeSessionId };
    });
  },

  switchSession: (sessionId) => {
    // 若目标不存在则忽略
    if (!get().sessions.some((s) => s.id === sessionId)) return;
    set({ activeSessionId: sessionId });
  },

  setProvider: (sessionId, providerId) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId ? { ...x, providerId, updatedAt: Date.now() } : x,
      ),
    }));
  },

  setSystemPrompt: (sessionId, prompt) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId ? { ...x, systemPrompt: prompt, updatedAt: Date.now() } : x,
      ),
    }));
  },

  setSessionOptions: (sessionId, patch) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId
          ? { ...x, options: { ...x.options, ...patch }, updatedAt: Date.now() }
          : x,
      ),
    }));
  },

  setTheme: (theme) => {
    set({ theme });
    get().persist();
  },

  appendMessage: (sessionId, message) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x;
        const title =
          message.role === "user" && x.title === DEFAULT_SESSION_TITLE
            ? truncateTitle(message.content)
            : x.title;
        return {
          ...x,
          title,
          updatedAt: Date.now(),
          messages: [...x.messages, message],
        };
      }),
    }));
  },

  removeMessage: (sessionId, messageId) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x;
        return {
          ...x,
          updatedAt: Date.now(),
          messages: x.messages.filter((m) => m.id !== messageId),
        };
      }),
    }));
  },

  applyDelta: (sessionId, messageId, delta) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x;
        return {
          ...x,
          updatedAt: Date.now(),
          messages: x.messages.map((m) =>
            m.id === messageId ? { ...m, content: m.content + delta } : m,
          ),
        };
      }),
    }));
  },

  finishMessage: (sessionId, messageId, usage) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x;
        return {
          ...x,
          updatedAt: Date.now(),
          messages: x.messages.map((m) =>
            m.id === messageId
              ? { ...m, pending: false, usage, error: undefined }
              : m,
          ),
        };
      }),
    }));
  },

  failMessage: (sessionId, messageId, error) => {
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== sessionId) return x;
        return {
          ...x,
          updatedAt: Date.now(),
          messages: x.messages.map((m) =>
            m.id === messageId
              ? { ...m, pending: false, error, content: m.content || "" }
              : m,
          ),
        };
      }),
    }));
  },

  setStreaming: (sessionId, streaming) => {
    set((s) => ({
      streamingSessions: { ...s.streamingSessions, [sessionId]: streaming },
    }));
  },

  saveProviderConfig: (providerId, config) => {
    set((s) => ({
      providerConfigs: { ...s.providerConfigs, [providerId]: { config } },
    }));
    get().persist();
  },

  persist: () => {
    storage.save({
      sessions: get().sessions,
      activeSessionId: get().activeSessionId,
      providerConfigs: get().providerConfigs,
      theme: get().theme,
    });
  },

  hydrate: () => {
    const persisted = storage.load();
    if (persisted && persisted.sessions.length > 0) {
      // 恢复清洗：长会话恢复的稳定性关键
      // 1) 强制取消一切 pending（异常退出留下的“永久生成中”状态）
      // 2) 过滤缺失关键字段的消息
      // 3) 校验 activeSessionId 是否仍然有效，无效则回退到第一个会话
      const sessions = persisted.sessions.map((s) => ({
        ...s,
        messages: (s.messages ?? [])
          .filter((m) => m && typeof m.id === "string" && typeof m.content === "string")
          .map((m) => ({ ...m, pending: false, error: undefined })),
      }));
      const validIds = new Set(sessions.map((s) => s.id));
      const activeSessionId =
        persisted.activeSessionId && validIds.has(persisted.activeSessionId)
          ? persisted.activeSessionId
          : sessions[0].id;
      set({
        sessions,
        activeSessionId,
        providerConfigs: persisted.providerConfigs ?? {},
        theme: persisted.theme ?? "light",
      });
      return;
    }
    // 首次启动：创建默认会话
    const session = makeDefaultSession();
    set({ sessions: [session], activeSessionId: session.id });
  },
}));

/** 取会话快照的辅助函数（供插件层使用，避免在插件里 import hook） */
export function getSession(sessionId: string): Session | undefined {
  return useAppStore.getState().sessions.find((s) => s.id === sessionId);
}

/** 取 Provider 配置的辅助函数 */
export function getProviderConfig(providerId: string): Record<string, string> {
  return useAppStore.getState().providerConfigs[providerId]?.config ?? {};
}

/** 把 Provider 默认配置写入存储（首次发现新 provider 时调用） */
export function ensureProviderConfig(provider: Provider): void {
  const state = useAppStore.getState();
  if (!state.providerConfigs[provider.id] && provider.defaultConfig) {
    state.saveProviderConfig(provider.id, { ...provider.defaultConfig });
  }
}