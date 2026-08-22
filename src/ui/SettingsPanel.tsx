/**
 * 设置面板（模态）：模型提供商管理 + 通用设置 + 关于。
 * 数据全部来自真实 PI（providers/auth.json/settings.json），持久化后终端共享。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bindPiEvents, piSend } from "../pi/bridge";
import { usePiUiStore } from "../pi/piUiStore";
import { useZoomLevel, zoomIn, zoomOut, zoomReset } from "../app/zoom";

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

/** 秒 → 人类可读时长 */
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

interface ProviderItem {
  id: string;
  name: string;
  authed: boolean;
  key?: string | null;
  isSubscription?: boolean; // 支持订阅登录（OAuth）
  loginLabel?: string | null;
}

/** 常用提供商（内置，便于直达申请页面） */
const COMMON_PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", applyUrl: "https://platform.deepseek.com/api_keys", desc: "deepseek-chat / deepseek-reasoner" },
  { id: "volc", name: "火山方舟 · 豆包", applyUrl: "https://console.volcengine.com/ark", desc: "doubao 系列" },
  { id: "openai", name: "OpenAI", applyUrl: "https://platform.openai.com/api-keys", desc: "gpt-4o / gpt-4.1 等" },
  { id: "moonshot", name: "Kimi · Moonshot", applyUrl: "https://platform.moonshot.cn/console/api-keys", desc: "moonshot-v1-*" },
  { id: "zhipu", name: "智谱 · BigModel", applyUrl: "https://open.bigmodel.cn/usercenter/apikeys", desc: "glm-4-*" },
  { id: "qwen", name: "通义千问 · DashScope", applyUrl: "https://bailian.console.aliyun.com", desc: "qwen-*" },
  { id: "gemini", name: "Google Gemini", applyUrl: "https://aistudio.google.com/apikey", desc: "gemini-*" },
  { id: "anthropic", name: "Anthropic Claude", applyUrl: "https://console.anthropic.com/keys", desc: "claude-*" },
];

