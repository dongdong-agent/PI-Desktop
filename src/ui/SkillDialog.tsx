/**
 * 技能调用对话框（UI 风格模态，替代系统 window.prompt）。
 * 说明：PI 技能 = 描述 + 自由文本指令驱动（无参数 schema）。
 * 本对话框提供：完整描述 + 「想让技能做什么」指令框 + 常用意图快捷模板。
 */
import { useState } from "react";

interface Props {
  name: string;
  description: string;
  onConfirm: (extra: string) => void;
  onCancel: () => void;
}

/** 常用意图快捷模板：点击插入输入框（辅助组织指令） */
const INTENT_TEMPLATES: { label: string; text: string }[] = [
  { label: "🧠 分析", text: "请分析当前项目状态并给出结论与建议。" },
  { label: "📝 总结", text: "请总结核心要点，分条列出，并给出下一步建议。" },
  { label: "⚙ 执行", text: "请按技能说明执行，输出完成结果。" },
  { label: "🔍 审查", text: "请从第一性原理出发审查，指出问题与风险。" },
];

export function SkillDialog({ name, description, onConfirm, onCancel }: Props) {
  const [extra, setExtra] = useState("");

  const confirm = () => onConfirm(extra.trim());

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog skill-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <span className="dialog__title">⚡ 调用技能「{name}」</span>
          <button className="dialog__close" onClick={onCancel} title="关闭">
            ✕
          </button>
        </div>
        <div className="skill-dialog__desc">
          {description || "（无描述）"}
        </div>

        <label className="skill-dialog__label">想让技能做什么？（可留空直接执行）</label>
        <textarea
          className="skill-dialog__input"
          placeholder="例如：帮我总结这个项目的架构与风险…"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          rows={3}
          autoFocus
        />

        <div className="skill-dialog__templates">
          {INTENT_TEMPLATES.map((t) => (
            <button
              key={t.label}
              className="chip chip--sm"
              onClick={() => setExtra(t.text)}
              title={t.text}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="dialog__foot">
          <button className="chip chip--sm" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn--primary" onClick={confirm}>
            执行技能
          </button>
        </div>
      </div>
    </div>
  );
}