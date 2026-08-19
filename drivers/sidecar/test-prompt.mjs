/** 真实模型实测：prompt → 流式事件 → 文本累积 → agent_settled */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const proc = spawn(process.execPath, [path.join(dir, "sidecar.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 0;
const pending = new Map();
const deltas = [];
let settled = false;

function send(cmd) {
  const id = `req-${++nextId}`;
  cmd.requestId = id;
  proc.stdin.write(JSON.stringify(cmd) + "\n");
  return new Promise((r) => pending.set(id, r));
}
proc.stdout.on("data", (c) => {
  buf += c; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "response") { const r = pending.get(o.requestId); if (r) { pending.delete(o.requestId); r(o); } }
    else if (o.type === "event") {
      const ev = o.event;
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") deltas.push(ev.assistantMessageEvent.delta);
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "thinking_delta") { /* 忽略思考内容 */ }
      if (ev.type === "agent_start") console.log("▶ agent_start");
      if (ev.type === "agent_settled") { settled = true; console.log("■ agent_settled"); }
      if (ev.type === "tool_execution_start") console.log("🔧 tool:", ev.toolName, JSON.stringify(ev.args ?? {}).slice(0, 80));
      if (ev.type === "agent_end" && ev.willRetry) console.log("↻ will retry");
      if (ev.type === "auto_retry_start") console.log("↻ auto_retry:", ev.errorMessage?.slice(0, 100));
    }
  }
});
proc.stderr.on("data", (c) => process.stderr.write(c));

try {
  await send({ type: "init", cwd: "L:/projects/PI-GUI", sessionMode: "memory" });
  console.log("init OK，发送 prompt…");
  const res = await send({ type: "prompt", message: "你好，只回复：收到。不要做任何其他事。" });
  console.log("prompt 响应:", res.success ? "已接受 ✓" : "失败 ✗ " + (res.error ?? ""));
  // 等 agent_settled（最多 120s）
  const deadline = Date.now() + 120_000;
  while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  const state = await send({ type: "get_state" });
  console.log("\n--- 结果 ---");
  console.log("文本累计:", JSON.stringify(deltas.join("")));
  console.log("isStreaming:", state.data?.isStreaming, "| messageCount:", state.data?.messageCount);
  console.log(settled ? "✅ 真实模型链路打通" : "⚠️ 120s 内未 settled");
  await send({ type: "exit" });
  process.exit(settled ? 0 : 1);
} catch (e) {
  console.error("异常:", e);
  process.exit(1);
}
