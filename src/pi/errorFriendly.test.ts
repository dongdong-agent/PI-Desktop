import { describe, it, expect } from "vitest";
import { friendlyError } from "./errorFriendly";

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
