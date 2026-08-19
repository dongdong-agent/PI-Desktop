/**
 * 右信息面板：工具调用时间线（三栏布局的右栏）。
 * 数据来自真实 PI 会话事件流（tool_execution_start/update/end）。
 */
import { memo, useState } from "react";
import type { PiToolEvent } from "../pi/eventModel";

export const ToolTimeline = memo(function ToolTimeline({ tools }: { tools: PiToolEvent[] }) {
  const [collapsed, setCollapsed] = useState(true);

  if (collapsed) {
    return (
      <aside className="info-panel info-panel--collapsed">
        <button className="info-panel__toggle" onClick={() => setCollapsed(false)} title="展开信息面板">
          ◀
        </button>
      </aside>
    );
  }

  const statusMap = {
    pending: "⏳",
    running: "▶",
    done: "✓",
    error: "✗",
  } as const;

  return (
    <aside className="info-panel">
      <div className="info-panel__head">
        <span className="info-panel__title">工具时间线</span>
        <button className="info-panel__toggle" onClick={() => setCollapsed(true)} title="折叠信息面板">
          ▶
        </button>
      </div>
      <div className="info-panel__body">
        {tools.length === 0 ? (
          <div className="info-panel__empty">暂无工具调用</div>
        ) : (
          <ol className="tool-timeline">
            {tools.map((t) => (
              <li key={t.id} className={`tool-timeline__item tool-timeline__item--${t.status}`}>
                <div className="tool-timeline__row">
                  <span className="tool-timeline__status">{statusMap[t.status]}</span>
                  <span className="tool-timeline__name">{t.toolName}</span>
                </div>
                <details className="tool-timeline__detail">
                  <summary>详情</summary>
                  <pre className="tool-timeline__args">{t.argsText}</pre>
                  {t.resultText != null && (
                    <pre className="tool-timeline__result">{t.resultText}</pre>
                  )}
                </details>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
});