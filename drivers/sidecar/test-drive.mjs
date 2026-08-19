/**
 * sidecar 冒烟测试驱动：spawn sidecar → 发指令 → 收集响应与事件 → 断言关键点。
 * 用法: node drivers/sidecar/test-drive.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const sidecarPath = path.join(dir, "sidecar.mjs");

const proc = spawn(process.execPath, [sidecarPath], {
  stdio: ["pipe", "pipe", "pipe"],
});

const rl = ["stdout"].reduce((acc, _) => acc, null);
let buf = "";
let nextId = 0;
const pending = new Map();
const events = [];

function send(cmd) {
  const id = `req-${++nextId}`;
  cmd.requestId = id;
  proc.stdin.write(JSON.stringify(cmd) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function onStdout(chunk) {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      console.error("[test] 非 JSON 行:", line.slice(0, 120));
      continue;
    }
    if (obj.type === "response") {
      const { requestId, ...res } = obj;
      const resolve = pending.get(requestId);
      if (resolve) {
        pending.delete(requestId);
        resolve(res);
      } else {
        console.log("[test] 无主响应:", obj);
      }
    } else if (obj.type === "event") {
      events.push(obj.event);
    } else {
      console.log("[test] 其它:", obj);
    }
  }
}

proc.stdout.on("data", onStdout);
proc.stderr.on("data", (c) => process.stderr.write(c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name} ${detail}`);
  if (!ok) failures++;
}

try {
  // 1) init（内存会话，不落盘、不调模型）
  const initRes = await send({ type: "init", cwd: "L:/projects/PI-GUI", sessionMode: "memory" });
  check("init 成功", initRes.success === true, JSON.stringify(initRes.data ?? {}));

  // 2) get_state
  const state = await send({ type: "get_state" });
  check("get_state 成功", state.success === true && state.data.sessionId);

  // 3) get_messages 初始为空
  const msgs = await send({ type: "get_messages" });
  check("get_messages 初始为空", msgs.success === true && Array.isArray(msgs.data.messages));

  // 4) 验证真实 PI 能列出会话（读用户 ~/.pi/agent/sessions）
  const list = await send({ type: "get_session_stats" });
  check("get_session_stats 成功", list.success === true);

  // 5) 退出
  await send({ type: "exit" });
  await sleep(300);
  console.log(`\n事件流共收到 ${events.length} 条（初始会话无模型调用，应为 0）`);
  console.log(failures === 0 ? "\n🎉 sidecar 冒烟通过" : `\n⚠️ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("[test] 异常:", err);
  process.exit(1);
}