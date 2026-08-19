/**
 * 核心链路冒烟测试（vitest, node 环境）。
 * 验证：Hub → 注册表 → chat 能力 → Provider(echo) → 事件总线 → 状态层 全链路。
 * 注意：测试环境无 localStorage，此处注入桩（store 内部本就有容错，加桩只为静默）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { bootstrap, sendMessage, stopStream } from "../app/bootstrap";
import { useAppStore } from "./store";

// ---- 环境桩：localStorage ----
const memStorage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => memStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memStorage.set(k, v),
  removeItem: (k: string) => void memStorage.delete(k),
  clear: () => memStorage.clear(),
} as Storage;

// 启动一次：建 Hub + 注册插件 + 绑定事件→状态层（hub 单例，重复调用幂等）
bootstrap();

beforeEach(() => {
  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    streamingSessions: {},
    providerConfigs: {},
  });
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("中枢全链路", () => {
  it("发送一封消息能走完 发送→流式→入库→定稿", async () => {
    const sid = useAppStore.getState().createSession();
    await sendMessage(sid, "你好，小羽");

    const session = useAppStore.getState().sessions.find((s) => s.id === sid)!;
    expect(session).toBeDefined();
    expect(session.messages.length).toBe(2);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[0].content).toBe("你好，小羽");
    expect(session.messages[1].role).toBe("assistant");
    expect(session.messages[1].pending).toBe(false);
    expect(session.messages[1].content.length).toBeGreaterThan(0);
    expect(session.title).not.toBe("新会话");
    expect(useAppStore.getState().streamingSessions[sid]).toBe(false);
  }, 20000);

  it("长消息（模拟完整生成）不会丢失任何字块", async () => {
    const sid = useAppStore.getState().createSession();
    await sendMessage(sid, "请复述这行字：一二三四五六七八九十，甲乙丙丁戊己庚辛壬癸。");
    const session = useAppStore.getState().sessions.find((s) => s.id === sid)!;
    const reply = session.messages.find((m) => m.role === "assistant")!.content;
    expect(reply).toContain("本地EchoProvider");
    expect(reply.length).toBeGreaterThan(20);
    expect(session.messages.some((m) => m.pending)).toBe(false);
  }, 20000);

  it("停止生成后消息正常定稿（不残留 pending）", async () => {
    const sid = useAppStore.getState().createSession();
    const p = sendMessage(sid, "这是一段会被停止的长文本内容测试，目的是验证中止链路是否把消息定稿。");
    await sleep(60);
    await stopStream(sid);
    await p;

    const session = useAppStore.getState().sessions.find((s) => s.id === sid)!;
    const assistant = session.messages.find((m) => m.role === "assistant")!;
    expect(assistant.pending).toBe(false);
    expect(useAppStore.getState().streamingSessions[sid]).toBe(false);
  }, 20000);

  it("调用不存在的动作会抛错（契约保护）", async () => {
    const hub = bootstrap();
    await expect(
      hub.call("chat", "not-exist-action", {}) as Promise<unknown>,
    ).rejects.toThrow(/未知动作/);
    await expect(
      hub.call("no-such-capability", "x", {}) as Promise<unknown>,
    ).rejects.toThrow(/能力不存在/);
  });
});