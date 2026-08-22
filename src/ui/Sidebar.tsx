/**
 * 侧栏：品牌 + 树状结构（未分类会话 + 项目节点可展开其会话）+ 技能库 + 主题 + 设置。
 * 数据来自 list_all_sessions（按项目分组，全部真实 PI 会话）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyTheme, loadTheme, THEMES, type ThemeName } from "../app/theme";
import { loadZoom } from "../app/zoom";
import { bindPiEvents, piSend } from "../pi/bridge";
import { projectShortName, usePiUiStore, type DialogueItem } from "../pi/piUiStore";
import { SettingsPanel } from "./SettingsPanel";
import { ContextDialog } from "./ContextDialog";
import { AddProjectDialog } from "./AddProjectDialog";
import { SkillDialog } from "./SkillDialog";
import { PinIcon, BubbleIcon, PencilIcon, LinkIcon, PlusIcon } from "./icons";

interface PiSessionItem {
  path: string;
  id: string;
  cwd?: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  firstMessage?: string;
}

interface SkillItem {
  name: string;
  description?: string;
  filePath?: string;
}

interface ProjectNode {
  cwd: string;
  sessions: PiSessionItem[];
}



/** 通知主视图刷新（切换会话/项目后） */
export function notifySessionChanged(): void {
  window.dispatchEvent(new CustomEvent("pi:session-changed"));
}

