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
    if (existsSync(cand)) return import(pathToFileURL(cand).href);
  }
  try {
    const root = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
    log(`全局 npm root: ${root}`);
    const globalCandidate = path.join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js");
    log(`全局候选: ${globalCandidate} exists=${existsSync(globalCandidate)}`);
    if (existsSync(globalCandidate)) return import(pathToFileURL(globalCandidate).href);
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
let initialized = false;
let currentCwd = null; // 当前项目 cwd（openDialogue 设置，list_sessions 依赖）
// 对话池：每对话 = 一个独立 AgentSessionRuntime（并行对话的地基）。
// 切对话不再销毁旧 runtime，后台可继续流式。
const dialogues = new Map(); // dialogueId -> Dialogue
let currentDialogueId = null; // 当前激活对话（前端 UI 绑定；旧命令默认操作它）
let dialogueSeq = 0;

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
  } else if (sessionMode === "memory") {
    sessionManager = pi.SessionManager.inMemory(targetCwd);
  } else {
    sessionManager = pi.SessionManager.create(targetCwd);
  }

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
    cwd: targetCwd,
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
    cwd: targetCwd,
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
  currentCwd = targetCwd;
  initialized = true;

  const state = snapshotState(session, targetCwd);
  sendResponse(requestId, "open_dialogue", true, {
    dialogueId: id,
    reused: false,
    cwd: targetCwd,
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

      case "get_core_version": {
        // 返回 PI 内核（捆绑 pi-package）的版本，用于「关于/检查更新」
        try {
          let version = "未知";
          let source = null;
          const dist = process.env.PI_GUI_PI_DIST;
          if (dist) {
            const pkg = path.resolve(path.dirname(dist), "package.json");
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
  if (cmd.type === "abort" || cmd.type === "exit") {
    // abort 立即执行以打断当前流式输出；exit 直接退出进程
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