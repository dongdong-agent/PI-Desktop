/**
 * 自定义标题栏（decorations:false 后替代系统标题栏）。
 * 与主界面同风格（主题 token），含应用名 + 窗口控制（最小化/最大化/关闭）+ 拖拽区。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function TitleBar() {
  const [max, setMax] = useState(false);

  useEffect(() => {
    void invoke("win_is_maximized")
      .then((v) => setMax(!!v))
      .catch(() => {});
  }, []);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar__brand" data-tauri-drag-region>
        <span className="titlebar__logo">π</span>
      </div>
      <div className="titlebar__spacer" data-tauri-drag-region />
      <div className="titlebar__controls">
        <button
          className="titlebar__btn"
          title="最小化"
          onClick={() => void invoke("win_minimize").catch(() => {})}
        >
          ─
        </button>
        <button
          className="titlebar__btn"
          title={max ? "还原" : "最大化"}
          onClick={() => {
            void invoke("win_maximize")
              .then((v) => setMax(!!v))
              .catch(() => {});
          }}
        >
          {max ? "❐" : "□"}
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          title="关闭"
          onClick={() => void invoke("win_close").catch(() => {})}
        >
          ✕
        </button>
      </div>
    </div>
  );
}