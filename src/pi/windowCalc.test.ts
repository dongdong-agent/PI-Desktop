import { describe, it, expect } from "vitest";

// 复刻 MessageWindow 的窗口计算（纯函数），验证折叠/渐进展开逻辑
function windowOf(total: number, initRender: number, expandCount: number) {
  if (total <= initRender) return { start: 0, shown: total, hidden: 0 };
  const start = Math.max(0, total - initRender * (1 + expandCount));
  return { start, shown: total - start, hidden: start };
}

describe("长会话窗口化计算", () => {
  it("短会话（<200）全量渲染", () => {
    expect(windowOf(50, 200, 0)).toEqual({ start: 0, shown: 50, hidden: 0 });
    expect(windowOf(200, 200, 0)).toEqual({ start: 0, shown: 200, hidden: 0 });
  });
  it("1254 条：默认只渲染最近 200", () => {
    expect(windowOf(1254, 200, 0)).toEqual({ start: 1054, shown: 200, hidden: 1054 });
  });
  it("渐进展开：每 +1 次 expand 多显示 200 条", () => {
    const w1 = windowOf(1254, 200, 1);
    expect(w1.hidden).toBe(854); // 1054-200
    const w4 = windowOf(1254, 200, 5);
    expect(w4.hidden).toBe(54); // 1054-1000
    const w6 = windowOf(1254, 200, 6);
    expect(w6.start).toBe(0); // 已全量展开
    expect(w6.hidden).toBe(0);
  });
  it("展开数量不会越界为负", () => {
    const w = windowOf(300, 200, 10);
    expect(w.start).toBe(0);
    expect(w.shown).toBe(300);
  });
});
