/**
 * PI 会话视图：AI 工作台的主界面。
 * 它不生成任何 AI 内容 —— 所有消息/工具/思考都来自真实 PI 会话事件流。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { bindPiEvents, piSend } from "../pi/bridge";
import { projectShortName, usePiUiStore } from "../pi/piUiStore";
import { ToolTimeline } from "./ToolTimeline";
import { MarkdownBody } from "./MarkdownBody";
import { TreePanel } from "./TreePanel";
import {
  addUserMessage,
  applyEvent,
  historyToMessages,
  markLastError,
  newUiState,
  type PiBlock,
  type PiViewMessage,
  type PiChatUiState,
} from "../pi/eventModel";
import { friendlyError, isRetryableError } from "../pi/errorFriendly";

/** 把剪贴板图片读取为 base64 dataURL；过大时 canvas 降采样到 ≤1280 控体积（防上游 413）。 */
function imageFileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 1280;
        let w = img.naturalWidth || 0;
        let h = img.naturalHeight || 0;
        const scale = Math.min(1, MAX / Math.max(w || 1, h || 1));
        if (scale < 1 && w && h) {
          w = Math.round(w * scale);
          h = Math.round(h * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("canvas context 不可用");
          ctx.drawImage(img, 0, 0, w, h);
          const ext = file.type === "image/png" ? "image/png" : "image/jpeg";
          resolve(canvas.toDataURL(ext, 0.85));
        } else {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error("读取图片失败"));
          r.readAsDataURL(file);
        }
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解析失败"));
    };
    img.src = url;
  });
}

const MAX_IMAGES = 4;

