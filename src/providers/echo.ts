/**
 * EchoProvider：本地测试用 Provider。
 * 功能：把用户最后一句话回显成一段模拟回复，用微小延时模拟流式输出。
 * 目的：让整个流式链路（send → emit → store → UI 渲染）无需任何 API Key 即可跑通。
 */
import type { ChatRequest, Provider, StreamChunk } from "../core/types";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export const echoProvider: Provider = {
  id: "echo",
  name: "本地回显（测试）",
  kind: "local",
  configurable: false,

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "（空消息）";

    const reply = [
      `✅ 本地EchoProvider已收到你的消息：`,
      ``,
      `> ${text.slice(0, 200)}`,
      ``,
      `这是用于验证「中枢 → 注册表 → Provider → 流式 → 状态层 → UI」全链路的一个测试回复。`,
      `要接入真实模型，请在顶栏把 Provider 切换到「OpenAI 兼容」，并填好 BaseURL / API Key / 模型名。`,
    ].join("\n");

    for (let i = 0; i < reply.length; i += 3) {
      if (signal.aborted) return;
      await sleep(12, signal);
      yield { type: "delta", text: reply.slice(i, i + 3) };
    }
    yield { type: "done", usage: { promptTokens: text.length, completionTokens: reply.length } };
  },

  configure() {
    // 本地 provider 无需配置
  },
};