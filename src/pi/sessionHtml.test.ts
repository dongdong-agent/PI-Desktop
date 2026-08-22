import { describe, it, expect } from "vitest";
import { md2html, sessionHtml, sessionPlain } from "./sessionHtml";

describe("md2html 轻量转换", () => {
  it("标题/段落/粗体", () => {
    const html = md2html("# 标题\n\n正文 **粗体** 和 `code`");
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("代码块", () => {
    const html = md2html("```js\nconst a = 1;\n```");
    expect(html).toContain('<pre><code class="lang-js">');
    expect(html).toContain("const a = 1;");
  });

  it("列表与引用", () => {
    const html = md2html("- 甲\n- 乙\n\n> 引用");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>甲</li>");
    expect(html).toContain("<blockquote>引用</blockquote>");
  });

  it("HTML 特殊字符转义（防注入）", () => {
    const html = md2html("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sessionHtml 生成完整页面", () => {
    const page = sessionHtml("# 对话");
    expect(page).toContain("<!DOCTYPE html>");
    expect(page).toContain("<h1>对话</h1>");
    expect(page).toContain("prefers-color-scheme");
  });

  it("sessionPlain 剥离标记", () => {
    const plain = sessionPlain("# 标题\n\n**粗体**\n- 项");
    expect(plain).not.toContain("**");
    expect(plain).toContain("标题");
    expect(plain).toContain("粗体");
  });
});