export function Sidebar() {
  const [theme, setTheme] = useState<ThemeName>(() => {
    const t = loadTheme();
    applyTheme(t, false);
    return t;
  });
  const [themePicker, setThemePicker] = useState(false);
  const [petVisible, setPetVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [allSessionsOpen, setAllSessionsOpen] = useState(true); // 未分类对话区默认展开
  // 工作区（顶层）：可折叠；其下分「按项目 / 按进行中对话」两种视图（对话池）
  const [wsOpen, setWsOpen] = useState(true);
  const [wsView, setWsView] = useState<"projects" | "dialogues">(() => {
    try {
      const v = localStorage.getItem("aiwb:ws-view");
      if (v === "projects" || v === "dialogues") return v;
    } catch {
      /* ignore */
    }
    return "projects";
  });
  const setWsViewPersist = useCallback((v: "projects" | "dialogues") => {
    setWsView(v);
    try {
      localStorage.setItem("aiwb:ws-view", v);
    } catch {
      /* ignore */
    }
  }, []);

  // 工作区 = 当前项目集（自动保存为 aiwb:workspace 文档；显示即已保存，无需手动列表）

  // 树状会话数据
  const [projects, setProjects] = useState<ProjectNode[]>([]);
  const [orphaned, setOrphaned] = useState<PiSessionItem[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; session: PiSessionItem } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const w = parseInt(localStorage.getItem("aiwb:sidebar-w") ?? "", 10);
      if (Number.isFinite(w) && w >= 180 && w <= 420) return w;
    } catch {
      /* ignore */
    }
    return 236;
  });

  // 侧栏拖拽改宽
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 236;
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(420, Math.max(180, startW + (ev.clientX - startX)));
      setSidebarWidth(w);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const w = Math.min(420, Math.max(180, startW + (ev.clientX - startX)));
      try {
        localStorage.setItem("aiwb:sidebar-w", String(w));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);
  const [pinned, setPinned] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("aiwb:pinned") ?? "[]") as string[];
      return new Set(raw);
    } catch {
      return new Set();
    }
  });

  const savePinned = useCallback((next: Set<string>) => {
    setPinned(next);
    try {
      localStorage.setItem("aiwb:pinned", JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  }, []);
  // 项目置顶（本地持久化排序）
  const [projPinned, setProjPinned] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("aiwb:proj-pinned") ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const saveProjPinned = useCallback((next: Set<string>) => {
    setProjPinned(next);
    try {
      localStorage.setItem("aiwb:proj-pinned", JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  }, []);
  // 项目显示别名（重命名用，本地持久化）
  const [projAliases, setProjAliases] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("aiwb:proj-aliases") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const saveProjAliases = useCallback((next: Record<string, string>) => {
    setProjAliases(next);
    try {
      localStorage.setItem("aiwb:proj-aliases", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);
  const projName = useCallback((cwd: string) => projAliases[cwd] || projectShortName(cwd), [projAliases]);
  const toggleProjPin = useCallback(
    (cwd: string) => {
      const next = new Set(projPinned);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      saveProjPinned(next);
    },
    [projPinned, saveProjPinned],
  );
  const renameProj = useCallback(
    (cwd: string) => {
      const cur = projAliases[cwd] || projectShortName(cwd);
      const name = window.prompt("设置项目显示名称（空 = 恢复原名）：", cur);
      if (name === null) return;
      const next = { ...projAliases, [cwd]: name.trim() };
      if (!name.trim()) delete next[cwd];
      saveProjAliases(next);
    },
    [projAliases, saveProjAliases],
  );
  // 项目右键菜单
  const [projCtx, setProjCtx] = useState<{ x: number; y: number; cwd: string } | null>(null);
  const openProjCtx = useCallback((e: React.MouseEvent, cwd: string) => {
    e.preventDefault();
    setProjCtx({ x: e.clientX, y: e.clientY, cwd });
  }, []);

  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [commands, setCommands] = useState<{ skills: SkillItem[]; extensions: { name?: string; path?: string }[] } | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [invoking, setInvoking] = useState<string | null>(null);
  // 技能调用对话框（描述驱动 + 快捷模板，替代 window.prompt）
  const [skillDialog, setSkillDialog] = useState<{ name: string; description: string } | null>(null);

  // 素材库 / 提示词库（localStorage 持久化）
  const [materials, setMaterials] = useState<{ id: string; text: string; at: number }[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("aiwb:materials") ?? "[]") as { id: string; text: string; at: number }[];
    } catch {
      return [];
    }
  });
  const [materialOpen, setMaterialOpen] = useState(false);
  const [materialDraft, setMaterialDraft] = useState("");
  const saveMaterials = useCallback((next: { id: string; text: string; at: number }[]) => {
    setMaterials(next);
    try {
      localStorage.setItem("aiwb:materials", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);
  const addMaterial = () => {
    const t = materialDraft.trim();
    if (!t) return;
    saveMaterials([{ id: `m-${Date.now()}`, text: t, at: Date.now() }, ...materials]);
    setMaterialDraft("");
  };
  const removeMaterial = (id: string) => saveMaterials(materials.filter((m) => m.id !== id));
  const insertMaterial = (text: string) => {
    window.dispatchEvent(new CustomEvent("pi:insert-text", { detail: text + "\n" }));
  };

  const currentCwd = usePiUiStore((s) => s.currentCwd);
  const dialogues = usePiUiStore((s) => s.dialogues);
  const activateDialogue = usePiUiStore((s) => s.activateDialogue);
  const closeDialogue = usePiUiStore((s) => s.closeDialogue);
  // 全局搜索（会话内容）
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    { path: string; project: string; snippet: string }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const runSearch = useCallback((q: string) => {
    window.clearTimeout(searchTimerRef.current);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await piSend({ type: "search_sessions", query: q.trim(), limit: 30 });
        if (res?.success) setSearchResults(res.data?.results ?? []);
      } catch {
        /* ignore */
      } finally {
        setSearching(false);
      }
    }, 400);
  }, []);

  // 工作区自动保存：项目集 + 当前项目 + 主题/缩放 快照（显示即已保存）
  useEffect(() => {
    try {
      localStorage.setItem(
        "aiwb:workspace",
        JSON.stringify({
          projects: projects.map((p) => p.cwd),
          lastCwd: currentCwd ?? null,
          theme: loadTheme(),
          zoom: loadZoom(),
          at: Date.now(),
        }),
      );
    } catch {
      /* ignore */
    }
  }, [projects, currentCwd]);
  const switchProject = usePiUiStore((s) => s.switchProject);
  // 切项目时持久化，供重启恢复
  useEffect(() => {
    if (currentCwd) {
      try {
        localStorage.setItem("aiwb:last-cwd", currentCwd);
      } catch {
        /* ignore */
      }
    }
  }, [currentCwd]);
  const loadAll = usePiUiStore((s) => s.loadAll);

  // 拉取全部会话（按项目分组）+ 状态
  const refresh = useCallback(async () => {
    try {
      const [treeRes, stateRes] = await Promise.all([
        piSend({ type: "list_all_sessions" }),
        piSend({ type: "get_state" }),
      ]);
      if (treeRes?.success && treeRes.data) {
        setProjects(treeRes.data.projects ?? []);
        setOrphaned(treeRes.data.orphaned ?? []);
      }
      if (stateRes?.success && stateRes.data?.sessionFile) {
        setActiveFile(stateRes.data.sessionFile);
      }
    } catch {
      /* 桥未就绪 */
    }
  }, []);

  const refreshCommands = useCallback(async () => {
    try {
      const res = await piSend({ type: "get_commands" });
      if (res?.success && res.data) setCommands({ skills: res.data.skills ?? [], extensions: res.data.extensions ?? [] });
    } catch {
      /* 桥未就绪 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshCommands();
    void loadAll();
    const onFocus = () => {
      void refresh();
      void refreshCommands();
    };
    const onChanged = () => void refresh();
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+, 打开设置；Ctrl+K 预留命令面板
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    // 重启恢复上次项目 + 会话（loadAll 有重试，延时几秒后再试稳妥）
    // 新建窗口（?fresh=1）走干净启动：不恢复上次项目/会话
    const isFresh = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("fresh");
    const restore = () => {
      if (isFresh) return;
      try {
        const lastCwd = localStorage.getItem("aiwb:last-cwd");
        const lastSession = localStorage.getItem("aiwb:last-session");
        if (lastCwd && lastCwd !== (window as unknown as { __lastCwd?: string | null }).__lastCwd) {
          void switchProject(lastCwd).then((ok) => {
            if (ok && lastSession) {
              void piSend({ type: "switch_session", sessionPath: lastSession }).then((r) => {
                if (r?.success) {
                  usePiUiStore.setState({ currentDialogueId: r.data?.dialogueId ?? null, currentCwd: r.data?.cwd ?? null });
                  void refresh();
                  notifySessionChanged();
                }
              });
            }
          });
        } else if (lastSession) {
          void piSend({ type: "switch_session", sessionPath: lastSession }).then((r) => {
            if (r?.success) {
              usePiUiStore.setState({ currentDialogueId: r.data?.dialogueId ?? null, currentCwd: r.data?.cwd ?? null });
              void refresh();
              notifySessionChanged();
            }
          });
        }
      } catch {
        /* ignore */
      }
    };
    // 注册 currentCwd 引用（供恢复比较，避免闭包过期）
    (window as unknown as { __lastCwd?: string | null }).__lastCwd = currentCwd;
    const t = window.setTimeout(restore, 800);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pi:session-changed", onChanged);
    window.addEventListener("pi:project-changed", onChanged);
    window.addEventListener("pi:open-settings", () => setSettingsOpen(true));
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pi:session-changed", onChanged);
      window.removeEventListener("pi:project-changed", onChanged);
      window.removeEventListener("pi:open-settings", () => setSettingsOpen(true));
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, refreshCommands, loadAll]);

  // 「进行中」列表：事件驱动刷新（状态类事件节流 400ms；高频 delta 事件忽略）
  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const refreshDlg = () => {
      void usePiUiStore.getState().refreshDialogues();
    };
    void bindPiEvents((ev) => {
      if (disposed) return;
      const t = ev?.type;
      if (!t) return;
      if (
        [
          "agent_start",
          "agent_end",
          "agent_settled",
          "turn_start",
          "turn_end",
          "thinking_start",
          "thinking_end",
          "message_start",
          "message_end",
          "tool_execution_start",
          "tool_execution_end",
          "session_start",
          "abort",
        ].includes(t)
      ) {
        if (timer) return;
        timer = window.setTimeout(() => {
          timer = 0;
          refreshDlg();
        }, 400);
      }
    });
    refreshDlg();
    const iv = window.setInterval(refreshDlg, 15000); // 兜底轮询（最后活动时间刷新）
    // 全局快捷键：Ctrl+N 新建会话 / Ctrl+F 聚焦搜索
    const onNewSession = () => newSessionRef.current?.();
    const onFocusSearch = () => {
      setSearchOpen(true);
      searchInputRef.current?.focus();
    };
    window.addEventListener("pi:new-session", onNewSession);
    window.addEventListener("pi:focus-search", onFocusSearch);
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      window.clearInterval(iv);
      window.removeEventListener("pi:new-session", onNewSession);
      window.removeEventListener("pi:focus-search", onFocusSearch);
    };
  }, []);

  const newSession = useCallback(() => {
    void piSend({ type: "new_session" }).then((res) => {
      if (res?.success) {
        void refresh();
        notifySessionChanged();
      }
    });
  }, [refresh]);
  // 供全局快捷键（Ctrl+N）稳定引用
  const newSessionRef = useRef(newSession);
  newSessionRef.current = newSession;

  const addProject = useCallback(
    async (p: string) => {
      const res = await piSend({ type: "switch_project", cwd: p, sessionMode: "recent" });
      if (res?.success) {
        void loadAll();
        void refresh();
        notifySessionChanged();
        return true;
      }
      return false;
    },
    [loadAll, refresh],
  );

  // 拖放文件夹到侧栏 → 快速添加为项目（Tauri 环境生效，纯浏览器忽略）
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "over") {
            setDragging(true);
          } else if (p.type === "leave") {
            setDragging(false);
          } else if (p.type === "drop") {
            setDragging(false);
            const paths = (p.paths ?? []) as string[];
            const dir = paths[0];
            if (dir) void addProject(dir);
          }
        });
      } catch {
        /* 非 Tauri 环境（web 预览）忽略：拖放不可用 */
      }
    };
    void setup();
    return () => {
      unlisten?.();
    };
  }, [addProject]);

  const switchSession = useCallback(
    (path: string) => {
      try {
        localStorage.setItem("aiwb:last-session", path);
      } catch {
        /* ignore */
      }
      // 切换前中止当前流式，避免错发到旧会话（后端串行队列兜底顺序）
      void piSend({ type: "abort" })
        .catch(() => {})
        .then(() => piSend({ type: "switch_session", sessionPath: path }))
        .then((res) => {
          if (res?.success) {
            // 对话池：记录新激活的对话 id（事件过滤/指令路由用）
            usePiUiStore.setState({ currentDialogueId: res.data?.dialogueId ?? null, currentCwd: res.data?.cwd ?? null });
            void refresh();
            notifySessionChanged();
          }
        });
    },
    [refresh],
  );

  const toggleProject = useCallback((cwd: string) => {
    setExpanded((prev) => ({ ...prev, [cwd]: !prev[cwd] }));
  }, []);

  // 会话右键菜单
  const openCtxMenu = useCallback((e: React.MouseEvent, s: PiSessionItem) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, session: s });
  }, []);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const togglePin = useCallback(
    (path: string) => {
      const next = new Set(pinned);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      savePinned(next);
    },
    [pinned, savePinned],
  );

  // 默认展开当前项目
  useEffect(() => {
    if (currentCwd && projects.length > 0) {
      setExpanded((prev) => {
        if (prev[currentCwd] === undefined) {
          return { ...prev, [currentCwd]: true };
        }
        return prev;
      });
    }
  }, [currentCwd, projects.length]);

  const renameSession = useCallback(
    (path: string) => {
      const name = window.prompt("设置会话名称（空 = 清除）：");
      if (name === null) return;
      void piSend({ type: "switch_session", sessionPath: path }).then((res) => {
        if (!res?.success) return;
        void piSend({ type: "set_session_name", name }).then((res2) => {
          if (res2?.success) {
            void refresh();
            notifySessionChanged();
          } else {
            console.error("[session] 重命名失败:", res2?.error);
          }
        });
      });
    },
    [refresh],
  );

  const deleteSession = useCallback(
    (path: string, title: string) => {
      const ok = window.confirm(`确定删除会话「${title}」？\n\n文件：${path}\n\n此操作不可恢复。`);
      if (!ok) return;
      void piSend({ type: "delete_session", sessionPath: path }).then((res) => {
        if (res?.success) void refresh();
        else console.error("[session] 删除失败:", res?.error);
      });
    },
    [refresh],
  );

  // 删除项目（删该项目全部会话 + 清理本地别名/置顶残留）
  const deleteProject = useCallback(
    (cwd: string) => {
      const name = projName(cwd);
      const ok = window.confirm(
        `确定删除项目「${name}」？\n\n路径：${cwd}\n\n将删除该项目下的全部会话，此操作不可恢复。`,
      );
      if (!ok) return;
      void piSend({ type: "delete_project", cwd }).then(async (res) => {
        if (!res?.success) {
          console.error("[project] 删除失败:", res?.error);
          return;
        }
        // 若删除的是当前项目，切到列表剩余第一个；无剩余则清空
        if (currentCwd === cwd) {
          const others = projects.filter((p) => p.cwd !== cwd);
          if (others.length > 0) {
            await usePiUiStore.getState().switchProject(others[0].cwd);
          } else {
            try {
              localStorage.removeItem("aiwb:last-cwd");
            } catch {
              /* ignore */
            }
            usePiUiStore.setState({ currentCwd: null });
          }
        }
        // 清理本地存储里指向该项目的残留
        if (projAliases[cwd]) {
          const next = { ...projAliases };
          delete next[cwd];
          saveProjAliases(next);
        }
        if (projPinned.has(cwd)) {
          const next = new Set(projPinned);
          next.delete(cwd);
          saveProjPinned(next);
        }
        await refresh();
        void loadAll();
        notifySessionChanged();
      });
    },
    [projName, currentCwd, projects, projAliases, projPinned, saveProjAliases, saveProjPinned, refresh, loadAll],
  );

  const invokeSkill = useCallback((name: string, desc?: string) => {
    // 打开 UI 对话框（替代系统 window.prompt），用户填指令后确认执行
    setSkillDialog({ name, description: desc ?? "" });
  }, []);

  // 执行技能（由 SkillDialog 回调触发）
  const runSkill = useCallback(
    (name: string, extra: string) => {
      setSkillDialog(null);
      const message = `/skill:${name}${extra.trim() ? ` ${extra.trim()}` : ""}`;
      setInvoking(name);
      void piSend({ type: "prompt", message, streamingBehavior: "steer" }).then((res) => {
        setInvoking(null);
        if (!res?.success) console.error("[skill] 调用失败:", res?.error);
      });
    },
    [],
  );

  const skills = commands?.skills ?? [];
  const extensions = commands?.extensions ?? [];
  // 项目排序：置顶优先（内存中重排，不影响持久数据）
  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => Number(projPinned.has(b.cwd)) - Number(projPinned.has(a.cwd))),
    [projects, projPinned],
  );

  const renderSession = (s: PiSessionItem) => (
    <SessionItem
      key={s.id}
      s={s}
      active={activeFile === s.path}
      pinned={pinned.has(s.path)}
      onSwitch={switchSession}
      onCtx={openCtxMenu}
    />
  );

  return (
    <aside className="sidebar" style={{ width: sidebarWidth }}>
      <div className="sidebar__resize" onMouseDown={startResize} title="拖拽调整宽度" />
      <button className="btn btn--block btn--new" onClick={newSession}>
        ＋ 新建 PI 会话
      </button>

      {/* 全局搜索：会话内容检索，结果点击打开对应会话 */}
      <div className="sidebar__search">
        <div className="sidebar__search-row">
          <input
            ref={searchInputRef}
            className="sidebar__search-input"
            placeholder="🔍 搜索对话内容…"
            value={searchQuery}
            onFocus={() => setSearchOpen(true)}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchOpen(true);
              runSearch(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {searchOpen && (
            <button
              className="sidebar__search-clear"
              title="关闭搜索"
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery("");
                setSearchResults([]);
              }}
            >
              ✕
            </button>
          )}
        </div>
        {searchOpen &&
          (searching ? (
            <div className="sidebar__placeholder">
              <p>搜索中…</p>
            </div>
          ) : searchQuery.trim() && searchResults.length === 0 ? (
            <div className="sidebar__placeholder">
              <p>未找到「{searchQuery.trim()}」相关对话</p>
            </div>
          ) : searchResults.length > 0 ? (
            <div className="sidebar__search-results">
              {searchResults.map((r, i) => (
                <button
                  key={`${r.path}-${i}`}
                  className="sidebar__search-item"
                  title={r.path}
                  onClick={() => {
                    void piSend({ type: "switch_session", sessionPath: r.path }).then((res) => {
                      if (res?.success) {
                        usePiUiStore.setState({
                          currentDialogueId: res.data?.dialogueId ?? null,
                          currentCwd: res.data?.cwd ?? null,
                        });
                        setSearchOpen(false);
                        setSearchQuery("");
                        setSearchResults([]);
                        notifySessionChanged();
                        void refresh();
                      }
                    });
                  }}
                >
                  <div className="sidebar__search-item-snippet">{r.snippet}</div>
                  <div className="sidebar__search-item-meta">{r.project}</div>
                </button>
              ))}
            </div>
          ) : null)}
      </div>

      <div className={`sidebar__scroll${dragging ? " sidebar__scroll--drag" : ""}`}>
      {dragging && (
        <div className="sidebar__drop-hint">松开鼠标，将此文件夹添加为项目</div>
      )}

      {/* 工作区：当前项目集（自动保存）；标题行切「按项目 / 按进行中」两种视图；＋ 添加项目目录 */}
      {/* 工作区（顶层）：点击标题折叠/展开；内容顶部切「按项目 / 按进行中」两种视图；＋ 添加项目目录 */}
      <div
        className="sidebar__toggle sidebar__toggle--row"
        role="button"
        title={wsOpen ? "折叠工作区" : "展开工作区"}
        onClick={() => setWsOpen((v) => !v)}
      >
        <span className="sidebar__toggle-arrow">{wsOpen ? "▾" : "▸"}</span>
        <span className="sidebar__toggle-label">工作区</span>
        <button
          className="sidebar__add"
          title="添加项目目录"
          onClick={(e) => {
            e.stopPropagation();
            if (wsView === "dialogues") setWsViewPersist("projects");
            setAddProjectOpen(true);
          }}
        >
          ＋
        </button>
      </div>
      {wsOpen && (
      <div className="sidebar__sub">
        {/* 视图切换：按项目 / 按进行中对话 */}
        <div className="ws-seg" onClick={(e) => e.stopPropagation()}>
          <button
            className={`ws-seg__btn${wsView === "projects" ? " ws-seg__btn--active" : ""}`}
            onClick={() => setWsViewPersist("projects")}
          >
            项目
          </button>
          <button
            className={`ws-seg__btn${wsView === "dialogues" ? " ws-seg__btn--active" : ""}`}
            onClick={() => setWsViewPersist("dialogues")}
          >
            进行中
          </button>
        </div>
      {wsView === "dialogues" ? (
        <nav className="session-list session-list--tree">
          <DialogueList
            dialogues={dialogues}
            onActivate={(id) => void activateDialogue(id)}
            onClose={(id) => void closeDialogue(id)}
          />
        </nav>
      ) : (
      <nav className="project-tree">
        {projects.length === 0 ? (
          <div className="sidebar__placeholder">
            <p>暂无项目</p>
          </div>
        ) : (
          sortedProjects.map((p) => (
            <ProjectItem
              key={p.cwd}
              p={p}
              isOpen={!!expanded[p.cwd]}
              isActive={currentCwd === p.cwd}
              pinned={pinned}
              displayName={projName(p.cwd)}
              projPinned={projPinned.has(p.cwd)}
              onToggle={toggleProject}
              onSwitchProject={switchProject}
              onNewSession={newSession}
              onSwitchSession={switchSession}
              onCtx={openCtxMenu}
              onProjCtx={openProjCtx}
              activeFile={activeFile}
            />
          ))
        )}
      </nav>
      )}
      </div>
      )}

      {/* 对话（不属于任何项目的会话）：点击标题折叠/展开 */}
      <div
        className="sidebar__toggle sidebar__toggle--row"
        role="button"
        title={allSessionsOpen ? "折叠对话列表" : "展开对话列表"}
        onClick={() => setAllSessionsOpen((v) => !v)}
      >
        <span className="sidebar__toggle-arrow">{allSessionsOpen ? "▾" : "▸"}</span>
        <span className="sidebar__toggle-label">
          对话{orphaned.length > 0 ? `（${orphaned.length}）` : ""}
        </span>
        <button
          className="sidebar__add"
          title="新建对话"
          onClick={(e) => {
            e.stopPropagation();
            newSession();
          }}
        >
          ＋
        </button>
      </div>
      {allSessionsOpen && (
        <nav className="session-list session-list--tree">
          {orphaned.length === 0 ? (
            <div className="sidebar__placeholder">
              <p>暂无未分类对话</p>
            </div>
          ) : (
            [...orphaned]
              .sort((a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path)))
              .map(renderSession)
          )}
        </nav>
      )}

      {/* 上下文文件：查看/编辑 AGENTS.md / CLAUDE.md（注入模型上下文） */}
      <button className="sidebar__toggle" onClick={() => setCtxOpen(true)}>
        <span className="sidebar__toggle-arrow">▸</span>
        <span className="sidebar__toggle-label">🧾 上下文文件</span>
      </button>

      {/* 技能库：点击标题折叠/展开 */}
      <button className="sidebar__toggle" onClick={() => setSkillOpen((v) => !v)}>
        <span className="sidebar__toggle-arrow">{skillOpen ? "▾" : "▸"}</span>
        <span className="sidebar__toggle-label">
          技能库{skills.length > 0 ? `（${skills.length}）` : ""}
        </span>
      </button>
      {skillOpen && (
        <div className="skill-list">
          {skills.length === 0 ? (
            <div className="sidebar__placeholder">
              <p>暂无技能</p>
            </div>
          ) : (
            skills.map((s) => (
              <div
                key={s.name}
                className="skill-item"
                title={s.description ?? s.filePath ?? ""}
                onClick={() => invokeSkill(s.name, s.description)}
              >
                <div className="skill-item__name">
                  {invoking === s.name ? "⏳ " : "⚡ "}
                  {s.name}
                </div>
                <div className="skill-item__desc">
                  {(s.description ?? "").slice(0, 60)}
                  {(s.description ?? "").length > 60 ? "…" : ""}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 插件库：点击标题折叠/展开 */}
      <button className="sidebar__toggle" onClick={() => setPluginOpen((v) => !v)}>
        <span className="sidebar__toggle-arrow">{pluginOpen ? "▾" : "▸"}</span>
        <span className="sidebar__toggle-label">
          插件库{extensions.length > 0 ? `（${extensions.length}）` : ""}
        </span>
      </button>
      {pluginOpen && (
        <div className="plugin-list">
          {extensions.length === 0 ? (
            <div className="sidebar__placeholder">
              <p>暂无插件（扩展）</p>
            </div>
          ) : (
            extensions.map((e, i) => (
              <div key={i} className="plugin-item" title={e.path ?? ""}>
                <div className="plugin-item__name">{e.name || e.path?.split(/[\\/]/).pop() || "插件"}</div>
                {e.path && <div className="plugin-item__path">{e.path}</div>}
              </div>
            ))
          )}
        </div>
      )}

      {/* 素材库 / 提示词库：点击标题折叠/展开 */}
      <button className="sidebar__toggle" onClick={() => setMaterialOpen((v) => !v)}>
        <span className="sidebar__toggle-arrow">{materialOpen ? "▾" : "▸"}</span>
        <span className="sidebar__toggle-label">
          素材库{materials.length > 0 ? `（${materials.length}）` : ""}
        </span>
      </button>
      {materialOpen && (
        <div className="material-list">
          <div className="material-add">
            <textarea
              className="material-add__input"
              placeholder="收藏一段提示词 / 常用文案…"
              value={materialDraft}
              onChange={(e) => setMaterialDraft(e.target.value)}
              rows={2}
            />
            <button className="chip chip--sm" onClick={addMaterial} disabled={!materialDraft.trim()}>
              ＋ 收藏
            </button>
          </div>
          {materials.length === 0 ? (
            <div className="sidebar__placeholder">
              <p>暂无素材，收藏常用提示词后点击即可插入输入框</p>
            </div>
          ) : (
            materials.map((m) => (
              <div key={m.id} className="material-item">
                <div className="material-item__text" title={m.text} onClick={() => insertMaterial(m.text)}>
                  {m.text.slice(0, 40)}{m.text.length > 40 ? "…" : ""}
                </div>
                <button className="material-item__del" title="删除" onClick={() => removeMaterial(m.id)}>
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}

      </div>

      <div className="sidebar__footer">
        <div className="sidebar__footer-btns">
          <button
            className="chip chip--sm"
            onClick={() => setSettingsOpen(true)}
            title="设置（模型提供商 / 通用 / 插件 / 关于）"
          >
            设置
          </button>
          <button
            className="chip chip--sm"
            onClick={() => setThemePicker((v) => !v)}
            title="切换主题（浅色/深色/暖阳/薄荷/午夜紫/森林/海洋）"
          >
            {THEMES.find((t) => t.id === theme)?.label ?? "主题"}
          </button>
          <button
            className="chip chip--sm"
            onClick={() => {
              void petToggleRequest(!petVisible).then((ok) => setPetVisible(ok));
            }}
            title="呼出 / 收起桌面宠物"
          >
            {petVisible ? "收起" : "桌宠"}
          </button>
        </div>
        {themePicker && (
          <>
            <div className="theme-pop-backdrop" onClick={() => setThemePicker(false)} />
            <div className="theme-pop">
              <div className="theme-pop__head">选择主题</div>
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`theme-picker__item${t.id === theme ? " theme-picker__item--active" : ""}`}
                  onClick={() => {
                    setTheme(t.id);
                    applyTheme(t.id);
                    setThemePicker(false);
                  }}
                >
                  <span className="theme-picker__swatch" data-theme-preview={t.id} />
                  <span className="theme-picker__label">{t.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {ctxOpen && <ContextDialog onClose={() => setCtxOpen(false)} />}
      {addProjectOpen && <AddProjectDialog onConfirm={addProject} onCancel={() => setAddProjectOpen(false)} />}
      {skillDialog && (
        <SkillDialog
          name={skillDialog.name}
          description={skillDialog.description}
          onConfirm={(extra) => runSkill(skillDialog.name, extra)}
          onCancel={() => setSkillDialog(null)}
        />
      )}

      {ctxMenu && (
        <SessionContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          pinned={pinned.has(ctxMenu.session.path)}
          onClose={closeCtxMenu}
          onSwitch={() => {
            switchSession(ctxMenu.session.path);
            closeCtxMenu();
          }}
          onTogglePin={() => {
            togglePin(ctxMenu.session.path);
            closeCtxMenu();
          }}
          onRename={() => {
            renameSession(ctxMenu.session.path);
            closeCtxMenu();
          }}
          onDelete={() => {
            deleteSession(ctxMenu.session.path, ctxMenu.session.firstMessage || ctxMenu.session.id);
            closeCtxMenu();
          }}
          onCopyPath={() => {
            void navigator.clipboard.writeText(ctxMenu.session.path).catch(() => {});
            closeCtxMenu();
          }}
        />
      )}

      {projCtx && (
        <ProjectContextMenu
          x={projCtx.x}
          y={projCtx.y}
          pinned={projPinned.has(projCtx.cwd)}
          onClose={() => setProjCtx(null)}
          onOpen={() => {
            const cwd = projCtx.cwd;
            setProjCtx(null);
            if (currentCwd !== cwd) void switchProject(cwd);
          }}
          onTogglePin={() => {
            toggleProjPin(projCtx.cwd);
            setProjCtx(null);
          }}
          onNewSession={() => {
            const cwd = projCtx.cwd;
            setProjCtx(null);
            if (currentCwd === cwd) newSession();
            else void switchProject(cwd).then((ok) => {
              if (ok) newSession();
            });
          }}
          onRename={() => {
            renameProj(projCtx.cwd);
            setProjCtx(null);
          }}
          onCopyPath={() => {
            void navigator.clipboard.writeText(projCtx.cwd).catch(() => {});
            setProjCtx(null);
          }}
          onDelete={() => {
            const cwd = projCtx.cwd;
            setProjCtx(null);
            deleteProject(cwd);
          }}
        />
      )}
    </aside>
  );
}

/** 进行中列表（对话池进行中的对话）：状态点 + 项目名 + 最后活动 + 当前标记 */
function DialogueList(props: {
  dialogues: DialogueItem[];
  onActivate: (dialogueId: string) => void;
  onClose: (dialogueId: string) => void;
}) {
  const { dialogues, onActivate, onClose } = props;
  if (dialogues.length === 0) {
    return (
      <div className="sidebar__placeholder">
        <p>暂无进行中的对话</p>
        <p className="sidebar__placeholder--sub">切换项目/会话后这里会列出可随时切回的活动对话</p>
      </div>
    );
  }
  const statusText: Record<string, string> = {
    flowing: "生成中",
    thinking: "思考中",
    idle: "空闲",
  };
  const relTime = (t: number) => {
    const diff = Date.now() - t;
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
  };
  return (
    <div className="dlg-list">
      {dialogues.map((d) => {
        const st = d.status ?? "idle";
        const label = statusText[st] ?? st;
        return (
          <div
            key={d.dialogueId}
            className={`dlg-item${d.isCurrent ? " dlg-item--active" : ""}`}
            title={d.cwd}
            onClick={() => onActivate(d.dialogueId)}
          >
            <span className={`dlg-item__dot dlg-item__dot--${st}`} />
            <div className="dlg-item__main">
              <div className="dlg-item__name">
                {d.name || projectShortName(d.cwd)}
                {d.isCurrent ? <span className="dlg-item__cur">当前</span> : null}
              </div>
              <div className="dlg-item__meta">
                {label}
                {st !== "idle" ? "…" : ""} · {relTime(d.lastActive)}
                {d.model ? ` · ${d.model}` : ""}
              </div>
            </div>
            <button
              className="dlg-item__close"
              title="关闭对话（后台释放）"
              onClick={(e) => {
                e.stopPropagation();
                onClose(d.dialogueId);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** 会话行（memo：props 稳定时跳过重渲染） */
const SessionItem = memo(function SessionItem({
  s,
  active,
  pinned,
  onSwitch,
  onCtx,
}: {
  s: PiSessionItem;
  active: boolean;
  pinned: boolean;
  onSwitch: (path: string) => void;
  onCtx: (e: React.MouseEvent, s: PiSessionItem) => void;
}) {
  return (
    <div
      className={`session-item${active ? " session-item--active" : ""}`}
      onClick={() => onSwitch(s.path)}
      onContextMenu={(e) => onCtx(e, s)}
      title={s.path}
    >
      <div className="session-item__main">
        {pinned && (
          <span className="session-item__pin">
            <PinIcon />
          </span>
        )}
        <span className="session-item__title">{s.firstMessage || "（空会话）"}</span>
        <span className="session-item__count">
          {s.messageCount != null ? `（${s.messageCount}）` : ""}
        </span>
      </div>
      <div className="session-item__ops">
        <button
          className="session-item__op session-item__more"
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation();
            onCtx(e, s);
          }}
        >
          ⋯
        </button>
      </div>
    </div>
  );
});

/** 项目节点（memo；hover 状态在内部管理，避免鼠标移动触发整个侧栏重渲染） */
const ProjectItem = memo(function ProjectItem({
  p,
  isOpen,
  isActive,
  pinned,
  displayName,
  projPinned,
  onToggle,
  onSwitchProject,
  onNewSession,
  onSwitchSession,
  onCtx,
  onProjCtx,
  activeFile,
}: {
  p: ProjectNode;
  isOpen: boolean;
  isActive: boolean;
  pinned: Set<string>;
  displayName: string;
  projPinned: boolean;
  onToggle: (cwd: string) => void;
  onSwitchProject: (cwd: string) => Promise<boolean>;
  onNewSession: () => void;
  onSwitchSession: (path: string) => void;
  onCtx: (e: React.MouseEvent, s: PiSessionItem) => void;
  onProjCtx: (e: React.MouseEvent, cwd: string) => void;
  activeFile: string | null;
}) {
  // 会话排序结果缓存（置顶优先），避免每次渲染重新 sort
  const sessions = useMemo(
    () => [...p.sessions].sort((a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path))),
    [p.sessions, pinned],
  );
  const handleNew = () => {
    if (!isActive) void onSwitchProject(p.cwd).then(() => onNewSession());
    else onNewSession();
  };
  return (
    <div className="project-node">
      <div
        className={`project-item${isActive ? " project-item--active" : ""}`}
        onClick={() => onToggle(p.cwd)}
        onContextMenu={(e) => onProjCtx(e, p.cwd)}
        title={p.cwd}
      >
        {projPinned && (
          <span className="project-item__pin">
            <PinIcon />
          </span>
        )}
        <div className="project-item__main">
          <span className="project-item__name">{displayName}</span>
          <span className="project-item__count">（{p.sessions.length}）</span>
        </div>
        {isActive && <span className="project-item__tag">当前</span>}
        <button
          className="project-item__add"
          title="在此项目新建会话"
          onClick={(e) => {
            e.stopPropagation();
            handleNew();
          }}
        >
          ＋
        </button>
      </div>
      {isOpen && (
        <div className="project-node__sessions">
          {sessions.length === 0 ? (
            <div className="sidebar__placeholder">
              <p>暂无会话</p>
            </div>
          ) : (
            sessions.map((s) => (
              <SessionItem
                key={s.id}
                s={s}
                active={activeFile === s.path}
                pinned={pinned.has(s.path)}
                onSwitch={onSwitchSession}
                onCtx={onCtx}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
});

/** 项目右键菜单 */
function ProjectContextMenu(props: {
  x: number;
  y: number;
  pinned: boolean;
  onClose: () => void;
  onOpen: () => void;
  onTogglePin: () => void;
  onNewSession: () => void;
  onRename: () => void;
  onCopyPath: () => void;
  onDelete: () => void;
}) {
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(props.x, window.innerWidth - 180),
    top: Math.min(props.y, window.innerHeight - 280),
  };
  return (
    <>
      <div className="ctxmenu-backdrop" onClick={props.onClose} />
      <div className="ctxmenu" style={style} onClick={(e) => e.stopPropagation()}>
        <button className="ctxmenu__item" onClick={props.onOpen}><BubbleIcon /> 打开项目</button>
        <button className="ctxmenu__item" onClick={props.onTogglePin}>
          <PinIcon /> {props.pinned ? "取消置顶" : "置顶"}
        </button>
        <button className="ctxmenu__item" onClick={props.onNewSession}><PlusIcon /> 在此新建会话</button>
        <button className="ctxmenu__item" onClick={props.onRename}><PencilIcon /> 重命名</button>
        <button className="ctxmenu__item" onClick={props.onCopyPath}><LinkIcon /> 复制路径</button>
        <button className="ctxmenu__item ctxmenu__item--danger" onClick={props.onDelete}>✕ 删除项目</button>
      </div>
    </>
  );
}

/** 会话右键菜单 */
function SessionContextMenu(props: {
  x: number;
  y: number;
  pinned: boolean;
  onClose: () => void;
  onSwitch: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCopyPath: () => void;
}) {
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(props.x, window.innerWidth - 180),
    top: Math.min(props.y, window.innerHeight - 220),
  };
  return (
    <>
      <div className="ctxmenu-backdrop" onClick={props.onClose} />
      <div className="ctxmenu" style={style} onClick={(e) => e.stopPropagation()}>
        <button className="ctxmenu__item" onClick={props.onSwitch}><BubbleIcon /> 打开会话</button>
        <button className="ctxmenu__item" onClick={props.onTogglePin}>
          <PinIcon /> {props.pinned ? "取消置顶" : "置顶"}
        </button>
        <button className="ctxmenu__item" onClick={props.onRename}><PencilIcon /> 重命名</button>
        <button className="ctxmenu__item" onClick={props.onCopyPath}><LinkIcon /> 复制路径</button>
        <button className="ctxmenu__item ctxmenu__item--danger" onClick={props.onDelete}>✕ 删除会话</button>
      </div>
    </>
  );
}

/** 桌面宠物开关（Tauri 环境生效，浏览器环境静默） */
async function petToggleRequest(visible: boolean): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("pet_toggle", { visible })) as boolean;
  } catch {
    return false;
  }
}