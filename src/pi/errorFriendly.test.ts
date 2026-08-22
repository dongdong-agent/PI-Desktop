import { describe, it, expect } from "vitest";
import { friendlyError, isRetryableError } from "./errorFriendly";

describe("friendlyError", () => {
  it("413 too large → 中文提示 + 引导压缩", () => {
    const r = friendlyError('Error: 413: {"message":"Upstream request failed: [413] Payload Too Large"}');
    expect(r).toContain("413");
    expect(r).toContain("压缩上下文");
  });
  it("529 overloaded → 提示限流", () => {
    const r = friendlyError('529 {"type":"overloaded_error"}');
    expect(r).toContain("过载");
  });
  it("401 → 提示检查 key", () => {
    const r = friendlyError("401 unauthorized");
    expect(r).toContain("API Key");
  });
  it("普通错误原样/剥离JSON", () => {
    const r = friendlyError('{"message":"hello err"}');
    expect(r).toContain("hello err");
    expect(friendlyError("普通错误")).toBe("普通错误");
  });
});

describe("errorFriendly 扩展规则", () => {
  it("限流 429 提示重试", () => {
    expect(friendlyError("429 Too Many Requests")).toContain("429");
    expect(isRetryableError("429 Too Many Requests")).toBe(true);
  });
  it("529 过载可重试", () => {
    expect(friendlyError("529 overloaded")).toContain("过载");
    expect(isRetryableError("529 overloaded")).toBe(true);
  });
  it("上下文超长提示压缩", () => {
    expect(friendlyError("context length exceeded")).toContain("压缩");
    expect(isRetryableError("context length exceeded")).toBe(false);
  });
  it("内容审核提示调整措辞", () => {
    expect(friendlyError("content policy violation")).toContain("审核");
  });
  it("网络错误可重试", () => {
    expect(isRetryableError("fetch failed")).toBe(true);
    expect(isRetryableError("ECONNRESET")).toBe(true);
  });
  it("认证错误不可重试", () => {
    expect(isRetryableError("401 unauthorized")).toBe(false);
  });
});
