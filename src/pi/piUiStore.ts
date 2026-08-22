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

/** 对话池中的进行中对话（侧栏「对话中」视图） */
export interface DialogueItem {
  dialogueId: string;
  cwd: string;
  sessionPath: string | null;
  name: string;
  status: string; // flowing | thinking | idle
  model: string | null;
  provider: string | null;
  lastActive: number;
  isCurrent: boolean;
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
  /** 当前激活对话 id（后端对话池）；事件按它过滤，指令带它路由 */
  currentDialogueId: string | null;
  /** 进行中的对话列表（侧栏「对话中」视图，list_dialogues 结果） */
  dialogues: DialogueItem[];
  models: ModelItem[];
  currentModelRef: string | null; // "provider/id" 组合（同 id 不同 provider 可区分）
  stats: SessionStats | null;
  thinkingLevel: string | null;
  loading: boolean;
  error: string | null;

  loadAll: () => Promise<void>;
  refreshStats: () => Promise<void>;
  switchProject: (cwd: string) => Promise<boolean>;
  refreshDialogues: () => Promise<void>;
  activateDialogue: (dialogueId: string) => Promise<boolean>;
  closeDialogue: (dialogueId: string) => Promise<boolean>;
  setModel: (modelRef: string) => Promise<boolean>;
  setThinking: (level: string) => Promise<boolean>;
  compact: () => Promise<boolean>;
  refreshModels: () => Promise<void>;
}

export const usePiUiStore = create<PiUiState>()((set, get) => ({
  projects: [],
  currentCwd: null,
  currentDialogueId: null,
  dialogues: [],
  models: [],
  currentModelRef: null,
  stats: null,
  thinkingLevel: null,
  loading: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      // 确保 sidecar 已初始化（对话池）：前端必须显式 open_dialogue，
      // 否则后端「尚未 init」会拒绝所有项目/会话/prompt 命令 → 项目列表形同虚设。
      // 优先恢复上次项目（recent），无则新建会话。
      let lastCwd: string | null = null;
      try {
        lastCwd = localStorage.getItem("aiwb:last-cwd");
      } catch {
        /* ignore */
      }
      const initRes = await piSend({
        type: "open_dialogue",
        cwd: lastCwd ?? undefined,
        sessionMode: lastCwd ? "recent" : "new",
      }).catch(() => null);
      if (initRes?.success && initRes.data?.dialogueId) {
        set({ currentDialogueId: initRes.data.dialogueId });
        if (initRes.data.cwd) set({ currentCwd: initRes.data.cwd });
      }
      const [projRes, stateRes, modelRes, provRes] = await Promise.all([
        piSend({ type: "list_projects" }),
        piSend({ type: "get_state" }),
        piSend({ type: "get_available_models" }),
        piSend({ type: "get_providers" }).catch(() => null),
      ]);
      const projects = projRes?.success ? (projRes.data?.projects ?? []) : [];
      const cwd = stateRes?.success ? (stateRes.data?.cwd ?? null) : null;
      const dialogueId = stateRes?.success ? (stateRes.data?.dialogueId ?? null) : null;
      const models = modelRes?.success ? (modelRes.data?.models ?? []) : [];
      // 认证态 provider 集合：未认证 provider 的模型不出现在选择列表，
      // 避免用户选中 OpenCode Zen 之类未配 key 的 provider（模型同名，极易选错）
      const authedProviders = new Set(
        (provRes?.success ? (provRes.data?.providers ?? []) : [])
          .filter((p: { authed?: boolean }) => p.authed)
          .map((p: { id: string }) => p.id),
      );
      // 去重键 = provider:id（同 id 不同 provider 的模型都保留，标注提供商）
      const seen = new Set<string>();
      const uniqueModels = models.filter((m: { id: string; provider: string }) => {
        // 没有任何已认证 provider 时（首次使用/全部未配）不过滤，避免误杀
        if (authedProviders.size > 0 && !authedProviders.has(m.provider)) return false;
        const key = `${m.provider}:${m.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const modelId = stateRes?.success ? (stateRes.data?.model ?? null) : null;
      const provider = stateRes?.success ? (stateRes.data?.provider ?? null) : null;
      // 当前模型若属于未认证 provider（已被过滤）→ 置空，避免下拉显示幽灵选项
      const currentAuthed =
        authedProviders.size === 0 || (provider && authedProviders.has(provider));
      set({
        projects,
        currentCwd: cwd,
        currentDialogueId: dialogueId,
        models: uniqueModels,
        currentModelRef: currentAuthed && modelId && provider ? `${provider}/${modelId}` : null,
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

  refreshDialogues: async () => {
    try {
      const res = await piSend({ type: "list_dialogues" });
      if (res?.success) {
        set({ dialogues: res.data?.dialogues ?? [] });
        // 后端 currentDialogueId 与前端同步（启动时/重连后兜底）
        const cur = res.data?.currentDialogueId ?? null;
        if (cur && cur !== get().currentDialogueId) {
          set({ currentDialogueId: cur });
        }
      }
    } catch {
      /* ignore */
    }
  },

  activateDialogue: async (dialogueId) => {
    try {
      const res = await piSend({ type: "activate_dialogue", dialogueId });
      if (res?.success) {
        set({
          currentDialogueId: dialogueId,
          currentCwd: res.data?.cwd ?? get().currentCwd,
        });
        void get().refreshDialogues();
        window.dispatchEvent(new CustomEvent("pi:session-changed"));
        return true;
      }
      set({ error: res?.error ?? "切换对话失败" });
      return false;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  closeDialogue: async (dialogueId) => {
    try {
      const res = await piSend({ type: "close_dialogue", dialogueId });
      if (res?.success) {
        const wasCurrent = get().currentDialogueId === dialogueId;
        set((s) => ({ dialogues: s.dialogues.filter((d) => d.dialogueId !== dialogueId) }));
        if (wasCurrent) {
          // 关闭的是当前对话：切到列表里另一个对话，否则置空
          const next = get().dialogues[0] ?? null;
          if (next) await get().activateDialogue(next.dialogueId);
          else {
            set({ currentDialogueId: null, currentCwd: null });
            window.dispatchEvent(new CustomEvent("pi:session-changed"));
          }
        }
        void get().refreshDialogues();
        return true;
      }
      set({ error: res?.error ?? "关闭对话失败" });
      return false;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return false;
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
      // 切换前中止当前流式输出，避免旧项目输出与新项目切换竞态（后端串行队列兜底顺序）
      await piSend({ type: "abort" }).catch(() => {});
      const res = await piSend({ type: "switch_project", cwd, sessionMode: "recent" });
      if (res?.success) {
        set({ currentCwd: cwd, currentDialogueId: res.data?.dialogueId ?? null });
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