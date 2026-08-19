import { describe, it, expect } from "vitest";

// 恢复上次会话逻辑（复刻 Sidebar restore 的 localStorage 判断）
function shouldRestoreProject(lastCwd: string | null, current: string | null): boolean {
  return !!lastCwd && lastCwd !== current;
}
function shouldRestoreSession(lastSession: string | null, _projectSwitched: boolean): boolean {
  return !!lastSession;
}

describe("重启恢复上次会话/项目", () => {
  it("有 last-cwd 且不同于当前 → 需恢复项目", () => {
    expect(shouldRestoreProject("L:/a", "L:/b")).toBe(true);
  });
  it("last-cwd 等于当前 → 不重复切项目", () => {
    expect(shouldRestoreProject("L:/a", "L:/a")).toBe(false);
    expect(shouldRestoreProject(null, "L:/a")).toBe(false);
  });
  it("切项目成功后可恢复会话", () => {
    expect(shouldRestoreSession("L:/s", true)).toBe(true);
    expect(shouldRestoreSession(null, true)).toBe(false);
  });
});
