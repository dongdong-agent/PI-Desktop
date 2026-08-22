/**
 * PI Sidecar —— AI 工作台的 PI 驱动层（纯 JS，Node 直接运行）
 * ============================================================
 * 职责：内嵌真实 PI SDK（@earendil-works/pi-coding-agent），
 *       把「桌面 UI 指令」翻译成 PI AgentSession 调用，把「PI 会话事件」转发回 UI。
 *
 * 协议：JSONL over stdio（\n 分隔，仅 LF）
 *   stdin  指令: {"type":"init"|"prompt"|..., "requestId":"...", ...}
 *   stdout 响应: {"type":"response","requestId":...,"command":...,"success":true,"data":...}
 *   stdout 事件: {"type":"event","event":{...AgentSessionEvent}}
 *   stderr 日志: [sidecar] 前缀（仅供排查）
 *
 * 原则：这里只是「翻译层」，不实现任何 AI 逻辑 —— 干活的全是真实 PI。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import zlib from "node:zlib";

/** 简易 tar 解包（gzip 已解压的 buffer，按 512 字节头解析；仅用于 npm tarball 解压） */
function untar(buf, outDir) {
  const entries = [];
  let offset = 0;
  const readStr = (start, len) => {
    let end = start + len;
    while (end > start && buf[end - 1] === 0) end--;
    return buf.subarray(start, end).toString("utf8");
  };
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // 末尾零块
    const name = readStr(offset, 100);
    const sizeStr = readStr(offset + 124, 12).trim();
    const type = String.fromCharCode(header[156] ?? 0);
    const size = parseInt(sizeStr, 8) || 0;
    offset += 512;
    if (!name) break;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === "5") continue; // 目录由 mkdir 隐式创建
    if (!size) continue;
    entries.push({ name, data });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 0) 解析 PI 包（优先显式路径 → 项目依赖 → 全局安装）
// ---------------------------------------------------------------------------

function piCandidates() {
  const list = [];
  if (process.env.PI_GUI_PI_DIST) list.push(process.env.PI_GUI_PI_DIST);
  list.push(
    path.resolve(import.meta.dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    path.resolve(import.meta.dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.mjs"),
  );
  return list;
}

async function resolvePiModule() {
  const require = createRequire(import.meta.url);
  for (const cand of piCandidates()) {
    log(`候选路径: ${cand} exists=${existsSync(cand)}`);
    if (existsSync(cand)) {
      resolvedPiDistPath = cand;
      return import(pathToFileURL(cand).href);
    }
  }
  try {
    const root = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
    log(`全局 npm root: ${root}`);
    const globalCandidate = path.join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js");
    log(`全局候选: ${globalCandidate} exists=${existsSync(globalCandidate)}`);
    if (existsSync(globalCandidate)) {
      resolvedPiDistPath = globalCandidate;
      return import(pathToFileURL(globalCandidate).href);
    }
  } catch (e) {
    log(`execSync 失败: ${e instanceof Error ? e.message : e}`);
  }
  throw new Error(
    "[sidecar] 找不到 @earendil-works/pi-coding-agent，请设置 PI_GUI_PI_DIST 或安装全局 pi。",
  );
}

// ---------------------------------------------------------------------------
// 1) 基础设施：日志与输出
// ---------------------------------------------------------------------------

function log(...args) {
  if (process.env.PI_SIDECAR_VERBOSE !== "1") return;
  process.stderr.write(`[sidecar] ${args.join(" ")}\n`);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResponse(requestId, command, success, data, error) {
  const payload = { type: "response", command, success };
  if (requestId !== undefined) payload.requestId = requestId;
  if (success) payload.data = data ?? null;
  else payload.error = error ?? "unknown error";
  send(payload);
}

function forwardEvent(event, dialogueId = currentDialogueId) {
  // 更新对话池状态（状态机：flowing/thinking/idle）与最后活动时间
  const d = dialogueId ? dialogues.get(dialogueId) : null;
  if (d) {
    d.lastActive = Date.now();
    const t = event?.type ?? "";
    if (t === "agent_start") d.status = "flowing";
    else if (t.startsWith("thinking")) d.status = "thinking";
    else if (t === "agent_end" || t === "turn_end" || t === "session_end" || t === "abort") d.status = "idle";
    if (!d.name && t === "user_message") {
      const content = event?.message?.content;
      if (typeof content === "string") d.name = content.slice(0, 24);
    }
  }
  try {
    send({ type: "event", dialogueId: dialogueId ?? null, event });
  } catch {
    try {
      send({ type: "event", dialogueId: dialogueId ?? null, event: { type: event?.type ?? "unknown" } });
    } catch {
      log("事件序列化失败");
    }
  }
}

// ---------------------------------------------------------------------------
// 2) 运行时状态
// ---------------------------------------------------------------------------

let pi = null; // PI SDK 模块
let resolvedPiDistPath = null; // 实际加载的 PI dist（diagnostics 用）
let initialized = false;
let currentCwd = null; // 当前项目 cwd（openDialogue 设置，list_sessions 依赖）
// 对话池：每对话 = 一个独立 AgentSessionRuntime（并行对话的地基）。
// 切对话不再销毁旧 runtime，后台可继续流式。
const dialogues = new Map(); // dialogueId -> Dialogue
let currentDialogueId = null; // 当前激活对话（前端 UI 绑定；旧命令默认操作它）
let dialogueSeq = 0;

// OAuth / 登录子流程：login 命令等待前端弹窗输入（API key / 手动授权码）
const pendingAuthPrompts = new Map(); // promptId -> { resolve, reject }
let authPromptSeq = 0;
const loginControllers = new Map(); // providerId -> AbortController

// ---------------------------------------------------------------------------
// 3) 会话事件订阅（runtime 更换 session 后必须重新订阅 —— 官方约定）
// ---------------------------------------------------------------------------

function subscribeDialogue(session, dialogueId) {
  return session.subscribe((event) => {
    forwardEvent(event, dialogueId);
  });
}

// ---------------------------------------------------------------------------
// 4) 指令处理
// ---------------------------------------------------------------------------

function snapshotState(s, fallbackCwd = null) {
  const agentState = s.agent?.state;
  return {
    sessionId: s.sessionId,
    sessionFile: s.sessionFile ?? null,
    // 恢复会话时 agentState.cwd 可能为空，用对话自身 cwd 兜底（前端 currentCwd 依赖它）
    cwd: agentState?.cwd ?? fallbackCwd ?? null,
    isStreaming: s.isStreaming ?? false,
    messageCount: s.messages?.length ?? 0,
    model: agentState?.model?.id ?? null,
    provider: agentState?.model?.provider ?? null,
    thinkingLevel: s.thinkingLevel ?? agentState?.thinkingLevel ?? null,
    errorMessage: agentState?.errorMessage ?? null,
  };
}

function newDialogueId() {
  return `dlg-${Date.now().toString(36)}-${++dialogueSeq}`;
}

/** content（数组或字符串）→ 纯文本（图片标注、忽略其他非文本块） */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c?.type === "text") return c.text ?? "";
      if (c?.type === "thinking") return `[思考] ${c.thinking ?? ""}`;
      if (c?.type === "image") return "[图片]";
      if (c?.type === "toolResult") return typeof c.content === "string" ? c.content : "[工具结果]";
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** 会话消息 → Markdown（导出/实时保存用） */
function messagesToMarkdown(msgs, meta = {}) {
  const L = [];
  L.push("# PI Agent 对话记录");
  L.push("");
  if (meta.cwd) L.push(`- 项目：\`${meta.cwd}\``);
  if (meta.sessionFile) L.push(`- 会话：\`${meta.sessionFile}\``);
  if (meta.model) L.push(`- 模型：${meta.model}`);
  L.push(`- 导出时间：${new Date().toLocaleString()}`);
  L.push("");
  L.push("---");
  L.push("");
  for (const m of msgs ?? []) {
    const role = m?.role;
    if (role === "user") {
      const text = contentToText(m.content);
      if (text) {
        L.push("## 👤 用户");
        L.push("");
        L.push(text);
        L.push("");
      }
    } else if (role === "assistant") {
      const parts = Array.isArray(m.content) ? m.content : [];
      const think = parts.filter((p) => p?.type === "thinking").map((p) => p.thinking ?? "").join("\n\n");
      const text = parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n\n");
      const toolCalls = parts.filter((p) => p?.type === "toolCall");
      if (think) {
        L.push("<details><summary>💭 思考</summary>");
        L.push("");
        L.push(think);
        L.push("</details>");
        L.push("");
      }
      if (text) {
        L.push("## 🤖 PI");
        L.push("");
        L.push(text);
        L.push("");
      }
      for (const tc of toolCalls) {
        L.push(`**工具调用：\`${tc.name ?? ""}\`**`);
        L.push("");
        L.push("```json");
        L.push(JSON.stringify(tc.arguments ?? {}, null, 2));
        L.push("```");
        L.push("");
      }
    } else if (role === "toolResult") {
      const text = contentToText(m.content);
      if (text) {
        L.push(`**工具结果${m.toolName ? `（${m.toolName}）` : ""}${m.isError ? " ⚠️" : ""}**`);
        L.push("");
        L.push("```");
        L.push(text);
        L.push("```");
        L.push("");
      }
    }
  }
  return L.join("\n");
}

/** 取对话：id 为空时取当前激活对话；找不到返回 null */
function getDialogue(id) {
  if (id) return dialogues.get(id) ?? null;
  return currentDialogueId ? (dialogues.get(currentDialogueId) ?? null) : null;
}

/**
 * 打开/激活一个对话（每对话 = 独立 AgentSessionRuntime，并行对话核心）。
 * - 同 sessionPath 已存在 → 直接激活复用（避免同一会话被两个 runtime 打开冲突）
 * - sessionPath 空 + sessionMode="recent" → 该项目最近会话
 * - 其余 → 新建会话
 * 旧的对话不销毁，保留后台继续流式。
 */
async function openDialogue({ cwd, agentDir, sessionPath, sessionMode }, requestId) {
  const targetCwd = cwd ?? process.cwd();
  const targetAgentDir = agentDir ?? pi.getAgentDir();

  // 复用：同 sessionPath 已有对话 → 激活并返回（避免同一会话被两个 runtime 打开）
  if (sessionPath) {
    for (const d of dialogues.values()) {
      if (d.sessionPath === sessionPath) {
        currentDialogueId = d.id;
        d.lastActive = Date.now();
        sendResponse(requestId, "open_dialogue", true, {
          dialogueId: d.id,
          reused: true,
          cwd: d.cwd,
          overload: dialogues.size > 6,
          state: snapshotState(d.runtime.session, d.cwd),
        });
        return d.id;
      }
    }
  }

  let sessionManager;
  if (sessionPath) {
    sessionManager = pi.SessionManager.open(sessionPath);
  } else if (sessionMode === "recent") {
    sessionManager = pi.SessionManager.continueRecent(targetCwd);
    // 复用检查（recent 模式）：该项目最近会话若已在池中 → 激活返回，避免重复打开同一会话
    const f = sessionManager?.sessionFile ?? null;
    if (f) {
      for (const d of dialogues.values()) {
        if (d.sessionPath === f) {
          currentDialogueId = d.id;
          currentCwd = d.cwd;
          d.lastActive = Date.now();
          sendResponse(requestId, "open_dialogue", true, {
            dialogueId: d.id,
            reused: true,
            cwd: d.cwd,
            overload: dialogues.size > 6,
            state: snapshotState(d.runtime.session, d.cwd),
          });
          return d.id;
        }
      }
    }
  } else if (sessionMode === "memory") {
    sessionManager = pi.SessionManager.inMemory(targetCwd);
  } else {
    sessionManager = pi.SessionManager.create(targetCwd);
  }

  // 会话真实 cwd：SessionManager.open 会从会话文件 header 恢复（cwdOverride 未传时），
  // 例如 switch_session 不带 cwd 时也指向正确项目，避免错成 sidecar 启动目录。
  const effectiveCwd = sessionManager?.cwd ?? targetCwd;

  const { createAgentSessionRuntime, createAgentSessionFromServices, createAgentSessionServices } = pi;
  const createRuntime = async ({ cwd: rtCwd, sessionManager: rtSm, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: rtCwd });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager: rtSm, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: effectiveCwd,
    agentDir: targetAgentDir,
    sessionManager,
  });
  const session = runtime.session;
  // 恢复已存在会话时兜底：上次中断可能留下「最后一条是未完成 toolCall」
  // （崩溃/强杀/heredoc 卡死现场）。模型看到历史里自己发了 toolCall 无结果，
  // 会在下个 prompt 重发该调用 → 重新执行卡死命令 → prompt 永久挂起。
  // 这里注入一条 toolResult 关闭它，让会话处于干净状态。
  if (sessionPath || sessionMode === "recent") {
    try {
      closeUnfinishedToolCalls(session, sessionManager);
    } catch (e) {
      log("关闭未完成 toolCall 失败:", e?.message ?? e);
    }
  }
  const id = newDialogueId();
  const dialogue = {
    id,
    runtime,
    cwd: effectiveCwd,
    // 记录实际会话文件（new/recent/memory 打开时请求无 sessionPath，
    // 但 runtime 落盘后 sessionFile 才有值；用真实文件才能命中复用检查）
    sessionPath: sessionPath ?? session.sessionFile ?? null,
    name: "",
    status: "idle",
    model: session.agent?.state?.model?.id ?? null,
    provider: session.agent?.state?.model?.provider ?? null,
    createdAt: Date.now(),
    lastActive: Date.now(),
    unsubscribe: null,
  };
  dialogue.unsubscribe = subscribeDialogue(session, id);
  dialogues.set(id, dialogue);
  currentDialogueId = id;
  currentCwd = effectiveCwd;
  initialized = true;

  const state = snapshotState(session, effectiveCwd);
  sendResponse(requestId, "open_dialogue", true, {
    dialogueId: id,
    reused: false,
    cwd: effectiveCwd,
    overload: dialogues.size > 6,
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    state,
    diagnostics: runtime.diagnostics ?? [],
  });
  return id;
}