export function PiChatView() {
  const [treeOpen, setTreeOpen] = useState(false);
  // 消息多选模式：选中多条 → 复制/导出
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);
  // 切换项目/会话中（loading）时禁用发送，避免指令错发到上一个项目
  const loading = usePiUiStore((s) => s.loading);
  // 主区应用右键菜单（空白/消息区右键）
  const [appMenu, setAppMenu] = useState<{ x: number; y: number } | null>(null);
  const openAppMenu = (e: React.MouseEvent) => {
    // 消息文本选择区不做菜单（保留复制），仅空白/其它
    e.preventDefault();
    setAppMenu({ x: e.clientX, y: e.clientY });
  };
  const [ui, setUi] = useState<PiChatUiState>(newUiState);
  const [input, setInput] = useState("");
  // 待发送的图片附件（粘贴剪贴板图片），随消息一起发给 PI 多模态
  const [pendingImages, setPendingImages] = useState<{ data: string; mimeType: string }[]>([]);
  const [commands, setCommands] = useState<{ name: string; desc: string }[]>([]);
  const [completer, setCompleter] = useState<{
    open: boolean;
    items: { value: string; label: string; desc?: string }[];
    index: number;
    kind?: "commands" | "files";
  }>({ open: false, items: [], index: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- 输入历史（↑/↓ 翻历史指令，localStorage 持久化） ----
  const historyRef = useRef<string[]>([]);
  if (historyRef.current.length === 0) {
    // lazy 初始化（空历史合法，重载幂等）
    try {
      const raw = JSON.parse(localStorage.getItem("aiwb:cmd-history") ?? "[]") as string[];
      historyRef.current = Array.isArray(raw) ? raw : [];
    } catch {
      historyRef.current = [];
    }
  }
  const histIdxRef = useRef(-1); // -1 = 未在浏览历史
  const draftRef = useRef(""); // 浏览历史前的输入草稿
  const pushHistory = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const h = historyRef.current;
    if (h[h.length - 1] === trimmed) return; // 连续重复去重
    h.push(trimmed);
    if (h.length > 200) h.splice(0, h.length - 200);
    try {
      localStorage.setItem("aiwb:cmd-history", JSON.stringify(h));
    } catch {
      /* ignore */
    }
    histIdxRef.current = -1;
  }, []);
  // 浏览历史时把光标移到末尾（React 受控 value 恢复后 selection 默认在开头）
  const cursorToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  }, []);

  // ---- 对话记录本地实时保存（自动/手动） ----
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem("aiwb:autosave") === "1";
    } catch {
      return false;
    }
  });
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // 导出会话全文（markdown 阅读用 / jsonl 完整备份）到指定目录
  const saveSessionTo = useCallback(
    async (dir: string, filename: string, format: "markdown" | "jsonl"): Promise<string | null> => {
      try {
        const res = await piSend({ type: "export_session", format });
        if (!res?.success || !res.data?.content) return null;
        const { join } = await import("@tauri-apps/api/path");
        const { invoke } = await import("@tauri-apps/api/core");
        const full = await join(dir, filename);
        await invoke("write_text_file", { path: full, content: res.data.content });
        return full;
      } catch {
        return null;
      }
    },
    [],
  );
  // 自动保存：每轮对话结束（agent_end）把最新全文写入 Documents/PI Agent 对话记录/
  // （markdown 给人看 + jsonl 完整可恢复备份）
  const autoExport = useCallback(async () => {
    try {
      const { documentDir } = await import("@tauri-apps/api/path");
      const dir = await documentDir();
      const proj = projectShortName(usePiUiStore.getState().currentCwd ?? "未命名");
      const date = new Date().toISOString().slice(0, 10);
      const base = `${dir}PI Agent 对话记录`;
      const [md, jl] = await Promise.all([
        saveSessionTo(base, `${proj}-对话记录-${date}.md`, "markdown"),
        saveSessionTo(base, `${proj}-对话记录-${date}.jsonl`, "jsonl"),
      ]);
      if (md || jl) setLastSavedAt(Date.now());
    } catch {
      /* ignore */
    }
  }, [saveSessionTo]);
  const toggleAutoSave = useCallback(() => {
    setAutoSave((v) => {
      const next = !v;
      try {
        localStorage.setItem("aiwb:autosave", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  // 手动保存：导出 markdown → 弹保存对话框写本地（支持 md/jsonl/html/txt）
  const saveNow = useCallback(
    async (format: "markdown" | "jsonl" | "html" | "txt" = "markdown") => {
      try {
        const res = await piSend({ type: "export_session", format: "markdown" });
        if (!res?.success || !res.data?.content) return;
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { invoke } = await import("@tauri-apps/api/core");
        const date = new Date().toISOString().slice(0, 10);
        const proj = projectShortName(usePiUiStore.getState().currentCwd ?? "未命名");
        let content = res.data.content;
        let ext = "md";
        let filters = [{ name: "Markdown", extensions: ["md"] }];
        if (format === "jsonl") {
          const jl = await piSend({ type: "export_session", format: "jsonl" });
          if (!jl?.success) return;
          content = jl.data.content;
          ext = "jsonl";
          filters = [{ name: "PI 会话备份 (JSONL)", extensions: ["jsonl"] }];
        } else if (format === "html") {
          const { sessionHtml } = await import("../pi/sessionHtml");
          content = sessionHtml(res.data.content, `${proj} PI Agent 对话记录 ${date}`);
          ext = "html";
          filters = [{ name: "HTML 对话记录", extensions: ["html"] }];
        } else if (format === "txt") {
          const { sessionPlain } = await import("../pi/sessionHtml");
          content = sessionPlain(res.data.content);
          ext = "txt";
          filters = [{ name: "纯文本", extensions: ["txt"] }];
        }
        const path = await save({
          defaultPath: `${proj}-对话记录-${date}.${ext}`,
          filters,
        });
        if (!path) return;
        await invoke("write_text_file", { path, content });
        setLastSavedAt(Date.now());
      } catch {
        /* ignore */
      }
    },
    [],
  );
  // 导入会话：选择 jsonl 文件 → 打开为对话（可继续在 PI 中对话）
  const importSession = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "PI 会话 (JSONL)", extensions: ["jsonl"] }],
        title: "导入 PI 会话文件",
      });
      if (!picked || Array.isArray(picked)) return;
      const res = await piSend({ type: "open_dialogue", sessionPath: picked as string });
      if (res?.success) {
        usePiUiStore.setState({
          currentDialogueId: res.data?.dialogueId ?? null,
          currentCwd: res.data?.cwd ?? null,
        });
        window.dispatchEvent(new CustomEvent("pi:session-changed"));
      } else {
        setUi((prev) => markLastError(prev, `导入失败：${res?.error ?? "未知原因"}`));
      }
    } catch {
      /* ignore */
    }
  }, []);
  // 分享当前对话为 GitHub gist（弹 token 输入 + 公开/私密）
  const [shareOpen, setShareOpen] = useState(false);
  const [shareToken, setShareToken] = useState(() => {
    try {
      return localStorage.getItem("aiwb:gh-token") ?? "";
    } catch {
      return "";
    }
  });
  const [sharePublic, setSharePublic] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const shareGist = useCallback(async () => {
    const token = shareToken.trim();
    if (!token) return;
    setSharing(true);
    setShareUrl(null);
    try {
      const md = await piSend({ type: "export_session", format: "markdown" });
      if (!md?.success || !md.data?.content) return;
      const proj = projectShortName(usePiUiStore.getState().currentCwd ?? "未命名");
      const res = await piSend({
        type: "create_gist",
        content: md.data.content,
        filename: `${proj}-对话记录-${new Date().toISOString().slice(0, 10)}.md`,
        description: `PI Agent 对话记录 · ${proj}`,
        token,
        isPublic: sharePublic,
      });
      if (res?.success) {
        setShareUrl(res.data?.html_url ?? null);
        try {
          localStorage.setItem("aiwb:gh-token", token);
        } catch {
          /* ignore */
        }
      } else {
        setUi((prev) => markLastError(prev, `分享失败：${res?.error ?? "未知"}`));
      }
    } finally {
      setSharing(false);
    }
  }, [shareToken, sharePublic]);
  // 智能贴底：用户主动上滚时暂停自动跟随，滚回底部恢复
  const pinnedRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const lastEventRef = useRef(Date.now());
  const diagTimerRef = useRef(0);

  // ---- 事件批量合并（流式 delta 高频时把多个事件合并为一次 setUi） ----
  const eventQueueRef = useRef<any[]>([]);
  const flushTimerRef = useRef(0);
  // 宠物行为驱动：busy→忙碌转圈 / 消息流→思考 / settle→空闲
  const petStateRef = useRef("done");
  const emitPet = useCallback((state: string) => {
    if (petStateRef.current === state) return;
    petStateRef.current = state;
    try {
      void invoke("pet_event", { state }).catch(() => {});
    } catch {
      /* pet 未开/不可用忽略 */
    }
  }, []);
  const flushEvents = useCallback(() => {
    flushTimerRef.current = 0;
    const batch = eventQueueRef.current;
    eventQueueRef.current = [];
    if (batch.length === 0) return;
    setUi((prev) => batch.reduce((acc, e) => applyEvent(acc, e), prev));
    if (batch.some((e) => e?.type === "agent_settled" || e?.type === "message_end")) {
      void usePiUiStore.getState().refreshStats();
      emitPet("done");
    } else if (batch.some((e) => e?.type === "message_start" || e?.type === "agent_start")) {
      emitPet("busy");
    } else if (batch.some((e) => e?.type === "thinking_delta" || e?.type === "message_delta")) {
      emitPet("think");
    }
  }, [emitPet]);

  // 事件 → 状态（保持最新引用，防闭包过期；合并后一次渲染）
  const handleEvent = useCallback(
    (ev: any) => {
      // 多对话：后台对话（非当前激活）的流式事件不污染当前视图
      const activeDlg = usePiUiStore.getState().currentDialogueId;
      if (ev?._dialogueId && activeDlg && ev._dialogueId !== activeDlg) return;
      lastEventRef.current = Date.now();
      // 诊断：记录发送后的事件类型
      if (window.__piDiagEvents && ev?.type) {
        window.__piDiagEvents.add(ev.type);
      }
      eventQueueRef.current.push(ev);
      if (!flushTimerRef.current) {
        // 16ms 窗口合并：接近 60fps，且避免每个 delta 事件都触发一次全量渲染
        flushTimerRef.current = window.setTimeout(flushEvents, 16);
      }
    },
    [flushEvents],
  );

  // 绑定 sidecar 事件流（幂等）+ 拉取初始状态
  useEffect(() => {
    let disposed = false;
    void bindPiEvents((ev) => {
      if (disposed) return;
      handleEvent(ev);
      // 对话记录实时自动保存：每轮结束写最新全文（开关键在工具栏）
      if (autoSaveRef.current && (ev?.type === "agent_end" || ev?.type === "agent_settled")) {
        void autoExport();
      }
    });

    // 拉取状态 + 历史消息
    const reload = async () => {
      try {
        const [stateRes, msgsRes] = await Promise.all([
          piSend({ type: "get_state" }),
          piSend({ type: "get_messages" }),
        ]);
        if (disposed) return;
        if (stateRes?.success && stateRes.data) {
          setUi((prev) => ({
            ...prev,
            modelLabel: stateRes.data.model ?? "模型未知",
            busy: !!stateRes.data.isStreaming,
          }));
        }
        if (msgsRes?.success && Array.isArray(msgsRes.data?.messages)) {
          setUi((prev) => {
            const history = historyToMessages(msgsRes.data.messages);
            return { ...prev, messages: history.length ? history : prev.messages };
          });
        }
      } catch {
        /* 桥尚未就绪时静默 */
      }
    };
    void reload();

    // 侧栏切换会话后刷新：先清空旧会话消息，再拉新历史
    const onSessionChanged = () => {
      setUi((prev) => ({ ...prev, messages: [], lastError: null }));
      void reload();
    };
    window.addEventListener("pi:session-changed", onSessionChanged);
    // 全局快捷键 Ctrl+K：聚焦输入框
    const onFocusInput = () => inputRef.current?.focus();
    window.addEventListener("pi:focus-input", onFocusInput);
    const onInsertText = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (text) {
        setInput((prev) => (prev ? prev + text : text));
        inputRef.current?.focus();
        if (inputRef.current) inputRef.current.style.height = "auto";
      }
    };
    window.addEventListener("pi:insert-text", onInsertText);
    // 消息操作条「重发」：重新发送指定文本
    const onResend = (e: Event) => {
      const t = (e as CustomEvent<string>).detail;
      if (t) send(t);
    };
    window.addEventListener("pi:resend", onResend);
    return () => {
      disposed = true;
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = 0;
      eventQueueRef.current = [];
      window.removeEventListener("pi:session-changed", onSessionChanged);
      window.removeEventListener("pi:focus-input", onFocusInput);
      window.removeEventListener("pi:insert-text", onInsertText);
      window.removeEventListener("pi:resend", onResend);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleEvent]);

  // 滚动监听：判断是否在底部（阈值内算贴底）
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    pinnedRef.current = nearBottom;
    setAtBottom(nearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, []);

  // 跟随滚动：仅当贴底时自动滚到底（Agent 流式输出时允许用户上滚查看）
  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ui.messages, ui.busy]);

  // 粘贴剪贴板图片 → base64 附件（通知预览区；不拦截纯文本粘贴）
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: Blob[] = [];
    for (const it of items) {
      if (typeof it.type === "string" && it.type.startsWith("image/")) {
        const f = it.getAsFile?.();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return; // 纯文本粘贴交给默认行为
    e.preventDefault();
    void (async () => {
      const added: { data: string; mimeType: string }[] = [];
      for (const f of files.slice(0, MAX_IMAGES)) {
        const dataUrl = await imageFileToDataUrl(f).catch(() => null);
        if (!dataUrl) continue;
        const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
        if (m) added.push({ data: m[2], mimeType: m[1] });
      }
      if (added.length) setPendingImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES));
    })();
  }, []);

  const send = useCallback(
    (text?: string) => {
      const raw = (text ?? input).trim();
      const imgs = [...pendingImages];
      if (!raw && imgs.length === 0) return;
      const sendWith = async () => {
        const content = raw;
        // 发送即记入历史（↑/↓ 翻历史指令用）
        pushHistory(content);
        histIdxRef.current = -1;
        draftRef.current = "";
        setInput("");
        setPendingImages([]);
        if (inputRef.current) inputRef.current.style.height = "auto";
        setUi((prev) => addUserMessage(prev, content, imgs));
        const lastActivity = lastEventRef.current;
        // 记录本次发送后的事件流（诊断用：看 prompt 是否被接受、事件是否回来）
        const sentTypes = new Set<string>();
        window.__piDiagEvents = sentTypes;

        // @ 文件引用：把 @路径 替换为文件内容（拼接进消息正文）
        let payload = content;
        const refs = [...content.matchAll(/(^|\s)@([^\s]+)/g)];
        if (refs.length > 0) {
          for (const m of refs) {
            const p = m[2];
            if (p.startsWith("/") || p.startsWith("@")) continue; // 非文件引用
            try {
              const res = await piSend({ type: "read_file", path: p });
              if (res?.success) {
                const body = `<file path="${p}">\n${res.data.content}\n</file>`;
                payload = payload.replace(m[0], `${m[1]}${body}`);
              }
            } catch {
              /* 单文件失败保留原样 */
            }
          }
        }

        const attempt = (retryLeft: number): Promise<unknown> =>
          piSend({
            type: "prompt",
            message: payload,
            streamingBehavior: "steer",
            dialogueId: usePiUiStore.getState().currentDialogueId ?? undefined,
            images: imgs.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
          })
            .then((res) => {
              if (res && res.success === false) {
                const err = res.error ?? "";
                // 临时性错误（限流/过载/5xx/超时/网络）：自动重试（最多 2 次，指数退避）
                if (retryLeft > 0 && isRetryableError(err)) {
                  console.warn(`[diag] prompt 可重试错误，${retryLeft} 次后重试: ` + err.slice(0, 120));
                  return new Promise((r) => setTimeout(() => r(attempt(retryLeft - 1)), 1500 * (3 - retryLeft)));
                }
                console.warn("[diag] prompt rejected: " + err);
                setUi((prev) => markLastError(prev, friendlyError(err || "未知原因")));
              }
              return null;
            })
            .catch((e) => {
              console.warn("[diag] prompt send error: " + String(e));
              if (retryLeft > 0 && isRetryableError(String(e))) {
                return new Promise((r) => setTimeout(() => r(attempt(retryLeft - 1)), 1500 * (3 - retryLeft)));
              }
              setUi((prev) => markLastError(prev, friendlyError(String(e))));
              return null;
            });
        void attempt(2);
        // 无响应诊断：10 秒后若仍未收到任何事件，才提示（正常流式不打扰）
        window.clearTimeout(diagTimerRef.current);
        diagTimerRef.current = window.setTimeout(async () => {
          const types = window.__piDiagEvents ? [...window.__piDiagEvents].join(",") : "(无)";
          const got = lastEventRef.current !== lastActivity;
          if (got || uiRef.current.busy) return; // 有事件/仍在忙 → 正常，不打扰
          // 完全静默：仅 console 保留一条探活，供排查
          try {
            const st = await piSend({ type: "get_state" });
            console.warn(
              "[diag] 发送 10s 无事件: streaming=" + st?.data?.isStreaming + " err=" + (st?.data?.errorMessage ?? "无"),
            );
          } catch {
            /* ignore */
          }
          setUi((prev) =>
            markLastError(
              prev,
              "已发送但 10 秒内未收到 PI 响应（事件流: " + types + "）。请点「停止」后重发，或重启窗口。",
            ),
          );
        }, 10000);
      };
      void sendWith();
    },
    [input, pendingImages],
  );

  const stop = useCallback(() => {
    void piSend({ type: "abort" }).catch(() => {});
  }, []);

  // 加载可用命令（技能 + 提示词模板）用于补全
  useEffect(() => {
    void (async () => {
      try {
        const res = await piSend({ type: "get_commands" });
        if (res?.success && res.data) {
          const list: { name: string; desc: string }[] = [];
          for (const s of res.data.skills ?? []) list.push({ name: `skill:${s.name}`, desc: s.description ?? "" });
          for (const p of res.data.prompts ?? []) list.push({ name: p.name, desc: p.description ?? "" });
          setCommands(list);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const handleInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  // 输入变化：更新斜杠补全
  const handleInputChange = (value: string) => {
    setInput(value);
    handleInput();
    // @ 文件引用补全：@ 开头或行内 @文字 → 搜索项目文件
    const atMatch = /(^|\s)@([\w./\\-]*)$/.exec(value);
    if (atMatch) {
      const q = atMatch[2] ?? "";
      setCompleter({ open: true, items: [], index: 0, kind: "files" });
      void piSend({ type: "search_files", query: q, maxCount: 20 })
        .then((res) => {
          const files = (res?.data?.files ?? []).map((f: { path: string }) => ({
            value: f.path,
            label: f.path.split("/").pop() ?? f.path,
            desc: f.path,
          }));
          setCompleter((c) =>
            c.open && c.kind === "files" ? { ...c, items: files, open: files.length > 0 } : c,
          );
        })
        .catch(() => setCompleter((c) => ({ ...c, open: false })));
      return;
    }
    if (value.startsWith("/") && !value.includes(" ")) {
      const q = value.slice(1).toLowerCase();
      const items = [
        ...commands
          .filter((c) => c.name.toLowerCase().includes(q))
          .map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, desc: c.desc })),
        ...BUILTIN_COMMANDS.filter((c) => c.value.toLowerCase().includes(q)),
      ].slice(0, 12);
      if (items.length > 0) setCompleter({ open: true, items, index: 0, kind: "commands" });
      else setCompleter((c) => ({ ...c, open: false }));
    } else {
      setCompleter((c) => ({ ...c, open: false }));
    }
  };

  const applyCompleter = (item: { value: string; label: string; desc?: string }) => {
    const kind = completer.kind;
    if (kind === "files") {
      // @ 补全：把 @文字 替换为 @路径
      const atMatch = /(^|\s)@([\w./\\-]*)$/.exec(input);
      if (atMatch) {
        const prefix = atMatch[1];
        const next = `${prefix}@${item.value} `;
        setInput(next);
        handleInputChange(next);
        inputRef.current?.focus();
      }
      setCompleter((c) => ({ ...c, open: false }));
      return;
    }
    setInput(item.value);
    setCompleter((c) => ({ ...c, open: false }));
    inputRef.current?.focus();
  };

  const moveCompleter = (dir: 1 | -1) => {
    setCompleter((c) => {
      if (!c.open || c.items.length === 0) return c;
      const index = (c.index + dir + c.items.length) % c.items.length;
      return { ...c, index };
    });
  };

  // codex 风格：空对话（无消息、非忙碌）时输入框居中；有消息后沉底
  const isNewChat = ui.messages.length === 0 && !ui.busy;

  return (
    <div className="chat" onContextMenu={openAppMenu}>
      <div className="chat__main">
        <div className="chat__main-left">
          <div className="chat__scroll pi-scroll" ref={scrollRef} onScroll={handleScroll}>
            {!atBottom && (
              <button className="chat__goto-tail" onClick={scrollToBottom}>
                ↓ 回到底部
              </button>
            )}
            {ui.messages.length === 0 ? (
              <div className="chat__empty">
                <p>已连接真实 PI。在这里输入消息，底层 PI 将处理一切。</p>
                <p className="chat__empty-dim">提示：支持斜杠命令、技能、多轮对话、执行命令 / 编辑代码 / 读写文件</p>
              </div>
            ) : (
              <div className="pi-list">
                <MessageWindow
                  messages={ui.messages}
                  scrollRef={scrollRef}
                  selectMode={selectMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                />
                {ui.busy && <div className="pi-busy">PI 正在处理…</div>}
              </div>
            )}
            {ui.lastError && <div className="pi-errorbar">⚠️ {ui.lastError}</div>}
          </div>

          {/* 消息多选操作条 */}
          {selectMode && (
            <div className="selbar">
              <span className="selbar__count">已选 {selectedIds.size} 条</span>
              <button
                className="chip chip--sm"
                onClick={() => {
                  // 复制选中消息纯文本
                  const texts = ui.messages.filter((m) => selectedIds.has(m.id)).map((m) =>
                    msgPlainText(m.blocks),
                  );
                  void navigator.clipboard.writeText(texts.filter(Boolean).join("\n\n"));
                }}
                disabled={selectedIds.size === 0}
              >
                复制选中
              </button>
              <button
                className="chip chip--sm"
                onClick={() => {
                  // 导出选中消息为 Markdown
                  const parts = ui.messages.filter((m) => selectedIds.has(m.id)).map((m) => {
                    const header = m.role === "user" ? "## 👤 用户" : "## 🤖 PI";
                    const text = msgPlainText(m.blocks);
                    return text ? `${header}\n\n${text}` : null;
                  });
                  const md = parts.filter(Boolean).join("\n\n");
                  if (!md) return;
                  void (async () => {
                    try {
                      const { save } = await import("@tauri-apps/plugin-dialog");
                      const { invoke } = await import("@tauri-apps/api/core");
                      const path = await save({
                        defaultPath: `选中消息-${new Date().toISOString().slice(0, 10)}.md`,
                        filters: [{ name: "Markdown", extensions: ["md"] }],
                      });
                      if (!path) return;
                      await invoke("write_text_file", { path, content: md });
                    } catch {
                      /* ignore */
                    }
                  })();
                }}
                disabled={selectedIds.size === 0}
              >
                导出选中为 MD
              </button>
              <button
                className="chip chip--sm"
                onClick={() => {
                  // 导出选中消息为带样式 HTML（可分享/归档）
                  const parts = ui.messages.filter((m) => selectedIds.has(m.id)).map((m) => {
                    const header = m.role === "user" ? "## 👤 用户" : "## 🤖 PI";
                    const text = msgPlainText(m.blocks);
                    return text ? `${header}\n\n${text}` : null;
                  });
                  const md = parts.filter(Boolean).join("\n\n");
                  if (!md) return;
                  void (async () => {
                    try {
                      const { save } = await import("@tauri-apps/plugin-dialog");
                      const { invoke } = await import("@tauri-apps/api/core");
                      const { sessionHtml } = await import("../pi/sessionHtml");
                      const path = await save({
                        defaultPath: `选中消息-${new Date().toISOString().slice(0, 10)}.html`,
                        filters: [{ name: "HTML 对话记录", extensions: ["html"] }],
                      });
                      if (!path) return;
                      await invoke("write_text_file", {
                        path,
                        content: sessionHtml(md, "PI Agent 选中消息"),
                      });
                    } catch {
                      /* ignore */
                    }
                  })();
                }}
                disabled={selectedIds.size === 0}
              >
                导出选中为 HTML
              </button>
              <button
                className="chip chip--sm"
                onClick={() => {
                  // 全选（仅当前会话消息）
                  if (selectedIds.size === ui.messages.length) exitSelect();
                  else setSelectedIds(new Set(ui.messages.map((m) => m.id)));
                }}
              >
                {selectedIds.size === ui.messages.length ? "取消全选" : "全选"}
              </button>
              <button className="chip chip--sm selbar__exit" onClick={exitSelect}>
                ✕ 退出选择
              </button>
            </div>
          )}
          <div className={`chat__inputbar${isNewChat ? " chat__inputbar--centered" : ""}`}>
            <div className="chat__composer">
              {completer.open && completer.items.length > 0 && (
                <div className="completer">
                  {completer.items.map((item, i) => (
                    <div
                      key={item.value}
                      className={`completer__item${i === completer.index ? " completer__item--active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyCompleter(item);
                      }}
                    >
                      <span className="completer__label">{item.label}</span>
                      {item.desc && <span className="completer__desc">{item.desc.slice(0, 40)}</span>}
                    </div>
                  ))}
                </div>
              )}
              {pendingImages.length > 0 && (
                <div className="chat__images">
                  {pendingImages.map((img, i) => (
                    <div className="chat__img" key={i}>
                      <img src={`data:${img.mimeType};base64,${img.data}`} alt={`图 ${i + 1}`} />
                      <button
                        className="chat__img-del"
                        title="移除图片"
                        onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                className="chat__textarea"
                onPaste={handlePaste}
                value={input}
                disabled={loading}
                placeholder="发送给 PI…（/ 命令补全，Enter 发送，Shift+Enter 换行）"
                rows={1}
                onChange={(e) => handleInputChange(e.target.value)}
                onInput={handleInput}
                onKeyDown={(e) => {
                  if (completer.open && completer.items.length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      moveCompleter(1);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      moveCompleter(-1);
                      return;
                    }
                    if (e.key === "Tab" || e.key === "Enter") {
                      e.preventDefault();
                      applyCompleter(completer.items[completer.index]);
                      return;
                    }
                    if (e.key === "Escape") {
                      setCompleter((c) => ({ ...c, open: false }));
                      return;
                    }
                  }
                  // ↑/↓：翻历史指令（无补全弹出时）
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    const h = historyRef.current;
                    if (h.length === 0) return;
                    if (histIdxRef.current === -1) {
                      draftRef.current = inputRef.current?.value ?? input; // 保存当前输入
                      histIdxRef.current = h.length - 1;
                    } else if (histIdxRef.current > 0) {
                      histIdxRef.current--;
                    }
                    setInput(h[histIdxRef.current]);
                    cursorToEnd();
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    const h = historyRef.current;
                    if (histIdxRef.current === -1) return;
                    if (histIdxRef.current < h.length - 1) {
                      histIdxRef.current++;
                      setInput(h[histIdxRef.current]);
                    } else {
                      histIdxRef.current = -1;
                      setInput(draftRef.current);
                    }
                    cursorToEnd();
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
            </div>
            {ui.busy ? (
              <button className="btn btn--danger" onClick={stop} title="中止 PI 当前操作">
                ■ 停止
              </button>
            ) : (
              <button className="btn btn--primary" onClick={() => send()} disabled={loading || (!input.trim() && pendingImages.length === 0)}>
                发送
              </button>
            )}
          </div>

          <ToolBar
            onTree={() => setTreeOpen(true)}
            onSave={(f) => void saveNow(f)}
            onImport={() => void importSession()}
            onShare={() => setShareOpen(true)}
            onSelect={() => setSelectMode((v) => !v)}
            selectMode={selectMode}
            autoSave={autoSave}
            onToggleAutoSave={toggleAutoSave}
            lastSavedAt={lastSavedAt}
          />
        </div>

        <ToolTimeline tools={ui.tools} />
      </div>

      <TreePanel open={treeOpen} onClose={() => setTreeOpen(false)} />

      {/* 分享对话框（GitHub gist） */}
      {shareOpen && (
        <div className="settings-overlay" onClick={() => setShareOpen(false)}>
          <div className="settings share-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="settings__head">
              <span className="settings__title">🌐 分享当前对话为 Gist</span>
              <button className="settings__close" onClick={() => setShareOpen(false)}>
                ✕
              </button>
            </div>
            <div className="settings__main">
              <div className="settings__body">
                {shareUrl ? (
                  <div className="share-dialog__done">
                    <p>已发布{sharePublic ? "（公开）" : "（私密）"}，链接：</p>
                    <code className="share-dialog__url" onClick={() => void navigator.clipboard.writeText(shareUrl ?? "")} title="点击复制">
                      {shareUrl}
                    </code>
                    <button
                      className="btn btn--primary"
                      onClick={() => void navigator.clipboard.writeText(shareUrl ?? "")}
                    >
                      复制链接
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="share-dialog__hint">
                      需要 GitHub Token（settings → Developer settings → Personal access tokens，勾选 gist 权限）。
                      Token 仅保存在本机（aiwb:gh-token）。
                    </div>
                    <input
                      type="password"
                      className="settings__keyinput"
                      placeholder="GitHub Personal Access Token（ghp_…）"
                      value={shareToken}
                      onChange={(e) => setShareToken(e.target.value)}
                    />
                    <label className="share-dialog__opt">
                      <input type="checkbox" checked={sharePublic} onChange={(e) => setSharePublic(e.target.checked)} />
                      公开（所有人可见）；取消勾选 = 私密 gist
                    </label>
                    <button
                      className="btn btn--primary"
                      onClick={() => void shareGist()}
                      disabled={sharing || !shareToken.trim()}
                    >
                      {sharing ? "发布中…" : "发布为 Gist"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {appMenu && (
        <div className="app-ctx" style={{ left: appMenu.x, top: appMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="app-ctx__item"
            onClick={() => {
              setAppMenu(null);
              window.dispatchEvent(new CustomEvent("pi:open-settings"));
            }}
          >
            ⚙ 设置
          </button>
          <button
            className="app-ctx__item"
            onClick={() => {
              setAppMenu(null);
              void piSend({ type: "new_session" }).then(() => setTreeOpen(false));
            }}
          >
            ➕ 新建会话
          </button>
          <button className="app-ctx__item" onClick={() => { setAppMenu(null); setTreeOpen(true); }}>
            🌳 会话树
          </button>
          <div className="app-ctx__sep" />
          <button className="app-ctx__item" onClick={() => setAppMenu(null)}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}

/** 消息卡片 memo：流式更新时只有最后一条消息的引用变化，其余消息直接跳过渲染 */

/**
 * 长会话无缝滚动：react-virtual 虚拟化——DOM 只渲染可见区 (+overscan)，
 * 万条消息也能直接滚到底，无需「加载更多」；消息高度动态测量（measureElement）。
 */
function MessageWindow({
  messages,
  scrollRef,
  selectMode,
  selectedIds,
  onToggleSelect,
}: {
  messages: PiViewMessage[];
  scrollRef: { current: HTMLDivElement | null };
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const total = messages.length;
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (messages[i]?.role === "user" ? 56 : 88),
    overscan: 8,
    getItemKey: (i) => messages[i]?.id ?? i,
  });
  const items = virtualizer.getVirtualItems();

  // 找该条之前最近的用户文本（AI 消息「重新生成」时用）：只在可见项范围内向前扫（性能）
  const visibleStart = items.length ? items[0].index : 0;
  const prevUserCache = useMemo(() => {
    const map = new Map<number, string>();
    let lastUser = "";
    for (let i = 0; i <= visibleStart + messages.length; i++) {
      const m = messages[i];
      if (!m) break;
      if (m.role === "user") {
        const tb = m.blocks.find((b) => b.kind === "text");
        lastUser = tb?.text ?? "";
      }
      if (i >= visibleStart) map.set(i, lastUser);
    }
    return map;
  }, [messages, visibleStart]);

  return (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
      {items.map((vi) => {
        const m = messages[vi.index];
        if (!m) return null;
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vi.start}px)`,
            }}
          >
            <MessageCard
              msg={m}
              prevUserText={prevUserCache.get(vi.index) ?? ""}
              selectMode={selectMode}
              selected={selectedIds.has(m.id)}
              onToggleSelect={() => onToggleSelect(m.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

const MessageCard = memo(function MessageCard({
  msg,
  prevUserText = "",
  selectMode = false,
  selected = false,
  onToggleSelect,
}: {
  msg: { role: "user" | "assistant"; blocks: PiBlock[]; status: string; id: string };
  prevUserText?: string;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  // 消息编辑（仅用户消息）：fork 到该消息之前 → 新会话用新文本重发
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (msg.role === "user") {
    const textBlock = msg.blocks.find((b) => b.kind === "text");
    const plain = textBlock?.text ?? "";
    const images = msg.blocks.filter((b): b is Extract<PiBlock, { kind: "image" }> => b.kind === "image");
    const confirmEdit = async () => {
      const text = draft.trim();
      if (!text) {
        setEditing(false);
        return;
      }
      setEditing(false);
      // fork（position=before）到此用户消息 → 新分支从它之前开始
      const res = await piSend({ type: "fork", entryId: msg.id }).catch(() => null);
      if (res?.success) {
        window.dispatchEvent(new CustomEvent("pi:session-changed"));
        // 发送编辑后文本（成为新分支的第一条；复用重发通道）
        window.dispatchEvent(new CustomEvent("pi:resend", { detail: text }));
      }
    };
    return (
      <div
        className={`msg msg--user${selected ? " msg--selected" : ""}`}
        onClick={selectMode ? onToggleSelect : undefined}
      >
        <div className="msg__stack">
          {selectMode && (
            <div className={`msg__sel${selected ? " msg__sel--on" : ""}`}>
              <input type="checkbox" checked={selected} onChange={onToggleSelect} />
            </div>
          )}
          {editing ? (
            <div className="msg__edit">
              <textarea
                className="msg__edit-input"
                rows={3}
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => setEditing(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void confirmEdit();
                  if (e.key === "Escape") setEditing(false);
                }}
              />
              <div className="msg__edit-btns">
                <button className="btn btn--primary btn--sm" onMouseDown={(e) => e.preventDefault()} onClick={() => void confirmEdit()}>
                  保存并重发
                </button>
                <button className="btn btn--sm" onClick={() => setEditing(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="msg__body msg__body--user">
                {images.length > 0 && (
                  <div className="msg__images">
                    {images.map((im, i) => (
                      <img
                        key={i}
                        className="msg__image"
                        src={`data:${im.mimeType};base64,${im.data}`}
                        alt={`图片 ${i + 1}`}
                      />
                    ))}
                  </div>
                )}
                <div className="msg__text">{plain ? <p>{plain}</p> : null}</div>
              </div>
              <MsgOps
                text={plain}
                canResend={!!plain}
                onEdit={() => {
                  setDraft(plain);
                  setEditing(true);
                }}
              />
            </>
          )}
        </div>
      </div>
    );
  }

  const streaming = msg.status === "streaming" || msg.blocks.some((b) => b.kind === "toolCall" && b.status === "running");
  const plain = msgPlainText(msg.blocks);

  return (
    <div
      className={`msg msg--assistant${selected ? " msg--selected" : ""}`}
      onClick={selectMode ? onToggleSelect : undefined}
    >
      {selectMode && (
        <div className={`msg__sel msg__sel--assistant${selected ? " msg__sel--on" : ""}`}>
          <input type="checkbox" checked={selected} onChange={onToggleSelect} />
        </div>
      )}
      <div className="msg__avatar" title="PI">PI</div>
      <div className="msg__body">
        {msg.blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
        {streaming && <span className="msg__caret" />}
        <MsgOps text={plain} canResend={!!prevUserText} resendText={prevUserText} />
      </div>
    </div>
  );
});

/** 消息纯文本（复制 / 保存用）：正文 + 工具输出 */
function msgPlainText(blocks: PiBlock[]): string {
  return blocks
    .filter((b) => b.kind === "text" || b.kind === "toolResult")
    .map((b) => b.text)
    .join("\n\n");
}

/** 消息操作条：复制 / 重发 / 保存为文档 / 编辑（hover 显示，低调） */
function MsgOps({
  text,
  canResend,
  resendText,
  onEdit,
}: {
  text: string;
  canResend: boolean;
  resendText?: string;
  onEdit?: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const saveAsDoc = async () => {
    if (!text) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await save({
        defaultPath: `对话-导出-${new Date().toISOString().slice(0, 10)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      await invoke("write_text_file", { path, content: text });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch {
      // 非 Tauri 环境：降级为浏览器下载
      try {
        const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "对话-导出.md";
        a.click();
        URL.revokeObjectURL(a.href);
      } catch {
        /* ignore */
      }
    }
  };
  if (!text) return null;
  return (
    <div className="msg-ops">
      <button className="msg-ops__btn" title="复制全文" onClick={() => void navigator.clipboard.writeText(text)}>
        复制
      </button>
      <button
        className="msg-ops__btn"
        title="把这条消息作为引用插入输入框（供追问/反驳）"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("pi:insert-text", {
              detail: text
                .split("\n")
                .map((l) => `> ${l}`)
                .join("\n") + "\n\n",
            }),
          )
        }
      >
        引用
      </button>
      {canResend && (
        <button
          className="msg-ops__btn"
          title="重新发送"
          onClick={() => window.dispatchEvent(new CustomEvent("pi:resend", { detail: resendText || text }))}
        >
          重发
        </button>
      )}
      <button className="msg-ops__btn" title="保存为 Markdown 文档" onClick={() => void saveAsDoc()}>
        {saved ? "已保存" : "保存"}
      </button>
      {onEdit && (
        <button className="msg-ops__btn" title="编辑这条消息，从此处重新生成（fork 分支）" onClick={onEdit}>
          ✏️ 编辑
        </button>
      )}
    </div>
  );
}

function BlockView({ block }: { block: PiBlock }) {
  switch (block.kind) {
    case "image":
      return (
        <div className="msg__images">
          <img className="msg__image" src={`data:${block.mimeType};base64,${block.data}`} alt="图片" />
        </div>
      );
    case "text":
      return <MarkdownBody text={block.text} />;
    case "thinking":
      return (
        <details className="pi-thinking" open={false}>
          <summary>💭 思考过程 {block.text ? `(${block.text.length} 字)` : "…"}</summary>
          <pre className="pi-thinking__pre">{block.text || "…"}</pre>
        </details>
      );
    case "toolCall": {
      const statusMap = {
        pending: "⏳ 待执行",
        running: "▶ 执行中",
        done: "✓ 完成",
        error: "✗ 失败",
      } as const;
      return (
        <div className={`pi-toolcall pi-toolcall--${block.status}`}>
          <div className="pi-toolcall__bar">
            <span className="pi-toolcall__name">🔧 {block.name}</span>
            <span className="pi-toolcall__status">{statusMap[block.status]}</span>
          </div>
          {block.argsText && block.argsText !== "{}" && (
            <details open={block.status === "done"}>
              <summary>参数</summary>
              <pre className="pi-toolcall__args">{block.argsText}</pre>
            </details>
          )}
        </div>
      );
    }
    case "toolResult":
      return (
        <div className={`pi-toolresult${block.isError ? " pi-toolresult--error" : ""}`}>
          <pre className="pi-toolresult__pre">{block.text}</pre>
        </div>
      );
    case "error":
      return <div className="msg__error">⚠️ {block.text}</div>;
    default:
      return null;
  }
}

/**
 * 输入框下方工具栏：项目选择 + 模型选择。
 */
const ToolBar = memo(function ToolBar({
  onTree,
  onSave,
  onImport,
  onShare,
  onSelect,
  selectMode,
  autoSave,
  onToggleAutoSave,
  lastSavedAt,
}: {
  onTree: () => void;
  onSave: (format: "markdown" | "jsonl" | "html" | "txt") => void;
  onImport: () => void;
  onShare: () => void;
  onSelect: () => void;
  selectMode: boolean;
  autoSave: boolean;
  onToggleAutoSave: () => void;
  lastSavedAt: number | null;
}) {
  const projects = usePiUiStore((s) => s.projects);
  const currentCwd = usePiUiStore((s) => s.currentCwd);
  const switchProject = usePiUiStore((s) => s.switchProject);
  const models = usePiUiStore((s) => s.models);
  const currentModelRef = usePiUiStore((s) => s.currentModelRef);
  const setModel = usePiUiStore((s) => s.setModel);
  const loading = usePiUiStore((s) => s.loading);
  const error = usePiUiStore((s) => s.error);
  const stats = usePiUiStore((s) => s.stats);
  const thinkingLevel = usePiUiStore((s) => s.thinkingLevel);
  const setThinking = usePiUiStore((s) => s.setThinking);
  const compact = usePiUiStore((s) => s.compact);
  const [compacting, setCompacting] = useState(false);

  const context = stats?.contextUsage;
  const percent = context?.percent ?? null;
  const cost = stats?.cost;
  const costNum = typeof cost === "number" ? cost : cost?.total;

  // 原始载荷预警（上游 413 限制近似）：4MB 警告，8MB 危险
  const payloadInfo = useMemo(() => {
    const bytes = stats?.payloadBytes ?? 0;
    if (!bytes) return null;
    const mb = bytes / (1024 * 1024);
    const text = mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
    if (mb >= 8) return { text, level: "danger" as const };
    if (mb >= 4) return { text, level: "warn" as const };
    return { text, level: "ok" as const };
  }, [stats?.payloadBytes]);

  // 模型下拉候选（去重 + 限量），避免每次渲染重复 filter/slice
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: { ref: string; label: string }[] = [];
    for (const m of models) {
      const ref = `${m.provider}/${m.id}`;
      if (ref === currentModelRef) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      list.push({ ref, label: `${m.name}（${m.provider}）` });
      if (list.length >= 100) break;
    }
    return list;
  }, [models, currentModelRef]);

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        <label className="toolbar__label" title="当前项目（工作目录）">
          项目
        </label>
        <select
          className="toolbar__select"
          value={currentCwd ?? ""}
          disabled={loading}
          onChange={(e) => {
            if (e.target.value) void switchProject(e.target.value);
          }}
        >
          {currentCwd ? (
            <option value={currentCwd}>{projectShortName(currentCwd)}</option>
          ) : null}
          {projects
            .filter((p) => p.cwd !== currentCwd)
            .map((p) => (
              <option key={p.cwd} value={p.cwd}>
                {projectShortName(p.cwd)}
              </option>
            ))}
        </select>
      </div>

      <div className="toolbar__group">
        <label className="toolbar__label" title="当前模型（带提供商标注）">
          模型
        </label>
        <select
          className="toolbar__select"
          value={currentModelRef ?? ""}
          onChange={(e) => {
            if (e.target.value) void setModel(e.target.value);
          }}
        >
          {loading && models.length === 0 && <option value="">加载模型中…</option>}
          {currentModelRef && (
            <option value={currentModelRef}>
              {modelLabel(models, currentModelRef)}
            </option>
          )}
          {modelOptions.map((o) => (
            <option key={o.ref} value={o.ref}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__group">
        <label className="toolbar__label" title="思考/推理强度">
          思考
        </label>
        <select
          className="toolbar__select"
          value={thinkingLevel ?? "medium"}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            void setThinking(v);
            // 同时写回默认思考级别，保证下次启动沿用本次选择
            void piSend({ type: "set_setting", key: "defaultThinkingLevel", value: v });
          }}
        >
          {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((lv) => (
            <option key={lv} value={lv}>
              {lv}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__group toolbar__ctx" title="当前上下文占用 / 总窗口（真实 PI 数据）">
        <label className="toolbar__label">上下文</label>
        <div className="ctxbar">
          <div
            className={`ctxbar__fill${percent !== null && percent > 80 ? " ctxbar__fill--warn" : ""}`}
            style={{ width: `${Math.min(percent ?? 0, 100)}%` }}
          />
        </div>
        <span className="ctxbar__text">
          {percent !== null ? `${percent.toFixed(1)}%` : "—"}
        </span>
      </div>

      <div className="toolbar__group toolbar__stats" title="会话 token 总量与费用（真实 PI 统计）">
        <span className="toolbar__stat">
          {stats?.tokens?.total != null ? fmtTokens(stats.tokens.total) : "--"} tok
        </span>
        <span className="toolbar__stat">
          ${costNum != null ? costNum.toFixed(2) : "--"}
        </span>
        {payloadInfo && (
          <span
            className={`toolbar__stat toolbar__payload${payloadInfo.level === "danger" ? " toolbar__payload--danger" : payloadInfo.level === "warn" ? " toolbar__payload--warn" : ""}`}
            title="原始请求体大小（序列化全部消息）。过大时上游可能拒绝（413），建议压缩上下文"
          >
            📦 {payloadInfo.text}
            {payloadInfo.level !== "ok" && (
              <button
                className="chip chip--sm toolbar__payload-btn"
                onClick={() => {
                  setCompacting(true);
                  void compact().finally(() => setCompacting(false));
                }}
                title="立即压缩上下文，减小请求体"
              >
                压缩
              </button>
            )}
          </span>
        )}
      </div>

      <button
        className="chip chip--sm"
        onClick={() => {
          setCompacting(true);
          void compact().finally(() => setCompacting(false));
        }}
        title="手动压缩上下文（compact），降低 token 占用"
      >
        {compacting ? "压缩中…" : "⚙ 压缩上下文"}
      </button>

      <button
        className={`chip chip--sm${selectMode ? " chip--active" : ""}`}
        onClick={onSelect}
        title="进入多选模式：点消息勾选，批量复制/导出"
      >
        ☑️ 选择
      </button>
      <button
        className="chip chip--sm"
        onClick={onTree}
        title="会话树：可视化消息分支，点击可从历史消息回溯/分支"
      >
        🌳 会话树
      </button>

      <button
        className="chip chip--sm"
        onClick={() => onSave("markdown")}
        title="保存当前对话为 Markdown（本地导出全文）"
      >
        💾 存 MD
      </button>
      <button
        className="chip chip--sm"
        onClick={() => onSave("html")}
        title="导出为带样式的 HTML 对话记录页（可分享/归档）"
      >
        📄 存 HTML
      </button>
      <button
        className="chip chip--sm"
        onClick={() => onSave("jsonl")}
        title="导出当前会话为 JSONL（完整备份，可导入恢复）"
      >
        💾 存 JSONL
      </button>
      <button className="chip chip--sm" onClick={onImport} title="导入 PI 会话文件（jsonl），继续对话">
        📥 导入
      </button>
      <button className="chip chip--sm" onClick={onShare} title="把当前对话分享为 GitHub gist 链接">
        🌐 分享
      </button>
      <button
        className={`chip chip--sm${autoSave ? " chip--active" : ""}`}
        onClick={onToggleAutoSave}
        title="自动保存：每轮对话结束自动写入 文档/PI Agent 对话记录/（MD + JSONL 双备份）"
      >
        ⏺ 自动保存{autoSave ? "·开" : "·关"}
      </button>
      {lastSavedAt && (
        <span className="toolbar__stat" title="最近一次保存时间">
          💾 {new Date(lastSavedAt).toLocaleTimeString()}
        </span>
      )}

      <div className="toolbar__right">
        {loading && <span className="toolbar__hint">切换中…</span>}
        {error && <span className="toolbar__err">⚠️ {error}</span>}
      </div>
    </div>
  );
});

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 由 "provider/id" 引用取展示名（含提供商标注） */
function modelLabel(models: { id: string; name: string; provider: string }[], ref: string): string {
  const [provider, id] = ref.split("/");
  const m = models.find((x) => x.provider === provider && x.id === id);
  return m ? `${m.name}（${m.provider}）` : ref;
}

/** PI 内建常用命令（补全用） */
const BUILTIN_COMMANDS: { value: string; label: string; desc: string }[] = [
  { value: "/model", label: "/model", desc: "切换模型" },
  { value: "/compact", label: "/compact", desc: "压缩上下文" },
  { value: "/new", label: "/new", desc: "新会话" },
  { value: "/resume", label: "/resume", desc: "恢复历史会话" },
  { value: "/name", label: "/name", desc: "设置会话名" },
  { value: "/fork", label: "/fork", desc: "从历史消息分支" },
  { value: "/clone", label: "/clone", desc: "克隆当前分支" },
  { value: "/export", label: "/export", desc: "导出会话" },
  { value: "/import", label: "/import", desc: "导入会话" },
  { value: "/session", label: "/session", desc: "会话统计信息" },
  { value: "/tree", label: "/tree", desc: "会话树跳转" },
  { value: "/copy", label: "/copy", desc: "复制上一条回复" },
  { value: "/reload", label: "/reload", desc: "重载技能/扩展/提示词" },
  { value: "/help", label: "/help", desc: "帮助" },
];