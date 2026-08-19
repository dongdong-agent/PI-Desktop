/** 事件模型测试：工具时间线 + 消息流折叠 */
import { describe, it, expect } from "vitest";
import { applyEvent, newUiState } from "./eventModel";

describe("工具时间线", () => {
  it("tool_execution_start/end 构建时间线条目", () => {
    let s = newUiState();
    s = applyEvent(s, { type: "message_start", message: { id: "m1", role: "assistant", content: [] } });
    s = applyEvent(s, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(s.tools.length).toBe(1);
    expect(s.tools[0].toolName).toBe("bash");
    expect(s.tools[0].status).toBe("running");

    s = applyEvent(s, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "total 48" }] },
      isError: false,
    });
    expect(s.tools[0].status).toBe("done");
    expect(s.tools[0].resultText).toBe("total 48");
  });

  it("工具错误状态标记", () => {
    let s = newUiState();
    s = applyEvent(s, { type: "message_start", message: { id: "m1", role: "assistant", content: [] } });
    s = applyEvent(s, { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: {} });
    s = applyEvent(s, { type: "tool_execution_end", toolCallId: "c2", toolName: "edit", result: { content: [{ type: "text", text: "err" }] }, isError: true });
    expect(s.tools[0].status).toBe("error");
  });

  it("消息流折叠：thinking 与 text 分离", () => {
    let s = newUiState();
    s = applyEvent(s, { type: "message_start", message: { id: "m2", role: "assistant", content: [] } });
    s = applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "我" } });
    s = applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "在想" } });
    s = applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } });
    const msg = s.messages[s.messages.length - 1];
    expect(msg.blocks[0].kind).toBe("thinking");
    expect((msg.blocks[0] as any).text).toBe("我在想");
    expect(msg.blocks[1].kind).toBe("text");
  });
});
