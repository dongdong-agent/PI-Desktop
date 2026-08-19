/**
 * 单条消息渲染：用户/助手气泡、Markdown 预览、代码块（带复制）、错误态 + 重试。
 */
import { useCallback, useState } from "react";
import type { ChatMessage } from "../core/types";
import { resendMessage } from "../app/bootstrap";
import { useAppStore } from "../core/store";
import { MarkdownBody } from "./MarkdownBody";

/** 用户消息：纯文本（避免把用户输入当 markdown 渲染出样式） */
function PlainText({ text }: { text: string }) {
  return (
    <div className="msg__text">
      <p>{text}</p>
    </div>
  );
}

export function MessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`msg msg--${message.role}`}>
      {!isUser && (
        <div className="msg__avatar" title="AI">
          AI
        </div>
      )}
      <div className="msg__body">
        {message.content ? (
          <div className="msg__content">
            {isUser ? <PlainText text={message.content} /> : <MarkdownBody text={message.content} />}
          </div>
        ) : message.pending ? (
          <span className="msg__caret" />
        ) : null}

        {message.pending && message.content.length > 0 && <span className="msg__caret" />}

        {message.error && (
          <div className="msg__error">
            <span>⚠️ {message.error}</span>
            <ErrorActions messageId={message.id} />
          </div>
        )}

        {!message.pending && !message.error && message.role === "assistant" && (
          <div className="msg__meta">
            {message.model ? `模型 ${message.model}` : "AI"}
            {message.usage?.completionTokens
              ? ` · ${message.usage.completionTokens} 词元`
              : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorActions({ messageId }: { messageId: string }) {
  const [busy, setBusy] = useState(false);
  const sessionId = useAppStore((s) => s.activeSessionId);

  const retry = useCallback(() => {
    if (!sessionId) return;
    setBusy(true);
    void resendMessage(sessionId, messageId).finally(() => setBusy(false));
  }, [sessionId, messageId]);

  return (
    <div className="msg__error-actions">
      <button className="chip chip--sm" onClick={retry} disabled={busy || !sessionId}>
        {busy ? "重试中…" : "↻ 重试"}
      </button>
    </div>
  );
}