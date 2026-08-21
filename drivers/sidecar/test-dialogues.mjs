/**
 * sidecar 对话池集成测试。
 * 验证：多对话并存、事件带 dialogueId、get_state 按对话隔离、close_dialogue、会话复用。
 * 注意：并发 prompt 用全新会话（sessionMode:"new"），避免恢复旧会话时模型继续旧任务干扰。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const sidecarPath = path.resolve("drivers/sidecar/sidecar.mjs");
const child = spawn(process.execPath, [sidecarPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PI_SIDECAR_VERBOSE: "0" },
});

const rl = readline.createInterface({ input: child.stdout });
let seq = 0;
const pending = new Map();
const events = [];

rl.on("line", (line) => {
  if (!line.trim()) return;
  let p;
  try {
    p = JSON.parse(line);
  } catch {
    return;
  }
  if (p.type === "response") {
    const resolve = pending.get(p.requestId);
    if (resolve) {
      pending.delete(p.requestId);
      resolve(p);
    }
  } else if (p.type === "event") {
    events.push({ dialogueId: p.dialogueId, type: p.event?.type });
  }
});

function cmd(type, payload = {}) {
  const requestId = `t${++seq}`;
  const line = JSON.stringify({ type, requestId, ...payload });
  child.stdin.write(line + "\n");
  return new Promise((resolve) => pending.set(requestId, resolve));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hardFail = (msg) => {
  console.error("✗", msg);
  child.kill();
  process.exit(1);
};

try {
  // 1. 打开对话 A（新会话）
  const a = await cmd("open_dialogue", { cwd: "L:/projects/PI-GUI", sessionMode: "new" });
  console.log("[1] open A:", a.success, "dlg=", a.data?.dialogueId, "cwd=", a.data?.cwd);
  const dlgA = a.data?.dialogueId;
  if (!a.success || !dlgA) hardFail("open A 失败");

  // 2. 打开对话 B（另一个项目新会话）→ 应并存
  const b = await cmd("open_dialogue", { cwd: "L:/00-projects/dongdong-deepseek-gui-tauri", sessionMode: "new" });
  console.log("[2] open B:", b.success, "dlg=", b.data?.dialogueId);
  const dlgB = b.data?.dialogueId;

  // 3. list_dialogues → 2 个
  const lst = await cmd("list_dialogues");
  const cnt = lst.data?.dialogues?.length ?? 0;
  console.log("[3] list_dialogues:", cnt, "个", lst.data?.dialogues?.map((d) => `${d.dialogueId}(${d.status})`).join(" "));
  if (cnt < 2) hardFail("应存在 2 个对话");

  // 4. get_state 按对话隔离（cwd 兜底后应各自正确）
  const sA = await cmd("get_state", { dialogueId: dlgA });
  const sB = await cmd("get_state", { dialogueId: dlgB });
  console.log("[4] stateA cwd=", sA.data?.cwd, "| stateB cwd=", sB.data?.cwd, sA.data?.cwd !== sB.data?.cwd ? "→ 隔离 OK" : "→ 隔离 FAIL");
  if (sA.data?.cwd !== "L:/projects/PI-GUI" || sB.data?.cwd !== "L:/00-projects/dongdong-deepseek-gui-tauri") hardFail("cwd 隔离/兜底失败");

  // 5. 并发 prompt 到两个对话（验证并行 + 事件带 dialogueId）
  events.length = 0;
  const t0 = Date.now();
  const [pa, pb] = await Promise.allSettled([
    cmd("prompt", { dialogueId: dlgA, message: "回复：ok", streamingBehavior: "steer" }),
    cmd("prompt", { dialogueId: dlgB, message: "回复：ok", streamingBehavior: "steer" }),
  ]);
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("[5] prompt A:", pa.status, "| prompt B:", pb.status, `(${dur}s)`);
  if (pa.status !== "fulfilled" || pb.status !== "fulfilled") hardFail("并发 prompt 未完成");
  const evA = events.filter((e) => e.dialogueId === dlgA);
  const evB = events.filter((e) => e.dialogueId === dlgB);
  console.log("    A 事件数:", evA.length, "B 事件数:", evB.length);
  const isolated = evA.some((e) => e.type === "agent_start") && evB.some((e) => e.type === "agent_start");
  console.log("    事件隔离:", isolated ? "OK" : "FAIL");
  if (!isolated) hardFail("事件未按对话隔离");

  // 6. close B → list 剩 1（A 仍在）
  await cmd("close_dialogue", { dialogueId: dlgB });
  const lst2 = await cmd("list_dialogues");
  console.log("[6] close B 后:", lst2.data?.dialogues?.length, "个（期望 1）");

  // 7. 复用：再次 open 同一会话路径 → 应复用（不新建）
  const reuse = await cmd("open_dialogue", { sessionPath: sA.data?.sessionFile ?? "?" });
  console.log("[7] 复用 open:", reuse.data?.reused ? "reused OK" : `新建(FAIL) dlg=${reuse.data?.dialogueId}`);
  if (!reuse.data?.reused) hardFail("会话复用失败");

  // 8. close A → 池清空
  await cmd("close_dialogue", { dialogueId: dlgA });
  const lst3 = await cmd("list_dialogues");
  console.log("[8] close A 后:", lst3.data?.dialogues?.length, "个（期望 0）");

  await cmd("exit");
  console.log("=== 全部测试通过 ===");
} catch (e) {
  console.error("测试异常:", e.message);
  child.kill();
}
