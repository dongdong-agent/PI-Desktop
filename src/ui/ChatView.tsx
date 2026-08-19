/**
 * 聊天主视图：虚拟化消息列表 + 流式渲染 + 输入区 + Provider/系统提示词控制。
 *
 * 长对话稳定性要点：
 * - @tanstack/react-virtual 只渲染可视区，避免长会话 DOM 爆炸
 * - 滚动贴底策略：接近底部时自动跟随，主动上翻阅读时不强拉
 * - 流式增量通过事件总线进入 store，此处只消费渲染
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore } from "../core/store";
import { getHub, sendMessage, stopStream } from "../app/bootstrap";
import { MessageItem } from "./MessageItem";

const SCROLL_THRESHOLD = 140;

export function ChatView() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const session = useAppStore((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const isStreaming = useAppStore((s) => (sessionId ? !!s.streamingSessions[sessionId] : false));

  const messages = useMemo(() => session?.messages ?? [], [session]);
  const messagesVersion = messages.map((m) => m.content.length + (m.pending ? 1 : 0)).join(",");

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [input, setInput] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => messages[index].id,
  });

  // 切会话时重置滚动状态
  useEffect(() => {
    setPinned(true);
  }, [sessionId]);

  // 主题跟随：应用 data-theme 到根元素（皮肤系统入口）
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const scrollToTail = () => {
    if (!scrollRef.current || messages.length === 0) return;
    requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    });
  };

  // 内容变化：若处于贴底状态则跟随滚动
  useEffect(() => {
    if (pinned) scrollToTail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesVersion, pinned, sessionId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD);
  };

  // 输入框自适应高度
  const handleInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || !sessionId) return;
    setInput("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    setPinned(true);
    void sendMessage(sessionId, text);
  };

  const handleStop = () => {
    if (sessionId) void stopStream(sessionId);
  };

  if (!session) return null;

  const provider = getHub().providers.get(session.providerId);

  return (
    <div className="chat">
      <header className="chat__header">
        <div className="chat__title">
          <span className="chat__title-text">{session.title}</span>
          {isStreaming && <span className="chat__streaming">● 生成中</span>}
        </div>
        <div className="chat__controls">
          <button
            className={`chip${showPrompt ? " chip--active" : ""}`}
            onClick={() => setShowPrompt((v) => !v)}
            title="编辑系统提示词"
          >
            系统提示词
          </button>
          <ProviderPicker sessionId={session.id} currentProviderId={session.providerId} />
        </div>
      </header>

      {showPrompt && (
        <PromptEditor sessionId={session.id} initial={session.systemPrompt ?? ""} />
      )}

      <div className="chat__scroll" ref={scrollRef} onScroll={handleScroll}>
        {!pinned && messages.length > 0 && (
          <button className="chat__goto-tail" onClick={() => {
            setPinned(true);
            scrollToTail();
          }}>
            ↓ 回到底部
          </button>
        )}
        {messages.length === 0 ? (
          <div className="chat__empty">
            <p>开始对话吧 —— 比如：「帮我写一个待办清单应用」</p>
            <p className="chat__empty-dim">
              当前 Provider：{provider?.name ?? "未知"}（可在右上角切换）
            </p>
          </div>
        ) : (
          <div
            className="chat__list"
            style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
          >
            {rowVirtualizer.getVirtualItems().map((item) => {
              const msg = messages[item.index];
              return (
                <div
                  key={msg.id}
                  data-index={item.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <MessageItem message={msg} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="chat__inputbar">
        <textarea
          ref={inputRef}
          className="chat__textarea"
          value={input}
          placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onInput={handleInput}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        {isStreaming ? (
          <button className="btn btn--danger" onClick={handleStop} title="停止生成">
            ■ 停止
          </button>
        ) : (
          <button className="btn btn--primary" onClick={handleSend} disabled={!input.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 系统提示词编辑器
// ---------------------------------------------------------------------------

function PromptEditor({
  sessionId,
  initial,
}: {
  sessionId: string;
  initial: string;
}) {
  const [value, setValue] = useState(initial);
  const setSystemPrompt = useAppStore((s) => s.setSystemPrompt);

  return (
    <div className="prompt-editor">
      <textarea
        className="prompt-editor__textarea"
        value={value}
        placeholder="在此输入系统提示词（system prompt），例如：你是一个严谨的架构师……"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => setSystemPrompt(sessionId, value)}
      />
      <div className="prompt-editor__hint">修改后点击输入框外即保存</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider 选择与配置
// ---------------------------------------------------------------------------

function ProviderPicker({
  sessionId,
  currentProviderId,
}: {
  sessionId: string;
  currentProviderId: string;
}) {
  const [open, setOpen] = useState(false);
  const providers = getHub().providers.list();
  const setProvider = useAppStore((s) => s.setProvider);
  const providerConfigs = useAppStore((s) => s.providerConfigs);
  const saveProviderConfig = useAppStore((s) => s.saveProviderConfig);

  const current = providers.find((p) => p.id === currentProviderId);

  return (
    <div className="picker">
      <button className="chip" onClick={() => setOpen((v) => !v)} title="选择模型后端">
        {current?.name ?? "选择 Provider"} ▾
      </button>
      {open && (
        <div className="picker__menu" onClick={(e) => e.stopPropagation()}>
          {providers.map((p) => (
            <div
              key={p.id}
              className={`picker__item${p.id === currentProviderId ? " picker__item--active" : ""}`}
              onClick={() => {
                setProvider(sessionId, p.id);
                // 可配置 Provider 保留菜单展开，便于直接填写参数
                if (!p.configurable) setOpen(false);
              }}
            >
              <span>{p.name}</span>
              <span className="picker__kind">{p.kind === "local" ? "本地" : "远程"}</span>
            </div>
          ))}

          {/* 可配置 Provider 的参数表单 */}
          {current?.configurable && (
            <ProviderConfigForm
              key={current.id}
              providerId={current.id}
              defaults={current.defaultConfig ?? {}}
              saved={providerConfigs[current.id]?.config ?? {}}
              onSave={(config) => {
                saveProviderConfig(current.id, config);
                setOpen(false);
              }}
            />
          )}
        </div>
      )}
      {open && (
        <div
          className="picker__backdrop"
          onClick={() => {
            setOpen(false);
            setProvider(sessionId, currentProviderId);
          }}
        />
      )}
    </div>
  );
}

function ProviderConfigForm({
  providerId,
  defaults,
  saved,
  onSave,
}: {
  providerId: string;
  defaults: Record<string, string>;
  saved: Record<string, string>;
  onSave: (config: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const merged: Record<string, string> = {};
    for (const key of Object.keys(defaults)) {
      merged[key] = saved[key] ?? defaults[key] ?? "";
    }
    return merged;
  });

  const labelOf = (key: string): string => {
    switch (key) {
      case "baseUrl":
        return "BaseURL";
      case "apiKey":
        return "API Key";
      case "model":
        return "模型名";
      default:
        return key;
    }
  };

  return (
    <div className="picker__config">
      {Object.keys(defaults).map((key) => (
        <label key={key} className="picker__field">
          <span>{labelOf(key)}</span>
          <input
            type={key === "apiKey" ? "password" : "text"}
            placeholder={defaults[key]}
            value={values[key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
          />
        </label>
      ))}
      <button
        className="btn btn--primary btn--block"
        onClick={() => onSave({ ...values })}
      >
        保存配置（{providerId}）
      </button>
    </div>
  );
}