/** 打开外部链接（Tauri 环境用 opener，网页预览降级 window.open） */
async function openExtUrl(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
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
  const zoomLevel = useZoomLevel();
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ProviderItem | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [coreVersion, setCoreVersion] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState("");
  const [extensions, setExtensions] = useState<ExtensionItem[]>([]);
  const [reloading, setReloading] = useState(false);
  const [candidates, setCandidates] = useState<Record<string, string[]>>(loadCandidates);
  // 订阅登录（OAuth）流程状态：发起后监听 auth_event / auth_prompt 事件驱动 UI
  const [loginFlow, setLoginFlow] = useState<{
    providerId: string;
    phase: "starting" | "url" | "prompt" | "done" | "err";
    message?: string;
    url?: string;
    prompt?: {
      type?: string;
      message?: string;
      placeholder?: string;
    };
    promptId?: string;
  } | null>(null);
  const [loginInput, setLoginInput] = useState("");
  const loginInputRef = useRef<HTMLInputElement>(null);
  // 自定义 provider（~/.pi/agent/models.json）表单
  const [customProviders, setCustomProviders] = useState<
    { id: string; name: string; baseUrl: string; api: string; models: string[] }[]
  >([]);
  const [customOpen, setCustomOpen] = useState(false);
  const [cpForm, setCpForm] = useState({
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    models: "",
    apiKey: "",
  });
  // GUI 诊断信息（关于页）
  const [diag, setDiag] = useState<{
    coreVersion?: string;
    piDist?: string | null;
    agentDir?: string;
    nodeVersion?: string;
    uptimeSeconds?: number;
    initialized?: boolean;
    dialogueCount?: number;
    currentDialogueId?: string | null;
    dialogues?: { id: string; cwd: string; status: string; session: string | null }[];
    files?: { auth?: boolean; settings?: boolean; models?: boolean };
  } | null>(null);
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
      // 自定义 provider（models.json）
      const cp = await piSend({ type: "list_custom_providers" }).catch(() => null);
      if (cp?.success) setCustomProviders(cp.data?.providers ?? []);
      // 诊断信息
      const dg = await piSend({ type: "diagnostics" }).catch(() => null);
      if (dg?.success) setDiag(dg.data ?? null);
      // 拉取 PI 内核版本（关于页/检查更新）
      const v = await piSend({ type: "get_core_version" }).catch(() => null);
      if (v?.success) setCoreVersion(v.data?.version ?? null);
    } catch {
      /* 桥未就绪 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 订阅登录（OAuth）事件监听：auth_event → 显示进度/打开浏览器；auth_prompt → 转输入框
  useEffect(() => {
    let disposed = false;
    void bindPiEvents((ev) => {
      if (disposed) return;
      if (ev?.type === "auth_event") {
        const e = ev.event ?? {};
        setLoginFlow((prev) => {
          if (!prev || prev.providerId !== ev.providerId) return prev;
          if (e.type === "auth_url") {
            return { ...prev, phase: "url", url: e.url, message: e.instructions ?? "请在浏览器完成授权" };
          }
          if (e.type === "device_code") {
            return { ...prev, phase: "url", message: `请在浏览器输入配对代码：${e.code ?? ""}` };
          }
          if (e.type === "progress") return { ...prev, message: e.message };
          if (e.type === "info") return { ...prev, message: e.message };
          if (e.type === "success") return { ...prev, phase: "done", message: "登录成功 ✓" };
          return prev;
        });
      } else if (ev?.type === "auth_prompt") {
        setLoginFlow({
          providerId: ev.providerId,
          phase: "prompt",
          prompt: ev.prompt ?? {},
          promptId: ev.promptId,
          message: ev.prompt?.message ?? "",
        });
        // 输入框自动聚焦（渲染后）
        window.setTimeout(() => loginInputRef.current?.focus(), 60);
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  // 发起订阅登录（OAuth）
  const startLogin = useCallback(
    async (p: ProviderItem) => {
      setLoginFlow({ providerId: p.id, phase: "starting", message: "正在启动登录…" });
      setLoginInput("");
      const res = await piSend({ type: "login", providerId: p.id, method: "oauth" }).catch(() => null);
      if (res && !res.success) {
        setLoginFlow({ providerId: p.id, phase: "err", message: res?.error ?? "登录失败" });
      } else if (res?.success) {
        setLoginFlow((prev) => ({
          ...(prev ?? { providerId: p.id }),
          phase: "done",
          message: "登录成功 ✓",
        }));
        void refresh();
      }
    },
    [refresh],
  );
  // 打开授权浏览器
  const openAuthUrl = useCallback(async (url?: string) => {
    if (!url) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  }, []);
  // 提交/取消登录输入
  const submitAuthInput = useCallback(async () => {
    if (!loginFlow?.promptId) return;
    const pid = loginFlow.providerId;
    await piSend({ type: "auth_input", promptId: loginFlow.promptId, value: loginInput }).catch(() => {});
    setLoginFlow({ providerId: pid, phase: "url", promptId: undefined, message: "已提交，请完成剩余步骤…" });
    setLoginInput("");
  }, [loginFlow, loginInput]);
  const cancelLogin = useCallback(async () => {
    const pid = loginFlow?.providerId;
    if (loginFlow?.promptId) {
      await piSend({ type: "auth_input", promptId: loginFlow.promptId, cancel: true }).catch(() => {});
    }
    if (pid) await piSend({ type: "login_abort", providerId: pid }).catch(() => {});
    setLoginFlow(null);
    setLoginInput("");
  }, [loginFlow]);

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

  // 保存自定义 provider（写 models.json，重启生效）
  const saveCustomProvider = async () => {
    const id = cpForm.id.trim();
    const baseUrl = cpForm.baseUrl.trim();
    if (!id || !baseUrl) {
      setSavedMsg("自定义 Provider 需填写 Provider ID 和 Base URL");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      setSavedMsg("Provider ID 只能是小写字母/数字/连字符（如 openai-compatible-cn）");
      return;
    }
    const models = cpForm.models
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ id: s }));
    const res = await piSend({
      type: "add_provider",
      providerId: id,
      name: cpForm.name.trim() || id,
      baseUrl,
      api: cpForm.api,
      apiKey: cpForm.apiKey.trim() || undefined,
      models,
    });
    if (res?.success) {
      setSavedMsg(`已保存自定义 Provider「${id}」——重启应用后生效`);
      setCpForm({ id: "", name: "", baseUrl: "", api: "openai-completions", models: "", apiKey: "" });
      void refresh();
    } else {
      setSavedMsg(`保存失败：${res?.error ?? ""}`);
    }
  };
  const removeCustomProvider = async (id: string) => {
    const res = await piSend({ type: "remove_provider", providerId: id });
    if (res?.success) {
      setSavedMsg(`已删除自定义 Provider「${id}」——重启应用后完全移除`);
      void refresh();
    } else {
      setSavedMsg(`删除失败：${res?.error ?? ""}`);
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
              <div className="settings__common">
                <div className="settings__common-head">常用提供商（点「申请密钥」直达官方页面）</div>
                <div className="settings__common-grid">
                  {COMMON_PROVIDERS.map((cp) => {
                    const authed = providers.some((p) => p.id === cp.id && p.authed);
                    return (
                      <div key={cp.id} className="settings__common-item">
                        <div className="settings__common-top">
                          <span className="settings__common-name">{cp.name}</span>
                          {authed && <span className="settings__badge settings__badge--ok">已认证</span>}
                        </div>
                        <div className="settings__common-desc">{cp.desc}</div>
                        <button className="chip chip--sm" onClick={() => void openExtUrl(cp.applyUrl)}>
                          申请密钥 ↗
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
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
                  {selected.isSubscription && (
                    <div className="settings__oauth">
                      <button
                        className="btn btn--primary"
                        onClick={() => void startLogin(selected)}
                        disabled={loginFlow?.phase !== undefined && loginFlow?.phase !== "done" && loginFlow?.phase !== "err"}
                      >
                        {selected.authed && !loginFlow ? "重新登录" : "订阅登录"}
                        {selected.authed && !loginFlow ? "" : " · "}
                        {selected.loginLabel ?? "OAuth"}
                      </button>
                      <span className="settings__oauth-hint">
                        如果已有订阅（Claude Pro / ChatGPT Plus / Copilot 等），可选订阅登录而不用 API Key。
                      </span>
                    </div>
                  )}
                  {loginFlow && (
                    <div className={`settings__loginflow settings__loginflow--${loginFlow.phase}`}>
                      <div className="settings__loginflow-msg">{loginFlow.message ?? "…"}</div>
                      {loginFlow.phase === "url" && loginFlow.url && (
                        <div className="settings__loginflow-actions">
                          <button className="btn btn--primary" onClick={() => void openAuthUrl(loginFlow.url)}>
                            🌐 在浏览器打开授权页
                          </button>
                          {loginFlow.url && (
                            <code className="settings__loginflow-url" title={loginFlow.url} onClick={() => void openAuthUrl(loginFlow.url)}>
                              {loginFlow.url.slice(0, 90)}…
                            </code>
                          )}
                        </div>
                      )}
                      {loginFlow.phase === "prompt" && (
                        <div className="settings__loginflow-prompt">
                          <input
                            ref={loginInputRef}
                            className="settings__keyinput"
                            placeholder={loginFlow.prompt?.placeholder ?? "粘贴授权码 / API Key…"}
                            value={loginInput}
                            onChange={(e) => setLoginInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void submitAuthInput();
                              if (e.key === "Escape") void cancelLogin();
                            }}
                          />
                          <div className="settings__keybtns">
                            <button className="btn btn--primary" onClick={() => void submitAuthInput()}>
                              提交
                            </button>
                            <button className="btn" onClick={() => void cancelLogin()}>
                              取消
                            </button>
                          </div>
                        </div>
                      )}
                      {(loginFlow.phase === "done" || loginFlow.phase === "err") && (
                        <div className="settings__keybtns">
                          <button className="btn" onClick={() => setLoginFlow(null)}>
                            关闭
                          </button>
                        </div>
                      )}
                    </div>
                  )}
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

              {/* 自定义 Provider（models.json）：本地模型/Ollama/网关/兼容端点 */}
              <div className="settings__custom">
                <div className="settings__custom-head">
                  <button
                    className="sidebar__toggle sidebar__toggle--row"
                    onClick={() => setCustomOpen((v) => !v)}
                  >
                    <span className="sidebar__toggle-arrow">{customOpen ? "▾" : "▸"}</span>
                    <span className="sidebar__toggle-label">
                      自定义 Provider{customProviders.length > 0 ? `（${customProviders.length}）` : ""}
                    </span>
                  </button>
                </div>
                {customOpen && (
                  <div className="settings__custom-body">
                    <div className="settings__custom-hint">
                      Ollama / LM Studio / vLLM / 代理网关等 OpenAI 兼容端点，写入
                      ~/.pi/agent/models.json（重启应用生效）。
                    </div>
                    <div className="settings__custom-form">
                      <div className="settings__custom-row">
                        <input
                          className="settings__keyinput"
                          placeholder="Provider ID（如 ollama-cn）"
                          value={cpForm.id}
                          onChange={(e) => setCpForm((f) => ({ ...f, id: e.target.value }))}
                        />
                        <input
                          className="settings__keyinput"
                          placeholder="显示名称（可选）"
                          value={cpForm.name}
                          onChange={(e) => setCpForm((f) => ({ ...f, name: e.target.value }))}
                        />
                      </div>
                      <input
                        className="settings__keyinput"
                        placeholder="Base URL（如 http://localhost:11434/v1）"
                        value={cpForm.baseUrl}
                        onChange={(e) => setCpForm((f) => ({ ...f, baseUrl: e.target.value }))}
                      />
                      <div className="settings__custom-row">
                        <select
                          className="settings__keyinput"
                          value={cpForm.api}
                          onChange={(e) => setCpForm((f) => ({ ...f, api: e.target.value }))}
                        >
                          <option value="openai-completions">openai-completions</option>
                          <option value="openai-responses">openai-responses</option>
                          <option value="anthropic-messages">anthropic-messages</option>
                        </select>
                        <input
                          className="settings__keyinput"
                          placeholder="API Key（可选，如 ollama 可填 ollama）"
                          type="password"
                          value={cpForm.apiKey}
                          onChange={(e) => setCpForm((f) => ({ ...f, apiKey: e.target.value }))}
                        />
                      </div>
                      <input
                        className="settings__keyinput"
                        placeholder="模型 ID，逗号分隔（如 qwen2.5:7b,llama3:8b）"
                        value={cpForm.models}
                        onChange={(e) => setCpForm((f) => ({ ...f, models: e.target.value }))}
                      />
                      <button className="btn btn--primary" onClick={() => void saveCustomProvider()}>
                        保存自定义 Provider
                      </button>
                    </div>
                    {customProviders.length > 0 && (
                      <ul className="settings__custom-list">
                        {customProviders.map((cp) => (
                          <li key={cp.id} className="settings__custom-item">
                            <div className="settings__custom-item-main">
                              <span className="settings__custom-item-name">{cp.name}</span>
                              <code className="settings__custom-item-id">{cp.id}</code>
                              <span className="settings__custom-item-meta">
                                {cp.baseUrl} · {cp.api} · {cp.models.length} 模型
                              </span>
                            </div>
                            <button
                              className="chip chip--sm settings__candidate-del"
                              onClick={() => void removeCustomProvider(cp.id)}
                              title="从 models.json 删除"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
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

              <div className="settings__group-label">界面</div>
              <div className="settings__row">
                <span>界面缩放</span>
                <div className="settings__zoomctl">
                  <button className="zoomctl__btn" onClick={() => zoomOut()} title="缩小（Ctrl + -）">－</button>
                  <button
                    className="zoomctl__val"
                    onClick={() => zoomReset()}
                    title="重置为 100%（Ctrl + 0；点击重置）"
                  >
                    {Math.round(zoomLevel * 100)}%
                  </button>
                  <button className="zoomctl__btn" onClick={() => zoomIn()} title="放大（Ctrl + +）">＋</button>
                </div>
              </div>
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
              <div className="settings__about-row">
                <span>PI 内核版本</span>
                <b>{coreVersion ?? "—"}</b>
              </div>
              <div className="settings__about-diag">
                <div className="settings__about-diag-head">
                  <span>诊断</span>
                  <button
                    className="chip chip--sm"
                    onClick={() => {
                      void refresh();
                    }}
                  >
                    ⟳ 刷新
                  </button>
                </div>
                <div className="settings__about-row">
                  <span>sidecar</span>
                  <b style={{ color: diag?.initialized ? "var(--ok,#3fb27f)" : "var(--danger)" }}>
                    {diag?.initialized ? "已连接" : "未初始化"}
                  </b>
                </div>
                <div className="settings__about-row">
                  <span>Node</span>
                  <b>{diag?.nodeVersion ?? "—"}</b>
                </div>
                <div className="settings__about-row">
                  <span>运行时长</span>
                  <b>{diag?.uptimeSeconds != null ? fmtDuration(diag.uptimeSeconds) : "—"}</b>
                </div>
                <div className="settings__about-row">
                  <span>活动对话</span>
                  <b>{diag?.dialogueCount ?? 0}</b>
                </div>
                {diag?.dialogues && diag.dialogues.length > 0 && (
                  <div className="settings__about-list">
                    {diag.dialogues.map((d) => (
                      <div key={d.id} className="settings__about-list-item" title={d.session ?? ""}>
                        <span className={`settings__about-dot settings__about-dot--${d.status ?? "idle"}`} />
                        <code>{d.id}</code>
                        <span className="settings__about-list-cwd">{d.cwd}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="settings__about-row">
                  <span>auth.json / settings.json / models.json</span>
                  <b>
                    {diag?.files ? `${diag.files.auth ? "✓" : "✗"} ${diag.files.settings ? "✓" : "✗"} ${diag.files.models ? "✓" : "✗"}` : "—"}
                  </b>
                </div>
                {diag?.agentDir && (
                  <div className="settings__about-path" title="~/.pi/agent">
                    配置目录：{diag.agentDir}
                  </div>
                )}
                {diag?.piDist && (
                  <div className="settings__about-path" title="PI 内核加载路径">
                    内核：{diag.piDist}
                  </div>
                )}
              </div>
              <button
                className="chip chip--sm"
                style={{ alignSelf: "center" }}
                onClick={() => void openExtUrl("https://www.npmjs.com/package/@earendil-works/pi-coding-agent")}
              >
                🔎 查看 PI 内核更新 ↗
              </button>
              <div className="settings__about-hint">
                升级内核需重新打包/安装新版安装包；本页可查看最新版本与变更。
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