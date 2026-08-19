/**
 * 侧栏：品牌 + 树状结构（未分类会话 + 项目节点可展开其会话）+ 技能库 + 主题 + 设置。
 * 数据来自 list_all_sessions（按项目分组，全部真实 PI 会话）。
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { applyTheme, loadTheme, THEMES, type ThemeName } from "../app/theme";
import { piSend } from "../pi/bridge";
import { projectShortName, usePiUiStore } from "../pi/piUiStore";
import { SettingsPanel } from "./SettingsPanel";
import { AddProjectDialog } from "./AddProjectDialog";
import { SkillDialog } from "./SkillDialog";

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

function relTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
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
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [busySwitch, setBusySwitch] = useState(false);
  const [commands, setCommands] = useState<{ skills: SkillItem[] } | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);
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
      if (res?.success && res.data) setCommands({ skills: res.data.skills ?? [] });
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
    const restore = () => {
      try {
        const lastCwd = localStorage.getItem("aiwb:last-cwd");
        const lastSession = localStorage.getItem("aiwb:last-session");
        if (lastCwd && lastCwd !== (window as unknown as { __lastCwd?: string | null }).__lastCwd) {
          void switchProject(lastCwd).then((ok) => {
            if (ok && lastSession) {
              void piSend({ type: "switch_session", sessionPath: lastSession }).then((r) => {
                if (r?.success) {
                  void refresh();
                  notifySessionChanged();
                }
              });
            }
          });
        } else if (lastSession) {
          void piSend({ type: "switch_session", sessionPath: lastSession }).then((r) => {
            if (r?.success) {
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

  const newSession = useCallback(() => {
    void piSend({ type: "new_session" }).then((res) => {
      if (res?.success) {
        void refresh();
        notifySessionChanged();
      }
    });
  }, [refresh]);

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

  const switchSession = useCallback(
    (path: string) => {
      setBusySwitch(true);
      try {
        localStorage.setItem("aiwb:last-session", path);
      } catch {
        /* ignore */
      }
      void piSend({ type: "switch_session", sessionPath: path }).then((res) => {
        setBusySwitch(false);
        if (res?.success) {
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
      <div className="sidebar__brand">
        <div className="sidebar__logo">PI</div>
        <div>
          <div className="sidebar__name">PI Agent</div>
          <div className="sidebar__ver">底层 · PI 终端</div>
        </div>
      </div>

      <button className="btn btn--primary btn--block" onClick={newSession}>
        ＋ 新建 PI 会话
      </button>

      <button
        className="chip chip--sm btn--block"
        onClick={() => {
          void petToggleRequest(!petVisible).then((ok) => setPetVisible(ok));
        }}
      >
        {petVisible ? "🐱 收起桌面宠物" : "🐱 呼出桌面宠物"}
      </button>

      <div className="sidebar__scroll">
      {/* 未分类会话（不归属任何项目） */}
      {orphaned.length > 0 && (
        <>
          <div className="sidebar__label">未分类会话</div>
          <nav className="session-list">
            {[...orphaned].sort((a, b) => Number(pinned.has(b.path)) - Number(pinned.has(a.path))).map(renderSession)}
          </nav>
        </>
      )}

      {/* 项目树：项目节点 + 其会话（可折叠） */}
      <div className="sidebar__label-row">
        <span>项目</span>
        <button className="sidebar__add" title="添加项目目录" onClick={() => setAddProjectOpen(true)}>
          ＋
        </button>
      </div>
      <nav className="project-tree">
        {projects.length === 0 ? (
          <div className="sidebar__placeholder">
            <p>暂无项目</p>
          </div>
        ) : (
          projects.map((p) => (
            <ProjectItem
              key={p.cwd}
              p={p}
              isOpen={!!expanded[p.cwd]}
              isActive={currentCwd === p.cwd}
              pinned={pinned}
              onToggle={toggleProject}
              onSwitchProject={switchProject}
              onNewSession={newSession}
              onSwitchSession={switchSession}
              onCtx={openCtxMenu}
              activeFile={activeFile}
            />
          ))
        )}
      </nav>

      </div>

      {/* 技能库 */}
      <div className="sidebar__label">技能库 {skills.length > 0 && `（${skills.length}）`}</div>
      <button className="chip chip--sm btn--block" onClick={() => setSkillOpen((v) => !v)}>
        {skillOpen ? "▾ 收起技能列表" : "▸ 展开技能（点击即调用）"}
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

      {/* 素材库 / 提示词库 */}
      <div className="sidebar__label">素材库 {materials.length > 0 && `（${materials.length}）`}</div>
      <button className="chip chip--sm btn--block" onClick={() => setMaterialOpen((v) => !v)}>
        {materialOpen ? "▾ 收起素材库" : "▸ 展开素材（点击插入提示词）"}
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

      <div className="sidebar__footer">
        <div className="sidebar__footer-row">
          <span>{busySwitch ? "切换中…" : "PI 桌面端"}</span>
          <div className="sidebar__footer-btns">
            <button
              className="chip chip--sm"
              onClick={() => setSettingsOpen(true)}
              title="设置（模型提供商 / 通用 / 插件 / 关于）"
            >
              ⚙ 设置
            </button>
            <button
              className="chip chip--sm"
              onClick={() => setThemePicker((v) => !v)}
              title="切换主题（浅色/深色/暖阳/薄荷/午夜紫/森林/海洋）"
            >
              {THEMES.find((t) => t.id === theme)?.label ?? "🎨 主题"}
            </button>
          </div>
        </div>
        {themePicker && (
          <div className="theme-picker">
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
        )}
        <div className="sidebar__hint">v0.2 · PI 驱动 · Ctrl+± 缩放</div>
      </div>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
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
    </aside>
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
        <div className="session-item__title">
          {pinned && <span className="session-item__pin">📌</span>}
          {s.firstMessage || "（空会话）"}
        </div>
        <div className="session-item__meta">
          {relTime(s.modified)}
          {s.messageCount != null ? ` · ${s.messageCount} 条` : ""}
        </div>
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
  onToggle,
  onSwitchProject,
  onNewSession,
  onSwitchSession,
  onCtx,
  activeFile,
}: {
  p: ProjectNode;
  isOpen: boolean;
  isActive: boolean;
  pinned: Set<string>;
  onToggle: (cwd: string) => void;
  onSwitchProject: (cwd: string) => Promise<boolean>;
  onNewSession: () => void;
  onSwitchSession: (path: string) => void;
  onCtx: (e: React.MouseEvent, s: PiSessionItem) => void;
  activeFile: string | null;
}) {
  const [hover, setHover] = useState(false);
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
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={p.cwd}
      >
        <span className="project-item__arrow">{isOpen ? "▾" : "▸"}</span>
        <div className="project-item__main">
          <div className="project-item__name">{projectShortName(p.cwd)}</div>
          <div className="project-item__meta">
            {p.sessions.length} 会话
            {isActive ? " · 当前" : ""}
          </div>
        </div>
        {hover && (
          <button className="project-item__add" title="在此项目新建会话" onClick={(e) => {
            e.stopPropagation();
            handleNew();
          }}>
            ＋
          </button>
        )}
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
          <button className="project-node__new" onClick={handleNew}>
            ＋ 在此项目新建会话
          </button>
        </div>
      )}
    </div>
  );
});

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
        <button className="ctxmenu__item" onClick={props.onSwitch}>💬 打开会话</button>
        <button className="ctxmenu__item" onClick={props.onTogglePin}>
          {props.pinned ? "📌 取消置顶" : "📌 置顶"}
        </button>
        <button className="ctxmenu__item" onClick={props.onRename}>✎ 重命名</button>
        <button className="ctxmenu__item" onClick={props.onCopyPath}>🔗 复制路径</button>
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