/**
 * 轻量 Markdown → HTML（导出对话记录用）。
 * 覆盖：代码块（含语言）、标题、粗体/斜体、行内代码、列表、引用、链接、分隔线、段落。
 * 不做完整 GFM 解析（对话记录阅读够用）。
 */
export function md2html(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<strong>${t}</strong>`)
      .replace(/\*([^*]+)\*/g, (_m, t) => `<em>${t}</em>`)
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_m, t, url) => `<a href="${url}">${t}</a>`);
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listStack: string[] = []; // "ul"/"ol"
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${inline(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    while (listStack.length) {
      out.push(listStack.pop() === "ul" ? "</ul>" : "</ol>");
    }
  };
  const flushCode = () => {
    if (inCode) {
      out.push(`<pre><code class="lang-${esc(codeLang || "text")}">${esc(codeBuf.join("\n"))}</code></pre>`);
      inCode = false;
      codeBuf = [];
      codeLang = "";
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // 代码块开关（``` 或 ```lang）
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flushPara();
      if (inCode) flushCode();
      else {
        inCode = true;
        codeLang = fence[1]?.trim() ?? "";
        closeList();
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }
    // 分隔线
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push("<hr />");
      continue;
    }
    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    // 无序列表
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (listStack[listStack.length - 1] !== "ul") {
        closeList();
        out.push("<ul>");
        listStack.push("ul");
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    // 有序列表
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (listStack[listStack.length - 1] !== "ol") {
        closeList();
        out.push("<ol>");
        listStack.push("ol");
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    // 空行 → 段落/列表分隔
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    paraBuf.push(line);
  }
  flushPara();
  flushCode();
  closeList();
  return out.join("\n");
}

/** 生成自包含 HTML 对话记录页（内嵌样式，可直接分享/归档） */
export function sessionHtml(md: string, title = "PI Agent 对话记录"): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}</title>
<style>
:root { --bg:#fafafa; --card:#fff; --ink:#1f2328; --dim:#6b7080; --accent:#0969da; --code-bg:#f2f4f7; --bdr:#e4e7ec; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0e1116; --card:#161b22; --ink:#e6edf3; --dim:#8b949e; --accent:#58a6ff; --code-bg:#1c2128; --bdr:#2a3038; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
.wrap { max-width:860px; margin:0 auto; padding:32px 20px 64px; }
h1 { font-size:24px; margin:0 0 8px; }
.sub { color:var(--dim); font-size:13px; margin-bottom:24px; }
hr { border:none; border-top:1px solid var(--bdr); margin:24px 0; }
h2 { font-size:17px; margin:28px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--bdr); }
h3 { font-size:15px; margin:20px 0 6px; }
h4 { font-size:14px; margin:16px 0 6px; }
p { margin:10px 0; }
code { font:13px/1.5 Consolas,"Courier New",monospace; background:var(--code-bg); padding:1px 5px; border-radius:4px; }
pre { background:var(--code-bg); padding:12px 14px; border-radius:8px; overflow:auto; }
pre code { background:none; padding:0; display:block; }
ul, ol { margin:8px 0; padding-left:24px; }
li { margin:3px 0; }
blockquote { margin:10px 0; padding:2px 16px; border-left:4px solid var(--accent); color:var(--dim); }
a { color:var(--accent); }
hr + hr { display:none; }
</style>
</head>
<body>
<div class="wrap">
${md2html(md)}
</div>
</body>
</html>
`;
}

/** 导出为纯文本（对话记录，无 markdown 符号——简单剥离） */
export function sessionPlain(md: string): string {
  return md
    .replace(/```jsonl?/g, "")
    .replace(/```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^>\s?/gm, "")
    .trim();
}