/**
 * 关闭会话末尾的未完成 toolCall（崩溃/中断遗留）：
 * 向 sessionManager 追加 toolResult（写会话文件）+ 同步 agent 内存态。
 * 返回关闭的 toolCall 数。仅处理「消息流末尾、无后续结果跟随」的调用。
 */
function closeUnfinishedToolCalls(session, sessionManager) {
  const messages = session.agent?.state?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  // 从末尾回溯：先收集已见到的 toolResult id；遇到 assistant toolCall 且 id 未闭合 → 未完成
  const resolved = new Set();
  const pending = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "toolResult") {
      resolved.add(m.toolCallId);
      continue;
    }
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      const tcs = m.content.filter((c) => c?.type === "toolCall");
      if (tcs.length) {
        for (const tc of tcs) {
          if (tc.id && !resolved.has(tc.id)) pending.push(tc);
        }
        // 已到「最近的未完成链」起点；更早的历史未闭合调用不会触发模型重试，无需处理
        if (pending.length) break;
      }
      continue;
    }
    if (m?.role === "user") break;
  }
  if (pending.length === 0) return 0;

  const now = Date.now();
  for (const tc of pending) {
    const result = {
      role: "toolResult",
      toolCallId: tc.id,
      toolName: tc.name,
      content: [
        {
          type: "text",
          text: `[会话恢复] 工具调用 ${tc.name ?? ""} 因上次会话中断未完成，已自动中止（未执行）。如仍需该操作，请重新发起。`,
        },
      ],
      isError: true,
      timestamp: now,
    };
    try {
      sessionManager.appendMessage(result); // 写会话文件（持久化）
    } catch {
      /* 文件层失败不阻断内存同步 */
    }
    // 同步 agent 内存态（appendMessage 只写文件，不更新 agent.state.messages）
    session.agent.state.messages.push(result);
  }
  return pending.length;
}

