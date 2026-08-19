/**
 * 添加项目对话框（UI 风格模态）。
 * 支持：手动输入路径 + 「浏览…」打开系统文件夹选择器。
 * 确认后 switch_project 到新项目，会话列表切到该项目。
 */
import { useState } from "react";

interface Props {
  onConfirm: (path: string) => Promise<boolean>;
  onCancel: () => void;
}

export function AddProjectDialog({ onConfirm, onCancel }: Props) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState(false);

  const browse = async () => {
    setBrowsing(true);
    setError("");
    try {
      // Tauri 原生目录选择器（浏览器环境降级为手动输入）
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "选择项目文件夹" });
      if (typeof dir === "string" && dir) {
        setPath(dir);
      }
    } catch {
      setError("当前环境无法打开文件夹选择器，请手动输入路径。");
    } finally {
      setBrowsing(false);
    }
  };

  const confirm = async () => {
    const p = path.trim();
    if (!p) {
      setError("请输入项目目录路径");
      return;
    }
    setBusy(true);
    setError("");
    const ok = await onConfirm(p);
    setBusy(false);
    if (!ok) setError("添加项目失败，请确认路径存在且可访问。");
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <span className="dialog__title">＋ 添加项目</span>
          <button className="dialog__close" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="dialog__body">
          <p className="dialog__desc">
            添加一个项目目录，PI Agent 将在此目录下工作，并独立管理该项目的会话。
          </p>

          <label className="dialog__label">项目路径</label>
          <div className="dialog__pathrow">
            <input
              className="dialog__input"
              placeholder="L:/projects/你的项目"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirm();
              }}
              autoFocus
            />
            <button className="btn btn--ghost" onClick={() => void browse()} disabled={browsing}>
              {browsing ? "打开中…" : "📁 浏览…"}
            </button>
          </div>

          {error && <div className="dialog__error">⚠️ {error}</div>}
        </div>

        <div className="dialog__foot">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="btn btn--primary" onClick={() => void confirm()} disabled={busy || !path.trim()}>
            {busy ? "添加中…" : "添加并切换"}
          </button>
        </div>
      </div>
    </div>
  );
}