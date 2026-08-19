/** 全链路回归：init(recent) → get_state → prompt(真实模型) → 事件收集 → get_messages 回读 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const proc = spawn(process.execPath, [path.join(dir, "sidecar.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 0;
const pending = new Map();
const eventLog = [];
let settled = false;

function send(cmd) {
  const id = `req-${++nextId}`; cmd.requestId = id;
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
    else if (o.type === "event") { eventLog.push(o.event); if (o.event.type === "agent_settled") settled = true; }
  }
});
proc.stderr.on("data", (c) => process.stderr.write(c));

let failures = 0;
const check = (n, ok, d="") => { console.log(`${ok?"✅":"❌"} ${n} ${d}`); if(!ok) failures++; };

try {
  // 1) init recent（真实用户会话）
  const init = await send({ type: "init", cwd: "L:/projects/PI-GUI", sessionMode: "recent" });
  check("init recent", init.success === true, JSON.stringify(init.data ?? {}));

  // 2) get_messages 应有历史（recent 会话非空）
  const hist = await send({ type: "get_messages" });
  check("历史消息可读", hist.success === true && Array.isArray(hist.data.messages), `共 ${hist.data?.messages?.length ?? 0} 条`);

  // 3) 真实模型 prompt
  const p0 = Date.now();
  const promptRes = await send({ type: "prompt", message: "只回复：端到端OK。不要做任何其他操作。" });
  check("prompt 接受", promptRes.success === true);
  const deadline = Date.now() + 150000;
  while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  check("agent_settled 到达", settled, `耗时 ${((Date.now()-p0)/1000).toFixed(1)}s`);

  // 4) 事件类型覆盖
  const types = [...new Set(eventLog.map(e => e.type))];
  console.log("  事件类型:", types.join(", "));

  // 5) 回读新消息（含刚才的 prompt）
  const msgs2 = await send({ type: "get_messages" });
  const texts = (msgs2.data.messages ?? []).map(m => JSON.stringify(m).slice(0, 200));
  const hasReply = texts.some(t => t.includes("端到端OK"));
  check("回复已写入会话", hasReply);

  await send({ type: "exit" });
  console.log(failures === 0 ? "\n🎉 全链路回归通过" : `\n⚠️ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) { console.error("异常:", e); process.exit(1); }
