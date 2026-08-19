/**
 * OpenAI 兼容 Provider：对接任意 OpenAI Chat Completions 协议的端点。
 * 火山方舟（ark.cn-beijing.volces.com）等网关均兼容该协议，填入 BaseURL 即可接入。
 */
import type { ChatMessage, ChatRequest, Provider, StreamChunk } from "../core/types";

interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function toChatRole(role: ChatMessage["role"]): "system" | "user" | "assistant" {
  if (role === "system") return "system";
  if (role === "assistant") return "assistant";
  return "user";
}

/** 解析 SSE 流：读取 data 行并回调 */
async function* parseSSE(
  response: Response,
): AsyncGenerator<{ data: string; raw: string }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("响应不含可读的 body");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          yield { data: line.slice(5).trim(), raw: line };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function makeOpenAIProvider(): Provider {
  let config: OpenAIConfig = { baseUrl: "", apiKey: "", model: "" };

  return {
    id: "openai-compat",
    name: "OpenAI 兼容（远程）",
    kind: "remote",
    configurable: true,
    defaultConfig: {
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "",
      model: "",
    },

    configure(configMap: Record<string, string>): void {
      config = {
        baseUrl: (configMap.baseUrl ?? "").replace(/\/+$/, ""),
        apiKey: configMap.apiKey ?? "",
        model: configMap.model ?? "",
      };
    },

    async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
      if (!config.baseUrl || !config.model) {
        yield {
          type: "error",
          error: "请先在顶栏设置面板中填写 BaseURL 和模型名（API Key 视网关而定）。",
        };
        return;
      }

      const messages = [
        ...(req.systemPrompt
          ? [{ role: "system" as const, content: req.systemPrompt }]
          : []),
        ...req.messages
          .filter((m) => !m.pending && m.role !== "system")
          .map((m) => ({ role: toChatRole(m.role), content: m.content })),
      ];

      const url = `${config.baseUrl}/chat/completions`;
      const body = {
        model: config.model,
        messages,
        stream: true,
        temperature: req.options?.temperature,
        top_p: req.options?.topP,
        max_tokens: req.options?.maxTokens,
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        yield {
          type: "error",
          error: `请求失败 (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        };
        return;
      }

      let promptTokens: number | undefined;
      let completionTokens: number | undefined;

      for await (const { data } of parseSSE(response)) {
        if (data === "[DONE]") break;
        try {
          const chunk = JSON.parse(data);
          const delta: string | undefined = chunk?.choices?.[0]?.delta?.content;
          if (delta) {
            yield { type: "delta", text: delta };
          }
          if (chunk?.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        } catch {
          // 跳过无法解析的分片
        }
      }

      yield { type: "done", usage: { promptTokens, completionTokens } };
    },
  };
}

export const openaiCompatProvider = makeOpenAIProvider();