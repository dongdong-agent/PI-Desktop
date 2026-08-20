/**
 * 设置面板（模态）：模型提供商管理 + 通用设置 + 关于。
 * 数据全部来自真实 PI（providers/auth.json/settings.json），持久化后终端共享。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { piSend } from "../pi/bridge";
import { usePiUiStore } from "../pi/piUiStore";

/** 候选 API Key 列表（本地存储，不入 auth.json；切换时写入 auth.json 与终端共享） */
const CANDIDATES_KEY = "aiwb:key-candidates";

function loadCandidates(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(CANDIDATES_KEY) ?? "{}") as Record<string, string[]>;
    const out: Record<string, string[]> = {};
    for (const [pid, arr] of Object.entries(raw)) {
      if (Array.isArray(arr)) out[pid] = arr.filter((k) => typeof k === "string" && k.length > 0);
    }
    return out;
  } catch {
    return {};
  }
}

function saveCandidates(c: Record<string, string[]>): void {
  try {
    localStorage.setItem(CANDIDATES_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

/** 打码显示：sk-xxxx…abcd */
function maskKey(k: string): string {
  if (k.length <= 12) return k.slice(0, 4) + "…";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

interface ProviderItem {
  id: string;
  name: string;
  authed: boolean;
}

interface PiSettings {
  defaultModel?: string | null;
  defaultProvider?: string | null;
  defaultThinkingLevel?: string | null;
  autoCompaction?: boolean;
  autoRetry?: boolean;
  hideThinking?: boolean;
}

type Tab = "providers" | "general" | "plugins" | "about";

interface ExtensionItem {
  path?: string;
  name?: string;
  description?: string;
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("providers");
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ProviderItem | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [savedMsg, setSavedMsg] = useState("");
  const [extensions, setExtensions] = useState<ExtensionItem[]>([]);
  const [reloading, setReloading] = useState(false);
  const [candidates, setCandidates] = useState<Record<string, string[]>>(loadCandidates);
  const models = usePiUiStore((s) => s.models);

  const refresh = useCallback(async () => {
    try {
      const [p, s, c] = await Promise.all([
        piSend({ type: "get_providers" }),
        piSend({ type: "get_settings" }),
        piSend({ type: "get_commands" }),
      ]);
      if (p?.success) {
        const providers = p.data?.providers ?? [];
        setProviders(providers);
        // 自动把 auth.json 中已保存的 key 同步进本地候选列表（方便一键切换）
        setCandidates((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const pr of providers) {
            if (typeof pr.key === "string" && pr.key) {
              const list = next[pr.id] ?? [];
              if (!list.includes(pr.key)) {
                next[pr.id] = [pr.key, ...list];
                changed = true;
              }
            }
          }
          if (changed) saveCandidates(next);
          return next;
        });
      }
      if (s?.success) setSettings(s.data ?? {});
      if (c?.success) setExtensions(c.data?.extensions ?? []);
    } catch {
      /* 桥未就绪 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reloadResources = async () => {
    setReloading(true);
    setSavedMsg("");
    try {
      const res = await piSend({ type: "reload_resources" });
      setSavedMsg(res?.success ? "已重载技能/扩展/提示词" : `重载失败：${res?.error ?? ""}`);
      void refresh();
    } finally {
      setReloading(false);
    }
  };

  const filtered = useMemo(
    () =>
      providers
        .filter(
          (p) => !filter || p.id.includes(filter.toLowerCase()) || p.name.toLowerCase().includes(filter.toLowerCase()),
        )
        .sort((a, b) => Number(b.authed ?? false) - Number(a.authed ?? false)),
    [providers, filter],
  );

  const updateCandidates = (next: Record<string, string[]>) => {
    setCandidates(next);
    saveCandidates(next);
  };

  const addCandidate = (key: string) => {
    const k = key.trim();
    if (!selected || !k) return;
    const list = candidates[selected.id] ?? [];
    if (list.includes(k)) {
      setSavedMsg(`该 Key 已在 ${selected.name} 候选列表中`);
      return;
    }
    updateCandidates({ ...candidates, [selected.id]: [k, ...list] });
    setSavedMsg(`已存入候选列表：${maskKey(k)}`);
  };

  const applyCandidate = async (k: string) => {
    if (!selected) return;
    setSavingKey(true);
    setSavedMsg("");
    try {
      const res = await piSend({ type: "set_api_key", providerId: selected.id, apiKey: k });
      if (res?.success) {
        setProviders((prev) => prev.map((p) => (p.id === selected.id ? { ...p, authed: true } : p)));
        setSavedMsg(`已切换 ${selected.name} 为候选 Key：${maskKey(k)}`);
      } else {
        setSavedMsg(`切换失败：${res?.error ?? ""}`);
      }
    } finally {
      setSavingKey(false);
    }
  };

  const removeCandidate = (k: string) => {
    if (!selected) return;
    const list = (candidates[selected.id] ?? []).filter((x) => x !== k);
    updateCandidates({ ...candidates, [selected.id]: list });
    setSavedMsg(`已从候选列表移除：${maskKey(k)}`);
  };

  const saveApiKey = async () => {
    if (!selected) return;
    setSavingKey(true);
    setSavedMsg("");
    try {
      const res = await piSend({ type: "set_api_key", providerId: selected.id, apiKey });
      if (res?.success) {
        setProviders((prev) => prev.map((p) => (p.id === selected.id ? { ...p, authed: !!apiKey } : p)));
        setSavedMsg(apiKey ? `已保存 ${selected.name} 的 API Key` : `已移除 ${selected.name} 的 API Key`);
      } else {
        setSavedMsg(`保存失败：${res?.error ?? ""}`);
      }
    } finally {
      setSavingKey(false);
    }
  };

  const changeSetting = async (key: string, value: unknown) => {
    const res = await piSend({ type: "set_setting", key, value });
    if (res?.success) {
      setSettings((prev) => ({ ...prev, [key]: value }));
      setSavedMsg(`已更新：${key}`);
    } else {
      setSavedMsg(`更新失败：${res?.error ?? ""}`);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <span className="settings__title">⚙ 设置</span>
          <button className="settings__close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings__main">
          <div className="settings__tabs">
            {(
              [
                ["providers", "模型提供商"],
                ["general", "通用设置"],
                ["plugins", "插件"],
                ["about", "关于"],
              ] as [Tab, string][]
            ).map(([t, label]) => (
              <button
                key={t}
                className={`settings__tab${tab === t ? " settings__tab--active" : ""}`}
                onClick={() => setTab(t)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="settings__body">
          {savedMsg && <div className="settings__saved">✓ {savedMsg}</div>}

          {tab === "providers" && (
            <div className="settings__providers">
              <div className="settings__providers-head">
                <span>
                  {providers.length} 个提供商 · {providers.filter((p) => p.authed).length} 已认证
                </span>
              </div>
              <input
                className="settings__search"
                placeholder="搜索提供商…（如 openrouter / deepseek）"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="settings__provider-list">
                {filtered.map((p) => (
                  <div
                    key={p.id}
                    className={`settings__provider${selected?.id === p.id ? " settings__provider--active" : ""}`}
                    onClick={() => {
                      setSelected(p);
                      setApiKey("");
                    }}
                  >
                    <span>{p.name}</span>
                    <span className={`settings__badge${p.authed ? " settings__badge--ok" : ""}`}>
                      {p.authed ? "已认证" : "未认证"}
                    </span>
                  </div>
                ))}
              </div>

              {selected && (
                <div className="settings__keyform">
                  <div className="settings__keyform-title">
                    配置 {selected.name}（{selected.id}）
                  </div>
                  <div className="settings__keyform-hint">
                    API Key 会写入 ~/.pi/agent/auth.json，终端与桌面端共享。留空保存 = 移除。
                  </div>
                  <input
                    type="password"
                    className="settings__keyinput"
                    placeholder="粘贴 API Key…"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <div className="settings__keybtns">
                    <button className="btn btn--primary" onClick={() => void saveApiKey()} disabled={savingKey}>
                      {savingKey ? "保存中…" : apiKey ? "保存 API Key" : "移除当前 Key"}
                    </button>
                    {apiKey.trim() && (
                      <button className="btn" onClick={() => addCandidate(apiKey)} disabled={savingKey}>
                        ＋ 存入候选列表
                      </button>
                    )}
                  </div>

                  <div className="settings__candidates">
                    <div className="settings__candidates-head">候选 Key 列表（本地保存，可一键切换）</div>
                    {(candidates[selected.id] ?? []).length === 0 ? (
                      <div className="settings__candidates-empty">
                        暂无候选 Key。粘贴新 Key 后点「＋ 存入候选列表」即可累积多个 Key 随时切换。
                      </div>
                    ) : (
                      <ul className="settings__candidates-list">
                        {(candidates[selected.id] ?? []).map((k) => (
                          <li key={k} className="settings__candidate">
                            <code className="settings__candidate-key" title={k}>
                              {maskKey(k)}
                            </code>
                            <button
                              className="chip chip--sm"
                              onClick={() => void applyCandidate(k)}
                              disabled={savingKey}
                              title="写入 auth.json 并切换为当前 Key"
                            >
                              设为当前
                            </button>
                            <button
                              className="chip chip--sm settings__candidate-del"
                              onClick={() => removeCandidate(k)}
                              title="从候选列表移除（不影响 auth.json）"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "general" && (
            <div className="settings__general">
              <div className="settings__group-label">模型</div>
              <label className="settings__row">
                <span>默认模型</span>
                <select
                  value={settings?.defaultModel ?? ""}
                  onChange={(e) => void changeSetting("defaultModel", e.target.value)}
                >
                  <option value="">（未设置）</option>
                  {models
                    .slice(0, 80)
                    .map((m) => (
                      <option key={`${m.provider}:${m.id}`} value={m.id}>
                        {m.id}（{m.provider}）
                      </option>
                    ))}
                </select>
              </label>
              <label className="settings__row">
                <span>默认思考级别</span>
                <select
                  value={settings?.defaultThinkingLevel ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    void changeSetting("defaultThinkingLevel", v);
                    // 同步运行时思考强度，输入区 ToolBar 立即跟随
                    if (v) void usePiUiStore.getState().setThinking(v);
                  }}
                >
                  <option value="">（未设置）</option>
                  {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((lv) => (
                    <option key={lv} value={lv}>
                      {lv}
                    </option>
                  ))}
                </select>
              </label>

              <div className="settings__group-label">对话行为</div>
              <label className="settings__row">
                <span>自动重试（限流/瞬时错误）</span>
                <input
                  type="checkbox"
                  checked={!!settings?.autoRetry}
                  onChange={(e) => void changeSetting("autoRetry", e.target.checked)}
                />
              </label>
              <label className="settings__row">
                <span>隐藏思考块</span>
                <input
                  type="checkbox"
                  checked={!!settings?.hideThinking}
                  onChange={(e) => void changeSetting("hideThinking", e.target.checked)}
                />
              </label>

              <div className="settings__group-label">上下文</div>
              <label className="settings__row">
                <span>自动压缩上下文</span>
                <input
                  type="checkbox"
                  checked={!!settings?.autoCompaction}
                  onChange={(e) => void changeSetting("autoCompaction", e.target.checked)}
                />
              </label>
            </div>
          )}

          {tab === "about" && (
            <div className="settings__about">
              <div className="settings__about-logo">π</div>
              <div className="settings__about-name">PI Agent</div>
              <div className="settings__about-desc">底层驱动：真实 PI 终端（@earendil-works/pi-coding-agent）</div>
              <div className="settings__about-row">
                <span>可用模型</span>
                <b>{models.length}</b>
              </div>
              <div className="settings__about-row">
                <span>提供商</span>
                <b>{providers.length}</b>
              </div>
              <div className="settings__about-row">
                <span>已认证</span>
                <b>{providers.filter((p) => p.authed).length}</b>
              </div>
            </div>
          )}

          {tab === "plugins" && (
            <div className="settings__plugins">
              <div className="settings__plugins-head">
                <span>扩展（来自真实 PI 资源加载器）</span>
                <button
                  className="btn btn--primary btn--sm"
                  onClick={() => void reloadResources()}
                  disabled={reloading}
                >
                  {reloading ? "重载中…" : "⟳ 重载资源"}
                </button>
              </div>
              {extensions.length === 0 ? (
                <div className="settings__empty">未加载到扩展</div>
              ) : (
                extensions.map((e, i) => (
                  <div key={i} className="settings__ext">
                    <div className="settings__ext-name">🧩 {e.name || e.path?.split(/[\\/]/).pop() || "扩展"}</div>
                    <div className="settings__ext-path">{e.path}</div>
                  </div>
                ))
              )}
              <div className="settings__hint">
                提示：新增/修改扩展、技能、提示词后点「重载资源」生效（等价终端 /reload）。
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}