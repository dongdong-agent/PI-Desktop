/**
 * PI UI 共享状态（zustand）：项目列表 / 模型列表 / 当前项目 / 当前模型。
 * 侧栏项目区与输入框工具栏共用，切换项目=重新 init（换 cwd）。
 */
import { create } from "zustand";
import { piSend } from "./bridge";

export interface ProjectItem {
  cwd: string;
  sessionCount: number;
}

export interface ModelItem {
  id: string;
  name: string;
  provider: string;
}

export interface SessionStats {
  totalMessages?: number;
  toolCalls?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  cost?: { total?: number } | number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
  /** 原始请求体字节估算（序列化全部消息），用于预警上游 413 限制 */
  payloadBytes?: number;
}

interface PiUiState {
  projects: ProjectItem[];
  currentCwd: string | null;
  models: ModelItem[];
  currentModelRef: string | null; // "provider/id" 组合（同 id 不同 provider 可区分）
  stats: SessionStats | null;
  thinkingLevel: string | null;
  loading: boolean;
  error: string | null;

  loadAll: () => Promise<void>;
  refreshStats: () => Promise<void>;
  switchProject: (cwd: string) => Promise<boolean>;
  setModel: (modelRef: string) => Promise<boolean>;
  setThinking: (level: string) => Promise<boolean>;
  compact: () => Promise<boolean>;
  refreshModels: () => Promise<void>;
}

export const usePiUiStore = create<PiUiState>()((set, get) => ({
  projects: [],
  currentCwd: null,
  models: [],
  currentModelRef: null,
  stats: null,
  thinkingLevel: null,
  loading: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const [projRes, stateRes, modelRes] = await Promise.all([
        piSend({ type: "list_projects" }),
        piSend({ type: "get_state" }),
        piSend({ type: "get_available_models" }),
      ]);
      const projects = projRes?.success ? (projRes.data?.projects ?? []) : [];
      const cwd = stateRes?.success ? (stateRes.data?.cwd ?? null) : null;
      const models = modelRes?.success ? (modelRes.data?.models ?? []) : [];
      // 去重键 = provider:id（同 id 不同 provider 的模型都保留，标注提供商）
      const seen = new Set<string>();
      const uniqueModels = models.filter((m: { id: string; provider: string }) => {
        const key = `${m.provider}:${m.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const modelId = stateRes?.success ? (stateRes.data?.model ?? null) : null;
      const provider = stateRes?.success ? (stateRes.data?.provider ?? null) : null;
      set({
        projects,
        currentCwd: cwd,
        models: uniqueModels,
        currentModelRef: modelId && provider ? `${provider}/${modelId}` : null,
        thinkingLevel: stateRes?.success ? (stateRes.data?.thinkingLevel ?? null) : null,
      });
      // sidecar init 可能未完成：模型空时自动重试（每 2s，最多 8 次）
      if (uniqueModels.length === 0 || !stateRes?.success) {
        const n = (window as unknown as { __loadAllRetries?: number }).__loadAllRetries ?? 0;
        if (n < 8) {
          (window as unknown as { __loadAllRetries?: number }).__loadAllRetries = n + 1;
          window.setTimeout(() => void get().loadAll(), 2000);
        }
      }
      await get().refreshStats();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      const n = (window as unknown as { __loadAllRetries?: number }).__loadAllRetries ?? 0;
      if (n < 8) {
        (window as unknown as { __loadAllRetries?: number }).__loadAllRetries = n + 1;
        window.setTimeout(() => void get().loadAll(), 2000);
      }
    } finally {
      set({ loading: false });
    }
  },

  refreshStats: async () => {
    try {
      const res = await piSend({ type: "get_session_stats" });
      if (res?.success) set({ stats: res.data ?? null });
    } catch {
      /* ignore */
    }
  },

  setThinking: async (level) => {
    try {
      const res = await piSend({ type: "set_thinking_level", level });
      if (res?.success) {
        set({ thinkingLevel: level });
        return true;
      }
      set({ error: res?.error ?? "切换思考级别失败" });
      return false;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  compact: async () => {
    try {
      const res = await piSend({ type: "compact" });
      if (res?.success) {
        await get().refreshStats();
        return true;
      }
      set({ error: res?.error ?? "压缩失败" });
      return false;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  switchProject: async (cwd) => {
    set({ loading: true, error: null });
    (window as unknown as { __loadAllRetries?: number }).__loadAllRetries = 0;
    try {
      const res = await piSend({ type: "switch_project", cwd, sessionMode: "recent" });
      if (res?.success) {
        set({ currentCwd: cwd });
        // 通知主视图与侧栏刷新会话/消息
        window.dispatchEvent(new CustomEvent("pi:session-changed"));
        window.dispatchEvent(new CustomEvent("pi:project-changed"));
        return true;
      }
      set({ error: res?.error ?? "切换项目失败" });
      return false;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      set({ loading: false });
    }
  },

  setModel: async (modelRef) => {
    try {
      // modelRef 格式: "provider/modelId"
      const [provider, modelId] = modelRef.split("/");
      if (!provider || !modelId) {
        set({ error: "模型引用格式错误（应为 provider/modelId）" });
        return false;
      }
      const res = await piSend({ type: "set_model", provider, modelId });
      if (res?.success) {
        set({ currentModelRef: modelRef });
        return true;
      }
      set({ error: res?.error ?? "切换模型失败" });
      return false;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  refreshModels: async () => {
    try {
      const res = await piSend({ type: "get_available_models" });
      if (res?.success) set({ models: res.data?.models ?? [] });
    } catch {
      /* ignore */
    }
  },
}));

/** 项目短名（显示用）：取路径最后一段，太短则整体 */
export function projectShortName(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}