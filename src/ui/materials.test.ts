import { describe, it, expect } from "vitest";

// 素材库纯逻辑：增删收藏（复刻 Sidebar 实现）
type Mat = { id: string; text: string; at: number };
function addMaterial(mat: Mat[], text: string): Mat[] {
  const t = text.trim();
  if (!t) return mat;
  return [{ id: `m-${Date.now()}`, text: t, at: Date.now() }, ...mat];
}
function removeMaterial(mat: Mat[], id: string): Mat[] {
  return mat.filter((m) => m.id !== id);
}

describe("素材库逻辑", () => {
  it("收藏：非空文本加入头部", () => {
    let list: Mat[] = [];
    list = addMaterial(list, "总结这段代码");
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe("总结这段代码");
  });
  it("空白文本不收藏", () => {
    const before = [{ id: "x", text: "a", at: 1 }];
    expect(addMaterial(before, "   ")).toHaveLength(1);
    expect(addMaterial(before, "")).toHaveLength(1);
  });
  it("删除：按 id 移除", () => {
    const list = [
      { id: "a", text: "x", at: 1 },
      { id: "b", text: "y", at: 2 },
    ];
    expect(removeMaterial(list, "a")).toHaveLength(1);
    expect(removeMaterial(list, "a")[0].id).toBe("b");
  });
});
