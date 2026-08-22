/**
 * 新功能协议集成测试（vitest 内跑真实 sidecar 进程）。
 * 覆盖：export_session（markdown/jsonl）、diagnostics、login 取消链路、list_custom_providers。
 * 注意：不写真实配置（custom provider 仅读列表；login 仅测取消），避免污染 ~/.pi。
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
  promptQueue: any[];
}

function startSidecar(): Drive {
  const proc = spawn(process.execPath, [path.join(dir, "../../drivers/sidecar/sidecar.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_SIDECAR_VERBOSE: "0" },
  });
  let buf = "";
  let seq = 0;
  const pending = new Map<string, (r: any) => void>();
  const promptQueue: any[] = [];

  proc.stdout!.on("data", (c) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let p: any;
      try {
        p = JSON.parse(line);
      } catch {
        continue;
      }
      if (p.type === "response") {
        pending.get(p.requestId)?.(p);
        pending.delete(p.requestId);
      } else if (p.type === "auth_prompt") {
        promptQueue.push(p);
      }
    }
  });

  const send = (cmd: Record<string, unknown>) =>
    new Promise((resolve) => {
      const requestId = `t${++seq}`;
      proc.stdin!.write(JSON.stringify({ ...cmd, requestId }) + "\n");
      pending.set(requestId, resolve);
    });
  const close = () =>
    new Promise<void>((resolve) => {
      proc.stdin!.write(JSON.stringify({ type: "exit", requestId: "exit" }) + "\n");
      proc.on("exit", () => resolve());
      setTimeout(resolve, 1000);
    });
  return { proc, send, close, promptQueue };
}

export const _internal = { startSidecar, promptQueue: (d: Drive) => (d as any).promptQueue ?? [] };

describe("新功能协议（sidecar）", () => {
  let drive: Drive;
  let dialogueId: string;

  beforeAll(async () => {
    drive = startSidecar();
    const open = await drive.send({ type: "open_dialogue", cwd: "L:/projects/PI-GUI", sessionMode: "new" });
    dialogueId = open.data?.dialogueId ?? "";
    expect(open.success).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await drive.close();
  }, 10_000);

  it("export_session markdown 含会话头", async () => {
    const md = await drive.send({ type: "export_session", dialogueId, format: "markdown" });
    expect(md.success).toBe(true);
    expect(typeof md.data?.content).toBe("string");
    expect(md.data.content).toContain("# PI Agent 对话记录");
    expect(md.data.ext).toBe("md");
  });

  it("export_session jsonl 返回可解析行", async () => {
    const jl = await drive.send({ type: "export_session", dialogueId, format: "jsonl" });
    expect(jl.success).toBe(true);
    const lines = jl.data.content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
    expect(jl.data.ext).toBe("jsonl");
  });

  it("diagnostics 返回完整诊断字段", async () => {
    const d = await drive.send({ type: "diagnostics" });
    expect(d.success).toBe(true);
    expect(typeof d.data.coreVersion).toBe("string");
    expect(typeof d.data.agentDir).toBe("string");
    expect(typeof d.data.nodeVersion).toBe("string");
    expect(d.data.initialized).toBe(true);
    expect(d.data.dialogueCount).toBeGreaterThanOrEqual(1);
    expect(d.data.files).toHaveProperty("auth");
  });

  it("login api_key 挂起后用 auth_input 取消（不写配置）", async () => {
    const loginP = drive.send({ type: "login", providerId: "deepseek", method: "api_key" });
    // 等待 auth_prompt 出现
    const deadline = Date.now() + 5000;
    let promptId: string | null = null;
    const q = _internal.promptQueue(drive);
    while (Date.now() < deadline && !promptId) {
      const item = q.shift();
      if (item) promptId = item.promptId;
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(promptId).toBeTruthy();
    await drive.send({ type: "auth_input", promptId, cancel: true });
    const res = await loginP;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/取消/);
  }, 15_000);

  it("list_custom_providers 只读返回数组", async () => {
    const r = await drive.send({ type: "list_custom_providers" });
    expect(r.success).toBe(true);
    expect(Array.isArray(r.data?.providers)).toBe(true);
  });
});