async function handleCommand(cmd) {
  const { type, requestId } = cmd;
  if (!initialized && type !== "init" && type !== "open_dialogue" && type !== "list_dialogues" && type !== "get_core_version") {
    sendResponse(requestId, type, false, undefined, "尚未 init");
    return;
  }
  // 解析命令作用域对话（默认当前激活对话）；会话类命令在统一作用域下执行
  const scopeDlg = getDialogue(cmd.dialogueId);
  const session = scopeDlg?.runtime.session ?? null;
  const runtime = scopeDlg?.runtime ?? null;
  const agent = session?.agent ?? null;
  try {
    switch (type) {
      case "init":
      case "open_dialogue":
        await openDialogue(
          { cwd: cmd.cwd, agentDir: cmd.agentDir, sessionPath: cmd.sessionPath, sessionMode: cmd.sessionMode },
          requestId,
        );
        break;

      case "list_dialogues": {
        const list = [...dialogues.values()].map((d) => ({
          dialogueId: d.id,
          cwd: d.cwd,
          sessionPath: d.sessionPath,
          name: d.name,
          status: d.status,
          model: d.model,
          provider: d.provider,
          lastActive: d.lastActive,
          isCurrent: d.id === currentDialogueId,
        }));
        sendResponse(requestId, "list_dialogues", true, { dialogues: list, currentDialogueId });
        break;
      }

      case "close_dialogue": {
        const d = dialogues.get(cmd.dialogueId);
        if (!d) {
          sendResponse(requestId, "close_dialogue", false, undefined, "对话不存在");
          break;
        }
        try {
          d.unsubscribe?.();
        } catch {
          /* ignore */
        }
        try {
          await d.runtime.dispose();
        } catch {
          /* ignore */
        }
        dialogues.delete(d.id);
        if (currentDialogueId === d.id) currentDialogueId = null;
        sendResponse(requestId, "close_dialogue", true, { dialogueId: d.id });
        break;
      }

      case "activate_dialogue": {
        // 侧栏「对话中」列表：切换激活指定对话（不新建，后台对话继续流式）
        const d = dialogues.get(cmd.dialogueId);
        if (!d) {
          sendResponse(requestId, "activate_dialogue", false, undefined, "对话不存在");
          break;
        }
        currentDialogueId = d.id;
        currentCwd = d.cwd;
        d.lastActive = Date.now();
        sendResponse(requestId, "activate_dialogue", true, {
          dialogueId: d.id,
          cwd: d.cwd,
          state: snapshotState(d.runtime.session, d.cwd),
        });
        break;
      }

      case "login": {
        // 订阅登录（OAuth）/ API key 登录：走 ModelRuntime.login，
        // 浏览器授权需要前端参与——notify 转发 auth_url/device_code 事件，
        // prompt 转发为 auth_prompt 事件，前端弹窗后回 auth_input。
        const pid = cmd.providerId;
        const method = cmd.method ?? (cmd.apiKey ? "api_key" : "oauth");
        if (!pid) {
          sendResponse(requestId, "login", false, undefined, "缺少 providerId");
          break;
        }
        const dlg = getDialogue(cmd.dialogueId);
        const session = dlg?.runtime.session ?? null;
        const mr = session?.services?.modelRuntime ?? dlg?.runtime?.services?.modelRuntime ?? null;
        if (!mr || typeof mr.login !== "function") {
          sendResponse(requestId, "login", false, undefined, "modelRuntime 不可用");
          break;
        }
        const controller = new AbortController();
        loginControllers.set(pid, controller);
        try {
          const credential = await mr.login(pid, method, {
            signal: controller.signal,
            prompt: async (p) => {
              const promptId = `ap-${Date.now().toString(36)}-${++authPromptSeq}`;
              send({ type: "auth_prompt", promptId, providerId: pid, prompt: p ?? {} });
              return new Promise((resolve, reject) => {
                pendingAuthPrompts.set(promptId, { resolve, reject, providerId: pid });
                controller.signal.addEventListener(
                  "abort",
                  () => {
                    pendingAuthPrompts.delete(promptId);
                    reject(new Error("Login cancelled"));
                  },
                  { once: true },
                );
              });
            },
            notify: (event) => {
              send({ type: "auth_event", providerId: pid, event: event ?? {} });
            },
          });
          loginControllers.delete(pid);
          // 成功后通知前端并返回当前认证状态
          send({ type: "auth_event", providerId: pid, event: { type: "success" } });
          sendResponse(requestId, "login", true, {
            providerId: pid,
            credential: { source: credential?.source ?? null, type: credential?.type ?? null },
          });
        } catch (e) {
          loginControllers.delete(pid);
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("cancelled") || msg.includes("Cancel")) {
            sendResponse(requestId, "login", false, undefined, "登录已取消");
          } else {
            sendResponse(requestId, "login", false, undefined, `登录失败：${msg}`);
          }
        }
        break;
      }

      case "auth_input": {
        // 前端弹窗后的输入回填（API key / 手动授权码 / 取消）
        const entry = pendingAuthPrompts.get(cmd.promptId);
        if (!entry) {
          sendResponse(requestId, "auth_input", false, undefined, "无效的输入会话");
          break;
        }
        pendingAuthPrompts.delete(cmd.promptId);
        if (cmd.cancel) {
          entry.reject(new Error("Login cancelled"));
        } else if (typeof cmd.value === "string") {
          entry.resolve(cmd.value);
        } else {
          entry.reject(new Error("缺少输入值"));
        }
        sendResponse(requestId, "auth_input", true);
        break;
      }

      case "login_abort": {
        const c = loginControllers.get(cmd.providerId);
        if (c) c.abort();
        loginControllers.delete(cmd.providerId);
        sendResponse(requestId, "login_abort", true);
        break;
      }

      case "prompt":
        {
          const dlg = getDialogue(cmd.dialogueId);
          if (!dlg) {
            sendResponse(requestId, "prompt", false, undefined, "对话不存在或未激活");
            break;
          }
          const session = dlg.runtime.session;
          const raw = cmd.message ?? "";
          // !cmd / !!cmd：直执行 shell（不走 LLM）。!! = 输出不进上下文（对齐 TUI）
          const bashMatch = /^!{1,2}\s+/.exec(raw) || /^!{1,2}[^\s]/.exec(raw);
          if (bashMatch) {
            const isExcluded = raw.startsWith("!!");
            const command = (isExcluded ? raw.slice(2) : raw.slice(1)).trim();
            if (!session.executeBash) {
              sendResponse(requestId, "prompt", false, undefined, "当前会话不支持 executeBash");
              break;
            }
            // 事件：工具执行开始（UI 时间线会显示 bash 执行）
            forwardEvent({
              type: "tool_execution_start",
              id: `bash-${Date.now()}`,
              name: "bash",
              status: "running",
            }, dlg.id);
            await session.executeBash(command, (chunk) => {
              forwardEvent({
                type: "tool_execution_update",
                id: `bash-${Date.now()}`,
                name: "bash",
                status: "running",
                chunk,
              }, dlg.id);
            }, {
              excludeFromContext: isExcluded,
            });
            forwardEvent({
              type: "tool_execution_end",
              id: `bash-${Date.now()}`,
              name: "bash",
              status: "done",
              isError: false,
            }, dlg.id);
            sendResponse(requestId, "prompt", true, { bash: true, command, excludeFromContext: isExcluded });
            break;
          }
          dlg.status = "flowing";
          await session.prompt(raw, {
            streamingBehavior: cmd.streamingBehavior ?? "steer",
            images: cmd.images,
          });
          dlg.status = "idle";
          sendResponse(requestId, "prompt", true);
        }
        break;

      case "steer":
        await session.steer(cmd.message ?? "");
        sendResponse(requestId, "steer", true);
        break;

      case "follow_up":
        await session.followUp(cmd.message ?? "");
        sendResponse(requestId, "follow_up", true);
        break;

      case "abort":
        await session.abort();
        sendResponse(requestId, "abort", true);
        break;

      case "get_state": {
        // AgentState 无 cwd 字段（PI SDK 设计），用对话自己的 cwd 补上，
        // 前端 loadAll 依赖它恢复当前项目高亮；dialogueId 供前端按对话过滤事件。
        sendResponse(requestId, "get_state", true, {
          dialogueId: scopeDlg?.id ?? currentDialogueId ?? null,
          ...snapshotState(session, scopeDlg?.cwd ?? null),
        });
        break;
      }

      case "get_messages":
        sendResponse(requestId, "get_messages", true, { messages: session.messages ?? [] });
        break;

      case "get_tree": {
        // 会话树：返回完整消息树（含分支），用于 /tree 可视化回溯
        try {
          const sm = session?.sessionManager;
          if (!sm || typeof sm.getTree !== "function") {
            sendResponse(requestId, "get_tree", false, undefined, "sessionManager 不可用");
            break;
          }
          // 递归精简：只保留 UI 需要的字段
          const simplify = (node) => ({
            id: node.entry?.id ?? null,
            type: node.entry?.type ?? null,
            parentId: node.entry?.parentId ?? null,
            role: node.entry?.message?.role ?? null,
            text:
              typeof node.entry?.message?.content === "string"
                ? node.entry.message.content.slice(0, 120)
                : Array.isArray(node.entry?.message?.content)
                  ? node.entry.message.content
                      .filter((c) => c?.type === "text")
                      .map((c) => c.text)
                      .join(" ")
                      .slice(0, 120)
                  : "",
            label: node.label ?? null,
            leaf: node.id === sm.getLeafEntry?.()?.id,
            children: (node.children ?? []).map(simplify),
          });
          const tree = (sm.getTree() ?? []).map(simplify);
          sendResponse(requestId, "get_tree", true, { tree, leafId: sm.getLeafEntry?.()?.id ?? null });
        } catch (e) {
          sendResponse(requestId, "get_tree", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "get_commands": {
        // 从真实 PI 的资源加载器读取技能/提示词/扩展（即“不断增加的技能”的来源）
        try {
          const loader = runtime?.services?.resourceLoader;
          let skills = [];
          let prompts = [];
          let extensions = [];
          if (loader) {
            const skillsRes = await loader.getSkills();
            const promptsRes = await loader.getPrompts();
            const extRes = await loader.getExtensions();
            skills = skillsRes?.skills ?? [];
            prompts = promptsRes?.prompts ?? [];
            extensions = extRes?.extensions ?? [];
          }
          sendResponse(requestId, "get_commands", true, {
            skills,
            prompts,
            extensions,
            diagnostics: runtime?.diagnostics ?? [],
          });
        } catch (e) {
          sendResponse(requestId, "get_commands", true, {
            skills: [],
            prompts: [],
            extensions: [],
            error: e instanceof Error ? e.message : String(e),
          });
        }
        break;
      }

      case "set_model": {
        // 用完整 Model 对象切换；支持 provider+modelId 精确定位（同 id 不同 provider 的模型）
        const mr = runtime?.services?.modelRuntime;
        let model = null;
        if (mr) {
          const available = await mr.getAvailable();
          if (cmd.provider && cmd.modelId) {
            model =
              (available ?? []).find(
                (m) => m.provider === cmd.provider && m.id === cmd.modelId,
              ) ?? null;
          } else {
            model = (available ?? []).find((m) => m.id === cmd.modelId) ?? null;
          }
        }
        if (!model) {
          sendResponse(requestId, "set_model", false, undefined,
            `模型不存在: ${cmd.provider ? `${cmd.provider}/` : ""}${cmd.modelId ?? "(空)"}`);
          break;
        }
        await session.setModel(model);
        sendResponse(requestId, "set_model", true, { model: model.id, provider: model.provider });
        break;
      }

      case "get_available_models": {
        const mr = runtime?.services?.modelRuntime;
        const models = mr ? await mr.getAvailable() : [];
        sendResponse(requestId, "get_available_models", true, {
          models: (models ?? []).map((m) => ({
            id: m.id,
            name: m.name,
            provider: m.provider,
          })),
        });
        break;
      }

      case "read_file": {
        // @ 文件引用：读项目内文件内容（相对 cwd 或绝对路径，限大小）
        const root = currentCwd || agent.state?.cwd || process.cwd();
        const target = cmd.path ? path.resolve(root, cmd.path) : null;
        let content = "";
        // 越权校验：path.relative 统一分隔符（root 可能正斜杠 / target 可能反斜杠）
        const rel = target ? path.relative(root, target) : "..";
        if (!target || rel.startsWith("..") || path.isAbsolute(rel)) {
          sendResponse(requestId, "read_file", false, undefined, "路径不合法（需在项目目录内）");
          break;
        }
        try {
          const st = await fs.stat(target);
          if (!st.isFile() || st.size > 2_000_000) {
            sendResponse(requestId, "read_file", false, undefined, "文件不存在或超过 2MB");
            break;
          }
          content = await fs.readFile(target, "utf8");
        } catch (e) {
          sendResponse(requestId, "read_file", false, undefined,
            e instanceof Error ? e.message : String(e));
          break;
        }
        sendResponse(requestId, "read_file", true, { path: cmd.path, content, size: content.length });
        break;
      }

      case "search_files": {
        // @ 文件引用：递归扫描当前项目文件（深度/大小受限），query 子串过滤，返回相对路径
        const root = currentCwd || agent.state?.cwd || process.cwd();
        const query = (cmd.query ?? "").toLowerCase();
        const maxDepth = cmd.maxDepth ?? 6;
        const maxCount = cmd.maxCount ?? 60;
        const IGNORE = new Set([
          "node_modules", ".git", ".hg", ".svn", "target", "dist", "build", "out",
          ".next", ".nuxt", "coverage", "vendor", "__pycache__", ".venv",
          "resources/pi-package", "resources/node-win-x64",
        ]);
        const ALLOW_EXT = new Set([
          ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx",
          ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp", ".cs",
          ".rb", ".php", ".html", ".css", ".scss", ".yml", ".yaml", ".toml",
          ".sh", ".bat", ".ps1", ".sql", ".xml", ".env", ".txt", ".ini",
          ".vue", ".svelte", ".astro", ".swift", ".kt", ".dart", ".lua",
          ".dockerfile", ".conf", ".cfg", ".properties", ".gitignore",
        ]);
        const results = [];
        const walk = async (dir, depth) => {
          if (depth > maxDepth || results.length >= maxCount) return;
          let entries;
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          const dirs = [];
          for (const e of entries) {
            if (e.name.startsWith(".") || IGNORE.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) dirs.push(full);
            else if (e.isFile()) {
              const ext = path.extname(e.name).toLowerCase();
              // 允许全部扩展名但给低权重，只限制体积
              let size = 0;
              try {
                const st = await fs.stat(full);
                size = st.size;
              } catch {
                continue;
              }
              if (size > (cmd.maxFileSize ?? 1_500_000)) continue;
              const rel = path.relative(root, full).split(path.sep).join("/");
              if (!query || rel.toLowerCase().includes(query)) {
                results.push({ path: rel, size });
              }
              if (results.length >= maxCount) return;
            }
          }
          for (const d of dirs) await walk(d, depth + 1);
        };
        await walk(root, 0);
        // 排序：目录层级浅优先 + 名称匹配靠前
        results.sort((a, b) => {
          const qa = a.path.toLowerCase();
          const qb = b.path.toLowerCase();
          if (query) {
            const ia = qa.indexOf(query);
            const ib = qb.indexOf(query);
            if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
          }
          return a.path.length - b.path.length;
        });
        sendResponse(requestId, "search_files", true, { files: results.slice(0, maxCount), root });
        break;
      }

      case "list_projects": {
        // 项目发现：扫描 ~/.pi/agent/sessions 的子目录，读每个子目录最新会话 header 的 cwd
        const agentDir = pi.getAgentDir();
        const sessionsDir = path.join(agentDir, "sessions");
        const projects = [];
        const seen = new Set();
        try {
          const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const sub = path.join(sessionsDir, entry.name);
            let files = [];
            try {
              files = (await fs.readdir(sub)).filter((f) => f.endsWith(".jsonl"));
            } catch {
              continue;
            }
            if (files.length === 0) continue;
            files.sort();
            const latest = files[files.length - 1];
            try {
              const header = JSON.parse(
                (await fs.readFile(path.join(sub, latest), "utf8")).split("\n")[0],
              );
              const cwd = header?.cwd;
              if (cwd && !seen.has(cwd)) {
                seen.add(cwd);
                projects.push({ cwd, sessionCount: files.length });
              }
            } catch {
              continue;
            }
          }
        } catch {
          /* sessions 目录不存在时返回空 */
        }
        projects.sort((a, b) => a.cwd.localeCompare(b.cwd));
        sendResponse(requestId, "list_projects", true, { projects });
        break;
      }

      case "get_providers": {
        // 模型提供商列表 + 认证状态
        const mr = runtime?.services?.modelRuntime;
        const providers = mr ? mr.getProviders() : [];
        // auth.json 里的已持久化凭证（key 仅回传本地 GUI 用于候选列表同步，不外发）
        let raw = {};
        try {
          const authPath = path.join(pi.getAgentDir(), "auth.json");
          raw = JSON.parse(await fs.readFile(authPath, "utf8"));
        } catch {
          /* 无 auth.json */
        }
        const list = (providers ?? []).map((p) => {
          const cred = raw[p.id];
          return {
            id: p.id,
            name: p.name,
            authed: !!cred,
            key: typeof cred?.key === "string" ? cred.key : null,
            // 订阅登录（OAuth）与登录标签：供设置面板渲染「订阅登录」入口
            isSubscription: p.auth?.oauth?.isSubscription ?? false,
            loginLabel: p.auth?.oauth?.loginLabel ?? p.auth?.apiKey?.name ?? null,
          };
        });
        sendResponse(requestId, "get_providers", true, { providers: list });
        break;
      }

      case "set_api_key": {
        // 为 provider 持久化 API Key（写 ~/.pi/agent/auth.json，终端共享）并让当前 runtime 生效
        const pid = cmd.providerId;
        const key = cmd.apiKey;
        if (!pid) {
          sendResponse(requestId, "set_api_key", false, undefined, "缺少 providerId");
          break;
        }
        try {
          const authPath = path.join(pi.getAgentDir(), "auth.json");
          let auth = {};
          try {
            auth = JSON.parse(await fs.readFile(authPath, "utf8"));
          } catch {
            /* 不存在则新建 */
          }
          if (key) {
            auth[pid] = { key, type: "api_key" };
          } else {
            delete auth[pid]; // 空 key = 移除
          }
          // 原子写入
          const tmp = authPath + ".tmp";
          await fs.writeFile(tmp, JSON.stringify(auth, null, 2), "utf8");
          await fs.rename(tmp, authPath);
          // 所有对话的 runtime 立即生效（并行对话时每个 runtime 各有一份 modelRuntime）
          for (const d of dialogues.values()) {
            const mr = d.runtime?.services?.modelRuntime;
            if (mr && key) await mr.setRuntimeApiKey(pid, key).catch(() => {});
          }
          sendResponse(requestId, "set_api_key", true, { providerId: pid, set: !!key });
        } catch (e) {
          sendResponse(requestId, "set_api_key", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "list_custom_providers": {
        // 自定义 provider（~/.pi/agent/models.json 的 providers 字段）
        const configPath = path.join(pi.getAgentDir(), "models.json");
        let cfg = {};
        try {
          cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
        } catch {
          /* 无 models.json */
        }
        const providers = Object.entries(cfg.providers ?? {}).map(([id, v]) => ({
          id,
          name: v?.name ?? id,
          baseUrl: v?.baseUrl ?? null,
          api: v?.api ?? null,
          models: Array.isArray(v?.models) ? v.models.map((m) => m?.id ?? m).filter(Boolean) : [],
        }));
        sendResponse(requestId, "list_custom_providers", true, { providers });
        break;
      }

      case "add_provider": {
        // 新增/更新自定义 provider：写 ~/.pi/agent/models.json（启动时加载，新会话生效）
        const configPath = path.join(pi.getAgentDir(), "models.json");
        if (!cmd.providerId || !cmd.baseUrl) {
          sendResponse(requestId, "add_provider", false, undefined, "缺少 providerId 或 baseUrl");
          break;
        }
        try {
          let cfg = {};
          try {
            cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
          } catch {
            /* 新建 */
          }
          cfg.providers = cfg.providers ?? {};
          cfg.providers[cmd.providerId] = {
            name: cmd.name ?? cmd.providerId,
            baseUrl: cmd.baseUrl,
            api: cmd.api ?? "openai-completions",
            ...(cmd.apiKey ? { apiKey: cmd.apiKey } : {}),
            ...(cmd.compat && typeof cmd.compat === "object" ? { compat: cmd.compat } : {}),
            models: Array.isArray(cmd.models)
              ? cmd.models.map((m) => (typeof m === "string" ? { id: m } : m))
              : [],
          };
          // 原子写入
          const tmp = configPath + ".tmp";
          await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
          await fs.rename(tmp, configPath);
          sendResponse(requestId, "add_provider", true, { providerId: cmd.providerId, restart: true });
        } catch (e) {
          sendResponse(requestId, "add_provider", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "remove_provider": {
        // 删除自定义 provider（models.json）
        const configPath = path.join(pi.getAgentDir(), "models.json");
        if (!cmd.providerId) {
          sendResponse(requestId, "remove_provider", false, undefined, "缺少 providerId");
          break;
        }
        try {
          let cfg = {};
          try {
            cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
          } catch {
            /* ignore */
          }
          if (cfg.providers && cfg.providers[cmd.providerId]) {
            delete cfg.providers[cmd.providerId];
            const tmp = configPath + ".tmp";
            await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
            await fs.rename(tmp, configPath);
          }
          sendResponse(requestId, "remove_provider", true, { providerId: cmd.providerId, restart: true });
        } catch (e) {
          sendResponse(requestId, "remove_provider", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "get_core_version": {
        // 返回 PI 内核（捆绑 pi-package）的版本，用于「关于/检查更新」
        try {
          let version = "未知";
          let source = null;
          const dist = process.env.PI_GUI_PI_DIST ?? resolvedPiDistPath ?? null;
          if (dist) {
            // package.json 在包的根（dist 的上一级）
            const pkg = path.resolve(path.dirname(dist), "..", "package.json");
            if (existsSync(pkg)) {
              const p = JSON.parse(await fs.readFile(pkg, "utf8"));
              version = p.version || "未知";
              source = "bundled";
            }
          }
          sendResponse(requestId, "get_core_version", true, { version, source });
        } catch (e) {
          sendResponse(requestId, "get_core_version", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "check_pi_update": {
        // 检查 PI 内核更新：当前捆绑版本 vs npm 最新版
        try {
          let current = "未知";
          const dist = process.env.PI_GUI_PI_DIST ?? resolvedPiDistPath ?? null;
          if (dist) {
            try {
              const pkg = path.resolve(path.dirname(dist), "..", "package.json");
              if (existsSync(pkg)) {
                const p = JSON.parse(await fs.readFile(pkg, "utf8"));
                current = p.version ?? "未知";
              }
            } catch {
              /* ignore */
            }
          }
          const res = await fetch("https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest", {
            signal: AbortSignal.timeout(15000),
          }).catch(() => null);
          let latest = null;
          if (res?.ok) {
            const j = await res.json().catch(() => null);
            latest = j?.version ?? null;
          }
          sendResponse(requestId, "check_pi_update", true, {
            current,
            latest,
            updateAvailable: !!latest && latest !== current && current !== "未知",
          });
        } catch (e) {
          sendResponse(requestId, "check_pi_update", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "download_pi_update": {
        // 下载最新内核到资源目录 pi-package.new（解压校验，重启应用时由 Rust 替换旧包）
        const resDir = process.env.PI_GUI_RESOURCE_DIR ?? null;
        if (!resDir) {
          sendResponse(requestId, "download_pi_update", false, undefined, "资源目录不可用（开发环境不适用）");
          break;
        }
        try {
          // 1) 查最新版本
          const res = await fetch("https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest", {
            signal: AbortSignal.timeout(15000),
          }).catch(() => null);
          if (!res?.ok) {
            sendResponse(requestId, "download_pi_update", false, undefined, "获取最新版本失败（网络？）");
            break;
          }
          const meta = await res.json().catch(() => null);
          const version = meta?.version ?? null;
          if (!version) {
            sendResponse(requestId, "download_pi_update", false, undefined, "无法解析最新版本号");
            break;
          }
          const tarballUrl = meta?.dist?.tarball ?? null;
          if (!tarballUrl) {
            sendResponse(requestId, "download_pi_update", false, undefined, "缺少 tarball 地址");
            break;
          }
          // 2) 下载 tarball
          const tarball = await fetch(tarballUrl, { signal: AbortSignal.timeout(120000) }).catch(() => null);
          if (!tarball?.ok) {
            sendResponse(requestId, "download_pi_update", false, undefined, "下载 tarball 失败（网络？）");
            break;
          }
          const gz = Buffer.from(await tarball.arrayBuffer());
          // 3) gunzip + tar 解包
          const raw = zlib.gunzipSync(gz);
          const entries = untar(raw, null);
          if (entries.length === 0) {
            sendResponse(requestId, "download_pi_update", false, undefined, "tarball 解析为空");
            break;
          }
          // 4) 解到 pi-package.new（先清旧目录再写）
          const pkgNew = path.join(resDir, "resources", "pi-package.new");
          await fs.rm(pkgNew, { recursive: true, force: true });
          await fs.mkdir(pkgNew, { recursive: true });
          let wrote = 0;
          for (const e of entries) {
            // tarball 顶层带 package/ 前缀，去掉
            const rel = e.name.replace(/^package\//, "");
            if (!rel) continue;
            const fp = path.join(pkgNew, rel);
            if (!fp.startsWith(pkgNew)) continue; // 防穿越
            await fs.mkdir(path.dirname(fp), { recursive: true });
            await fs.writeFile(fp, e.data);
            wrote++;
          }
          // 5) 校验：dist/index.js 存在 + package.json 版本匹配
          const distJs = path.join(pkgNew, "dist", "index.js");
          if (!existsSync(distJs)) {
            await fs.rm(pkgNew, { recursive: true, force: true });
            sendResponse(requestId, "download_pi_update", false, undefined, "新包缺少 dist/index.js，已回滚");
            break;
          }
          const pkgJson = path.join(pkgNew, "package.json");
          let pkgVersion = null;
          try {
            pkgVersion = JSON.parse(await fs.readFile(pkgJson, "utf8"))?.version ?? null;
          } catch {
            /* ignore */
          }
          sendResponse(requestId, "download_pi_update", true, {
            version: pkgVersion ?? version,
            files: wrote,
            ready: true,
            note: "重启应用后自动替换生效（旧包保留 pi-package.bak）",
          });
        } catch (e) {
          sendResponse(requestId, "download_pi_update", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "session_stats_history": {
        // 用量统计：按天聚合会话消息数 / token / 花费（扫描各项目最近若干会话）
        const days = Math.min(Math.max(Number(cmd.days ?? 14), 1), 90);
        const agentDir = pi.getAgentDir();
        const sessionsDir = path.join(agentDir, "sessions");
        const byDay = new Map();
        try {
          const dirs = await fs.readdir(sessionsDir, { withFileTypes: true });
          for (const entry of dirs) {
            if (!entry.isDirectory()) continue;
            const sub = path.join(sessionsDir, entry.name);
            let files = [];
            try {
              files = (await fs.readdir(sub)).filter((f) => f.endsWith(".jsonl"));
            } catch {
              continue;
            }
            files.sort().reverse();
            // 每项目最近 3 个会话（统计历史取近似，避免全扫描过慢）
            for (const f of files.slice(0, 3)) {
              const fp = path.join(sub, f);
              try {
                const content = await fs.readFile(fp, "utf8");
                for (const line of content.split("\n")) {
                  if (!line.trim()) continue;
                  let e;
                  try {
                    e = JSON.parse(line);
                  } catch {
                    continue;
                  }
                  const m = e?.message;
                  if (m?.role !== "assistant" || !m?.usage) continue;
                  const day = (e?.timestamp ?? "").slice(0, 10);
                  if (!day) continue;
                  const bucket = byDay.get(day) ?? { day, messages: 0, tokens: 0, cost: 0 };
                  bucket.messages++;
                  bucket.tokens += m.usage.totalTokens ?? 0;
                  const c = m.usage.cost;
                  bucket.cost += typeof c === "number" ? c : c?.total ?? 0;
                  byDay.set(day, bucket);
                }
              } catch {
                /* 单文件跳过 */
              }
            }
          }
        } catch (e) {
          sendResponse(requestId, "session_stats_history", false, undefined,
            e instanceof Error ? e.message : String(e));
          break;
        }
        // 按天排序（最近在前），缺的天补 0（便于前端画连续柱状图）
        const list = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, days);
        const totals = list.reduce(
          (acc, d) => ({ messages: acc.messages + d.messages, tokens: acc.tokens + d.tokens, cost: acc.cost + d.cost }),
          { messages: 0, tokens: 0, cost: 0 },
        );
        sendResponse(requestId, "session_stats_history", true, { days: list, totals });
        break;
      }

      case "diagnostics": {
        // GUI 诊断面板：sidecar / PI 内核 / 关键文件 / 对话池状态
        try {
          const agentDir = pi.getAgentDir();
          const has = (p) => {
            try {
              return existsSync(p);
            } catch {
              return false;
            }
          };
          let coreVersion = "未知";
          let piDist = process.env.PI_GUI_PI_DIST ?? resolvedPiDistPath ?? null;
          const dist = piDist;
          if (dist) {
            try {
              // package.json 在包的根（dist 的上一级）
              const pkg = path.resolve(path.dirname(dist), "..", "package.json");
              if (has(pkg)) {
                const p = JSON.parse(await fs.readFile(pkg, "utf8"));
                coreVersion = p.version ?? "未知";
              }
            } catch {
              /* ignore */
            }
          }
          const dlgArr = [...dialogues.values()];
          sendResponse(requestId, "diagnostics", true, {
            coreVersion,
            piDist: dist,
            agentDir,
            nodeVersion: process.version ?? null,
            platform: process.platform ?? null,
            uptimeSeconds: Math.floor(process.uptime?.() ?? 0),
            initialized,
            dialogueCount: dialogues.size,
            currentDialogueId,
            dialogues: dlgArr.map((d) => ({
              id: d.id,
              cwd: d.cwd,
              status: d.status ?? "idle",
              session: d.sessionPath ?? null,
            })),
            files: {
              auth: has(path.join(agentDir, "auth.json")),
              settings: has(path.join(agentDir, "settings.json")),
              models: has(path.join(agentDir, "models.json")),
            },
          });
        } catch (e) {
          sendResponse(requestId, "diagnostics", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "get_settings": {
        const sm = runtime?.services?.settingsManager;
        const s = {
          defaultModel: sm?.getDefaultModel?.() ?? null,
          defaultProvider: sm?.getDefaultProvider?.() ?? null,
          defaultThinkingLevel: sm?.getDefaultThinkingLevel?.() ?? null,
          autoCompaction: sm?.getCompactionEnabled?.() ?? true,
          autoRetry: sm?.getRetryEnabled?.() ?? true,
          hideThinking: sm?.getHideThinkingBlock?.() ?? false,
        };
        sendResponse(requestId, "get_settings", true, s);
        break;
      }

      case "set_setting": {
        // 通用设置（写真实 settings.json，终端共享）
        const sm = runtime?.services?.settingsManager;
        if (!sm) {
          sendResponse(requestId, "set_setting", false, undefined, "settingsManager 不可用");
          break;
        }
        try {
          switch (cmd.key) {
            case "defaultModel":
              sm.setDefaultModel(cmd.value);
              break;
            case "defaultProvider":
              sm.setDefaultProvider(cmd.value);
              break;
            case "defaultThinkingLevel":
              sm.setDefaultThinkingLevel(cmd.value);
              break;
            case "autoCompaction":
              sm.setCompactionEnabled(!!cmd.value);
              break;
            case "autoRetry":
              sm.setRetryEnabled(!!cmd.value);
              break;
            case "hideThinking":
              sm.setHideThinkingBlock(!!cmd.value);
              break;
            default:
              sendResponse(requestId, "set_setting", false, undefined, `未知设置: ${cmd.key}`);
              return;
          }
          await sm.flush?.();
          sendResponse(requestId, "set_setting", true, { key: cmd.key, value: cmd.value });
        } catch (e) {
          sendResponse(requestId, "set_setting", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "backup_sessions": {
        // 备份全部会话：复制 ~/.pi/agent/sessions 下的 jsonl 到目标目录（按项目分子目录）
        if (!cmd.targetDir) {
          sendResponse(requestId, "backup_sessions", false, undefined, "缺少目标目录");
          break;
        }
        try {
          const agentDir = pi.getAgentDir();
          const sessionsDir = path.join(agentDir, "sessions");
          const target = cmd.targetDir;
          await fs.mkdir(target, { recursive: true });
          let copied = 0;
          let totalBytes = 0;
          const dirs = await fs.readdir(sessionsDir, { withFileTypes: true });
          for (const entry of dirs) {
            if (!entry.isDirectory()) continue;
            const sub = path.join(sessionsDir, entry.name);
            let files = [];
            try {
              files = (await fs.readdir(sub)).filter((f) => f.endsWith(".jsonl"));
            } catch {
              continue;
            }
            if (files.length === 0) continue;
            const outDir = path.join(target, entry.name);
            await fs.mkdir(outDir, { recursive: true });
            for (const f of files) {
              const src = path.join(sub, f);
              const stat = await fs.stat(src);
              await fs.copyFile(src, path.join(outDir, f));
              copied++;
              totalBytes += stat.size;
            }
          }
          sendResponse(requestId, "backup_sessions", true, {
            target,
            copied,
            totalBytes,
            projects: dirs.filter((d) => d.isDirectory()).length,
          });
        } catch (e) {
          sendResponse(requestId, "backup_sessions", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "cleanup_sessions": {
        // 清理旧会话（dryRun=true 时仅列出，不删除）：删除修改时间早于 N 天的 jsonl
        const olderThanDays = Math.max(1, Number(cmd.olderThanDays ?? 30));
        const dryRun = cmd.dryRun !== false;
        try {
          const agentDir = pi.getAgentDir();
          const sessionsDir = path.join(agentDir, "sessions");
          const cutoff = Date.now() - olderThanDays * 86_400_000;
          const toDelete = [];
          let totalBytes = 0;
          const dirs = await fs.readdir(sessionsDir, { withFileTypes: true });
          for (const entry of dirs) {
            if (!entry.isDirectory()) continue;
            const sub = path.join(sessionsDir, entry.name);
            let files = [];
            try {
              files = (await fs.readdir(sub)).filter((f) => f.endsWith(".jsonl"));
            } catch {
              continue;
            }
            for (const f of files) {
              const fp = path.join(sub, f);
              try {
                const st = await fs.stat(fp);
                if (st.mtimeMs < cutoff) {
                  toDelete.push(fp);
                  totalBytes += st.size;
                }
              } catch {
                /* skip */
              }
            }
          }
          if (!dryRun) {
            for (const fp of toDelete) {
              try {
                await fs.rm(fp, { force: true });
              } catch {
                /* skip */
              }
            }
          }
          sendResponse(requestId, "cleanup_sessions", true, {
            dryRun,
            olderThanDays,
            toDelete: dryRun ? toDelete : [],
            count: toDelete.length,
            totalBytes,
          });
        } catch (e) {
          sendResponse(requestId, "cleanup_sessions", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "get_context_files": {
        // 上下文文件（AGENTS.md / CLAUDE.md）：项目目录及祖先 + 全局 agentDir
        // 返回列表与内容（includeContent 时），供 GUI 查看/编辑
        const cwd = cmd.cwd ?? currentCwd ?? process.cwd();
        const agentDir = pi.getAgentDir();
        const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
        const scanDir = async (dir) => {
          for (const fn of candidates) {
            const fp = path.join(dir, fn);
            try {
              if ((await fs.stat(fp)).isFile()) return fp;
            } catch {
              /* skip */
            }
          }
          return null;
        };
        const found = [];
        const seen = new Set();
        // 全局（agentDir）
        const globalFp = await scanDir(agentDir);
        if (globalFp) {
          found.push({ path: globalFp, scope: "global" });
          seen.add(globalFp);
        }
        // 项目（cwd 向上到盘根）
        let dir = path.resolve(cwd);
        while (true) {
          const fp = await scanDir(dir);
          if (fp && !seen.has(fp)) {
            found.push({ path: fp, scope: dir === path.resolve(cwd) ? "project" : "ancestor" });
            seen.add(fp);
          }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        // 读取内容（限长 200KB 防阻塞）
        const list = [];
        for (const f of found) {
          let content = null;
          try {
            const st = await fs.stat(f.path);
            if (st.size <= 200 * 1024) content = await fs.readFile(f.path, "utf8");
          } catch {
            /* ignore */
          }
          list.push({
            path: f.path,
            filename: path.basename(f.path),
            scope: f.scope,
            exists: true,
            content: cmd.includeContent ? content : null,
          });
        }
        sendResponse(requestId, "get_context_files", true, { cwd, list });
        break;
      }

      case "create_gist": {
        // 对话分享：把 markdown 上传为 GitHub gist（公开/私密），返回可分享链接
        const { content, filename, description, token, isPublic } = cmd;
        if (!content || typeof content !== "string" || !content.trim()) {
          sendResponse(requestId, "create_gist", false, undefined, "缺少内容");
          break;
        }
        if (!token || typeof token !== "string") {
          sendResponse(requestId, "create_gist", false, undefined, "需要 GitHub Token（需 gist 权限）");
          break;
        }
        try {
          const name = (filename ?? "dialogue.md").replace(/[\\/:*?"<>|]/g, "-");
          const res = await fetch("https://api.github.com/gists", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "User-Agent": "PI-Desktop",
              Accept: "application/vnd.github+json",
            },
            body: JSON.stringify({
              description: typeof description === "string" ? description : "PI Agent 对话分享",
              public: !!isPublic,
              files: { [name]: { content } },
            }),
            signal: AbortSignal.timeout(30000),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) {
            sendResponse(requestId, "create_gist", false, undefined,
              `GitHub 返回 ${res.status}：${j?.message ?? res.statusText}`);
            break;
          }
          sendResponse(requestId, "create_gist", true, {
            html_url: j.html_url ?? null,
            id: j.id ?? null,
            public: j.public ?? !!isPublic,
          });
        } catch (e) {
          sendResponse(requestId, "create_gist", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "search_sessions": {
        // 全局搜索：扫 ~/.pi/agent/sessions 的 jsonl 内容，返回命中会话与上下文片段
        const query = (cmd.query ?? "").trim();
        if (!query) {
          sendResponse(requestId, "search_sessions", false, undefined, "缺少搜索词");
          break;
        }
        const lower = query.toLowerCase();
        const limit = Math.min(cmd.limit ?? 30, 100);
        const agentDir = pi.getAgentDir();
        const sessionsDir = path.join(agentDir, "sessions");
        const results = [];
        try {
          const dirs = await fs.readdir(sessionsDir, { withFileTypes: true });
          for (const entry of dirs) {
            if (!entry.isDirectory()) continue;
            const sub = path.join(sessionsDir, entry.name);
            let files = [];
            try {
              files = (await fs.readdir(sub)).filter((f) => f.endsWith(".jsonl"));
            } catch {
              continue;
            }
            files.sort().reverse(); // 最新的在前
            for (const f of files.slice(0, 30)) {
              const fp = path.join(sub, f);
              try {
                const content = await fs.readFile(fp, "utf8");
                const idx = content.toLowerCase().indexOf(lower);
                if (idx >= 0) {
                  // 提取命中附近的可读片段（剥离 JSON 噪声，压缩空白）
                  const raw = content.slice(Math.max(0, idx - 100), idx + 220);
                  const snippet = raw.replace(/\\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 260);
                  results.push({ path: fp, project: entry.name, snippet });
                  if (results.length >= limit) break;
                }
              } catch {
                /* 单文件跳过 */
              }
            }
            if (results.length >= limit) break;
          }
        } catch (e) {
          sendResponse(requestId, "search_sessions", false, undefined,
            e instanceof Error ? e.message : String(e));
          break;
        }
        sendResponse(requestId, "search_sessions", true, { results, count: results.length, query });
        break;
      }

      case "list_all_sessions": {
        // 全量扫描：按项目分组列出所有会话；无 cwd 归属的列入 orphaned（未分类）
        try {
          const agentDir = pi.getAgentDir();
          const sessionsDir = path.join(agentDir, "sessions");
          const projects = [];
          const orphaned = [];
          const seenCwd = new Set();
          const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) {
              // sessions 目录根下的零散 .jsonl（罕见）→ 未分类
              if (entry.name.endsWith(".jsonl")) {
                orphaned.push({ path: path.join(sessionsDir, entry.name), cwd: null });
              }
              continue;
            }
            const sub = path.join(sessionsDir, entry.name);
            let files = [];
            try {
              files = (await fs.readdir(sub)).filter((f) => f.endsWith(".jsonl"));
            } catch {
              continue;
            }
            if (files.length === 0) continue;
            files.sort();
            // 从最新文件 header 拿 cwd
            let cwd = null;
            try {
              const header = JSON.parse(
                (await fs.readFile(path.join(sub, files[files.length - 1]), "utf8")).split("\n")[0],
              );
              cwd = header?.cwd ?? null;
            } catch {
              cwd = null;
            }
            const list = await pi.SessionManager.list(cwd ?? process.cwd()).catch(() => []);
            const sessions = (list ?? []).map((s) => ({
              path: s.path,
              id: s.id,
              modified: s.modified,
              messageCount: s.messageCount,
              firstMessage: s.firstMessage,
            }));
            if (cwd && !seenCwd.has(cwd)) {
              seenCwd.add(cwd);
              projects.push({ cwd, sessions });
            } else if (!cwd) {
              orphaned.push(...sessions.map((s) => ({ ...s, cwd: null })));
            }
          }
          projects.sort((a, b) => a.cwd.localeCompare(b.cwd));
          sendResponse(requestId, "list_all_sessions", true, { projects, orphaned });
        } catch (e) {
          sendResponse(requestId, "list_all_sessions", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "reload_resources": {
        // 等价终端 /reload：重载技能/扩展/提示词/主题
        const loader = runtime?.services?.resourceLoader;
        if (!loader || typeof loader.reload !== "function") {
          sendResponse(requestId, "reload_resources", false, undefined, "资源加载器不可用");
          break;
        }
        try {
          await loader.reload();
          sendResponse(requestId, "reload_resources", true, null);
        } catch (e) {
          sendResponse(requestId, "reload_resources", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "switch_project": {
        // 切项目 = 打开/激活该项目最近会话的对话（旧对话保留后台继续，不销毁）
        const cwd = cmd.cwd;
        if (!cwd) {
          sendResponse(requestId, "switch_project", false, undefined, "缺少 cwd");
          break;
        }
        await openDialogue({ cwd, sessionMode: cmd.sessionMode ?? "recent" }, requestId);
        break;
      }


      case "set_thinking_level":
        session.setThinkingLevel(cmd.level);
        sendResponse(requestId, "set_thinking_level", true, { level: cmd.level });
        break;

      case "cycle_model":
        sendResponse(requestId, "cycle_model", true, await session.cycleModel());
        break;

      case "new_session":
        // 新建会话 = 在当前项目下新建一个对话（旧对话保留后台继续）
        await openDialogue(
          { cwd: cmd.cwd ?? currentCwd ?? process.cwd(), sessionMode: "new" },
          requestId,
        );
        break;

      case "list_sessions":
        try {
          const cwd = cmd.cwd ?? currentCwd ?? process.cwd();
          const sessions = await pi.SessionManager.list(cwd);
          sendResponse(requestId, "list_sessions", true, { sessions: sessions ?? [] });
        } catch (e) {
          sendResponse(requestId, "list_sessions", true, {
            sessions: [],
            error: e instanceof Error ? e.message : String(e),
          });
        }
        break;

      case "switch_session":
        // 切会话 = 打开/激活该会话路径的对话（原对话保留后台继续，不再被 teardown）
        if (!cmd.sessionPath) {
          sendResponse(requestId, "switch_session", false, undefined, "缺少 sessionPath");
          break;
        }
        await openDialogue({ sessionPath: cmd.sessionPath }, requestId);
        break;

      case "fork": {
        // clone = fork 当前 leaf 且 position=at（立即原地分支，不进入树选择）
        const dlg = getDialogue(cmd.dialogueId);
        if (!dlg) {
          sendResponse(requestId, "fork", false, undefined, "对话不存在或未激活");
          break;
        }
        if (cmd.position === "at") {
          const leafId = dlg.runtime.session?.sessionManager?.getLeafId?.();
          if (!leafId) {
            sendResponse(requestId, "fork", false, undefined, "当前会话无 leaf，无法克隆");
            break;
          }
          await dlg.runtime.fork(leafId, { position: "at" });
        } else {
          await dlg.runtime.fork(cmd.entryId);
        }
        // fork 后 runtime 的当前 session 被替换，重新订阅事件
        try {
          dlg.unsubscribe?.();
        } catch {
          /* ignore */
        }
        dlg.unsubscribe = subscribeDialogue(dlg.runtime.session, dlg.id);
        dlg.sessionPath = dlg.runtime.session?.sessionFile ?? null;
        dlg.model = dlg.runtime.session?.agent?.state?.model?.id ?? null;
        dlg.provider = dlg.runtime.session?.agent?.state?.model?.provider ?? null;
        sendResponse(requestId, "fork", true, null);
        break;
      }

      case "compact":
        sendResponse(requestId, "compact", true, await session.compact(cmd.customInstructions));
        break;

      case "set_session_name":
        if (typeof session.setName === "function") await session.setName(cmd.name ?? "");
        sendResponse(requestId, "set_session_name", true);
        break;

      case "delete_session": {
        // 破坏性操作：仅删除指定会话文件（需前端确认后调用）
        const target = cmd.sessionPath ?? session?.sessionFile;
        if (!target) {
          sendResponse(requestId, "delete_session", false, undefined, "缺少 sessionPath");
          break;
        }
        try {
          await fs.unlink(target);
          sendResponse(requestId, "delete_session", true, { deleted: target });
        } catch (e) {
          sendResponse(requestId, "delete_session", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "delete_project": {
        // 破坏性操作：删除指定 cwd 对应的整个 session 目录（该项目全部会话）。
        // 需前端确认后调用。同一 cwd 若分散在多个子目录，全部一并删除。
        const cwd = cmd.cwd;
        if (!cwd) {
          sendResponse(requestId, "delete_project", false, undefined, "缺少 cwd");
          break;
        }
        try {
          const agentDir = pi.getAgentDir();
          const sessionsDir = path.join(agentDir, "sessions");
          const targets = [];
          let deletedCount = 0;
          const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const sub = path.join(sessionsDir, entry.name);
            let headerCwd = null;
            let files = [];
            try {
              files = (await fs.readdir(sub)).filter((f) => f.endsWith(".jsonl"));
              if (files.length === 0) continue;
              files.sort();
              headerCwd = JSON.parse(
                (await fs.readFile(path.join(sub, files[files.length - 1]), "utf8")).split("\n")[0],
              )?.cwd ?? null;
            } catch {
              continue;
            }
            if (headerCwd === cwd) {
              targets.push(sub);
              deletedCount += files.length;
            }
          }
          if (targets.length === 0) {
            sendResponse(requestId, "delete_project", false, undefined, "未找到该项目，可能已删除");
            break;
          }
          for (const t of targets) {
            await fs.rm(t, { recursive: true, force: true });
          }
          // 关闭池中属于该项目的对话（runtime 持有被删的会话文件会出问题）
          for (const [id, d] of [...dialogues]) {
            if (d.cwd === cwd) {
              try {
                d.unsubscribe?.();
              } catch {
                /* ignore */
              }
              try {
                await d.runtime.dispose();
              } catch {
                /* ignore */
              }
              dialogues.delete(id);
              if (currentDialogueId === id) currentDialogueId = null;
            }
          }
          sendResponse(requestId, "delete_project", true, { cwd, deleted: targets, deletedCount });
        } catch (e) {
          sendResponse(requestId, "delete_project", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;
      }

      case "export_session": {
        // 导出当前会话全文：markdown（阅读用）/ jsonl（备份/迁移，含全部分支 entry）
        const dlg = getDialogue(cmd.dialogueId);
        if (!dlg) {
          sendResponse(requestId, "export_session", false, undefined, "对话不存在或未激活");
          break;
        }
        const session = dlg.runtime.session;
        const format = cmd.format ?? "markdown";
        if (format === "jsonl") {
          const sm = session?.sessionManager;
          const entries = sm?.fileEntries ?? [];
          sendResponse(requestId, "export_session", true, {
            content: entries.map((e) => JSON.stringify(e)).join("\n"),
            ext: "jsonl",
            messageCount: entries.length,
          });
        } else {
          sendResponse(requestId, "export_session", true, {
            content: messagesToMarkdown(session?.messages ?? [], {
              cwd: dlg.cwd,
              sessionFile: session?.sessionFile ?? null,
              model: session?.agent?.state?.model?.id ?? null,
            }),
            ext: "md",
            messageCount: session?.messages?.length ?? 0,
          });
        }
        break;
      }

      case "get_session_stats":
        try {
          const stats = typeof session.getSessionStats === "function"
            ? session.getSessionStats()
            : null;
          // 估算「原始请求体」大小：序列化全部消息的字节数（上游 413 限制的近似）
          let payloadBytes = 0;
          try {
            const msgs = session?.messages ?? [];
            payloadBytes = Buffer.byteLength(JSON.stringify(msgs), "utf8");
          } catch {
            /* 估算失败忽略 */
          }
          sendResponse(requestId, "get_session_stats", true, {
            ...(stats ?? {
              messageCount: session.messages?.length ?? 0,
              sessionFile: session.sessionFile ?? null,
            }),
            payloadBytes,
          });
        } catch (e) {
          sendResponse(requestId, "get_session_stats", false, undefined,
            e instanceof Error ? e.message : String(e));
        }
        break;

      case "exit":
        for (const d of dialogues.values()) {
          try {
            d.unsubscribe?.();
          } catch {
            /* ignore */
          }
          try {
            await d.runtime.dispose();
          } catch {
            /* ignore */
          }
        }
        sendResponse(requestId, "exit", true);
        process.exit(0);
        break;

      default:
        sendResponse(requestId, type, false, undefined, `未知指令: ${type}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`指令 ${type} 失败:`, message);
    sendResponse(requestId, type, false, undefined, message);
  }
}

// ---------------------------------------------------------------------------
// 5) 入口：加载 PI → 读取 stdin 循环
// ---------------------------------------------------------------------------

log("启动中…");
try {
  pi = await resolvePiModule();
  if (process.env.PI_SIDECAR_VERBOSE === "1") {
    const apiSurface = Object.keys(pi)
      .filter((k) => /create|Session|Model|Runtime|run/i.test(k))
      .join(", ");
    log("PI SDK 加载成功:", apiSurface || "(空导出)");
  }
} catch (err) {
  process.stderr.write(`[sidecar] 致命错误: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// 会话状态变更类命令的串行队列：保证 switch_project / switch_session 等切换完成后，
// 后续 prompt 才执行，避免把指令错发到上一个项目/会话（跨项目错发）。
// 查询类命令（get_state / get_messages 等）不排队，直接执行以保持 UI 流畅。
const STATEFUL_COMMANDS = new Set([
  "init",
  "open_dialogue",
  "close_dialogue",
  "activate_dialogue",
  "login",
  "prompt",
  "steer",
  "follow_up",
  "switch_project",
  "set_thinking_level",
  "cycle_model",
  "new_session",
  "switch_session",
  "fork",
  "compact",
  "set_session_name",
  "set_model",
  "delete_session",
  "delete_project",
  "set_api_key",
  "set_setting",
  "reload_resources",
]);
let commandChain = Promise.resolve();
function enqueueStateful(task) {
  const next = commandChain.then(task);
  // 无论成功失败都不让队列断链
  commandChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    sendResponse(undefined, "parse", false, undefined, "无法解析 JSON 指令");
    return;
  }
  if (cmd.type === "abort" || cmd.type === "exit" || cmd.type === "auth_input" || cmd.type === "login_abort") {
    // 立即执行：abort 打断流式；exit 退出；
    // auth_input/login_abort 必须绕过队列，否则会被挂起的 login 阻塞（死锁）
    void handleCommand(cmd);
    return;
  }
  if (STATEFUL_COMMANDS.has(cmd.type)) {
    enqueueStateful(() => handleCommand(cmd));
  } else {
    void handleCommand(cmd);
  }
});

rl.on("close", () => {
  for (const d of dialogues.values()) {
    try {
      d.unsubscribe?.();
    } catch {
      /* ignore */
    }
    try {
      d.runtime?.dispose?.();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

if (process.env.PI_SIDECAR_VERBOSE === "1") {
  process.stderr.write("[sidecar] sidecar 就绪，等待指令…\n");
}