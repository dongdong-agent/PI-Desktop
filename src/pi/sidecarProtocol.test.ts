/**
 * sidecar 协议集成测试（vitest 内跑真实 sidecar 进程）。
 * 覆盖：init / get_state / get_messages / list_projects / get_available_models / 异常指令。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

interface Drive {
  proc: ChildProcess;
  send: (cmd: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
}

function startSidecar(): Drive {
  const proc = spawn(process.execPath, [path.join(dir, "../../drivers/sidecar/sidecar.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let seq = 0;
  const pending = new Map<string, (r: any) => void>();

  proc.stdout!.on("data", (c) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.type === "response") {
        const resolve = pending.get(o.requestId);
        if (resolve) {
          pending.delete(o.requestId);
          resolve(o);
        }
      }
    }
  });
  proc.stderr.on("data", () => {}); // 静默（测试环境）

  const send = (cmd: Record<string, unknown>) =>
    new Promise<any>((resolve) => {
      const requestId = `t-${++seq}`;
      pending.set(requestId, resolve);
      proc.stdin!.write(JSON.stringify({ ...cmd, requestId }) + "\n");
    });

  const close = () =>
    new Promise<void>((resolve) => {
      void send({ type: "exit" }).finally(() => {
        setTimeout(() => {
          proc.kill();
          resolve();
        }, 100);
      });
    });

  return { proc, send, close };
}

let drive: Drive;
beforeAll(async () => {
  drive = startSidecar();
  const init = await drive.send({ type: "init", cwd: "L:/projects/PI-GUI", sessionMode: "memory" });
  expect(init.success).toBe(true);
}, 30000);

afterAll(async () => {
  await drive.close();
});

describe("sidecar 协议", () => {
  it("get_state 返回会话状态", async () => {
    const res = await drive.send({ type: "get_state" });
    expect(res.success).toBe(true);
    expect(res.data.sessionId).toBeTruthy();
  });

  it("get_messages 返回消息数组", async () => {
    const res = await drive.send({ type: "get_messages" });
    expect(res.success).toBe(true);
    expect(Array.isArray(res.data.messages)).toBe(true);
  });

  it("list_projects 扫描到真实项目", async () => {
    const res = await drive.send({ type: "list_projects" });
    expect(res.success).toBe(true);
    expect(Array.isArray(res.data.projects)).toBe(true);
    expect(res.data.projects.length).toBeGreaterThan(0);
  });

  it("get_available_models 返回模型", async () => {
    const res = await drive.send({ type: "get_available_models" });
    expect(res.success).toBe(true);
    expect(Array.isArray(res.data.models)).toBe(true);
    expect(res.data.models.length).toBeGreaterThan(0);
  });

  it("未知指令返回失败（契约保护）", async () => {
    const res = await drive.send({ type: "no_such_command" });
    expect(res.success).toBe(false);
  });
});
describe("真实 prompt 事件流（集成）", () => {
  it(
    "prompt 后能收到 agent_start / message_update / agent_settled 事件",
    async () => {
      // 用独立 sidecar 进程订阅事件流
      const { spawn } = await import("node:child_process");
      const proc = spawn(process.execPath, [path.join(dir, "../../drivers/sidecar/sidecar.mjs")], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let buf = "";
      let seq = 0;
      const pending = new Map<string, (r: any) => void>();
      const events: any[] = [];
      proc.stdout!.on("data", (c) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let o: any;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (o?.type === "response") {
            const r = pending.get(o.requestId);
            if (r) {
              pending.delete(o.requestId);
              r(o);
            }
          } else if (o?.type === "event") {
            events.push(o.event);
          }
        }
      });
      const send = (cmd: Record<string, unknown>) =>
        new Promise<any>((resolve) => {
          const rid = `t2-${++seq}`;
          pending.set(rid, resolve);
          proc.stdin!.write(JSON.stringify({ ...cmd, requestId: rid }) + "\n");
        });

      const init = await send({ type: "init", cwd: "L:/projects/PI-GUI", sessionMode: "memory" });
      expect(init.success).toBe(true);

      const accepted = await send({ type: "prompt", message: "只回复：事件流OK。", streamingBehavior: "steer" });
      expect(accepted.success).toBe(true);

      // 等待 agent_settled（最多 60s）
      const deadline = Date.now() + 60000;
      while (!events.some((e) => e.type === "agent_settled") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }

      const types = new Set(events.map((e) => e.type));
      expect(types.has("agent_start")).toBe(true);
      expect(types.has("message_update")).toBe(true);
      expect(types.has("agent_settled")).toBe(true);

      proc.kill();
    },
    90000,
  );
});

describe("项目与会话隔离", () => {
  it("switch_project 后 list_sessions 跟随新项目（不串项目）", async () => {
    const res = await drive.send({ type: "switch_project", cwd: "L:/projects/PI-GUI", sessionMode: "recent" });
    expect(res.success).toBe(true);
    const s1 = await drive.send({ type: "list_sessions" });
    expect(s1.success).toBe(true);

    const sw = await drive.send({ type: "switch_project", cwd: "L:/00-projects/dongdong-deepseek-gui-tauri", sessionMode: "recent" });
    expect(sw.success).toBe(true);
    const s2 = await drive.send({ type: "list_sessions" });
    expect(s2.success).toBe(true);

    // 两个项目会话内容应不同（会话文件路径前缀不同）
    const p1 = s1.data.sessions[0]?.path ?? "";
    const p2 = s2.data.sessions[0]?.path ?? "";
    expect(p1).not.toBe(p2);
    expect(p1.includes("--L--projects-PI-GUI--") || p1.includes("PI-GUI")).toBe(true);

    // 切回 PI-GUI
    await drive.send({ type: "switch_project", cwd: "L:/projects/PI-GUI", sessionMode: "recent" });
  }, 60000);
});

describe("get_session_stats 载荷估算", () => {
  it("返回 payloadBytes 数字字段", async () => {
    const res = await drive.send({ type: "get_session_stats" });
    expect(res.success).toBe(true);
    expect(typeof (res.data?.payloadBytes ?? 0)).toBe("number");
    expect(res.data.payloadBytes).toBeGreaterThanOrEqual(0);
  });
});
