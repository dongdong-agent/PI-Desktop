/**
 * 上下文文件编辑器：查看/编辑当前项目的 AGENTS.md / CLAUDE.md（全局・项目・祖先）。
 * 内容会注入模型上下文（对齐终端 PI 的 context files 行为）。
 */
import { useCallback, useEffect, useState } from "react";
import { piSend } from "../pi/bridge";
import { projectShortName, usePiUiStore } from "../pi/piUiStore";

interface ContextFile {
  path: string;
  filename: string;
  scope: "global" | "project" | "ancestor";
  exists: boolean;
  content: string | null;
}

const SCOPE_LABEL: Record<string, string> = {
  global: "全局",
  project: "项目",
  ancestor: "祖目录",
};

export function ContextDialog({ onClose }: { onClose: () => void }) {
  const currentCwd = usePiUiStore((s) => s.currentCwd);
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<ContextFile[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savedMsg, setSavedMsg] = useState("");
  const [savingIdx, setSavingIdx] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await piSend({
        type: "get_context_files",
        cwd: currentCwd ?? undefined,
        includeContent: true,
      });
      if (res?.success) {
        const list = (res.data?.list ?? []) as ContextFile[];
        setFiles(list);
        const next: Record<string, string> = {};
        for (const f of list) {
          if (f.content != null) next[f.path] = f.content;
        }
        setEdits(next);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [currentCwd]);

  useEffect(() => {
    void load();
  }, [load]);

  // 保存某文件（Rust write_text_file 自动建父目录）
  const save = async (f: ContextFile) => {
    setSavingIdx(f.path);
    setSavedMsg("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("write_text_file", { path: f.path, content: edits[f.path] ?? "" });
      setSavedMsg(`已保存 ${f.filename}（重启会话后生效）`);
    } catch (e) {
      setSavedMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingIdx(null);
    }
  };

  // 新建项目级 AGENTS.md
  const createProjectFile = async () => {
    if (!currentCwd) return;
    setSavedMsg("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const p = `${currentCwd.replace(/\\/g, "/")}/AGENTS.md`;
      const already = files.some((f) => f.path === p);
      if (already) {
        setSavedMsg("项目已有 AGENTS.md");
        return;
      }
      await invoke("write_text_file", { path: p, content: "" });
      setSavedMsg("已创建 AGENTS.md，可编辑后重启会话生效");
      void load();
    } catch (e) {
      setSavedMsg(`创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings context-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <span className="settings__title">🧾 上下文文件（AGENTS.md / CLAUDE.md）</span>
          <button className="settings__close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="settings__main">
          <div className="settings__body">
            {savedMsg && <div className="settings__saved">✓ {savedMsg}</div>}
            <div className="context-dialog__hint">
              项目：{projectShortName(currentCwd ?? "")}（{currentCwd ?? "—"}）
              <br />
              这些文件会作为系统上下文注入每次对话；修改后需新建/恢复会话生效。
            </div>
            {loading ? (
              <div className="sidebar__placeholder">
                <p>加载中…</p>
              </div>
            ) : (
              <>
                <div className="context-dialog__list">
                  {files.length === 0 && (
                    <div className="sidebar__placeholder">
                      <p>当前项目没有 AGENTS.md / CLAUDE.md</p>
                      <p className="sidebar__placeholder--sub">点击下方「新建 AGENTS.md」创建项目级上下文文件</p>
                    </div>
                  )}
                  {files.map((f) => (
                    <div key={f.path} className="context-dialog__file">
                      <div className="context-dialog__file-head">
                        <span className="context-dialog__file-name">{f.filename}</span>
                        <span className="context-dialog__file-scope">{SCOPE_LABEL[f.scope] ?? f.scope}</span>
                        <code className="context-dialog__file-path" title={f.path}>
                          {f.path}
                        </code>
                        <button
                          className="chip chip--sm"
                          onClick={() => void save(f)}
                          disabled={savingIdx === f.path}
                        >
                          {savingIdx === f.path ? "保存中…" : "保存"}
                        </button>
                      </div>
                      <textarea
                        className="context-dialog__editor"
                        rows={8}
                        spellCheck={false}
                        value={edits[f.path] ?? ""}
                        placeholder="# AGENTS.md 项目指令（可选）
每轮对话自动注入，如：项目结构/编码规范/常用命令…"
                        onChange={(e) => setEdits((prev) => ({ ...prev, [f.path]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
                <div className="context-dialog__footer">
                  <button className="btn btn--primary" onClick={() => void createProjectFile()}>
                    ➕ 新建项目 AGENTS.md
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}