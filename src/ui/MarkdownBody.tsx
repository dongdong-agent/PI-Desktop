/**
 * Markdown 渲染器（共享）：完整预览（标题/粗体/列表/表格/引用/链接/代码块）。
 * 安全：react-markdown 默认不渲染原始 HTML。
 */
import { useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 代码块（深色 + 语言标签 + 复制按钮） */
export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        <span>{lang}</span>
        <button className="codeblock__copy" onClick={copy}>
          {copied ? "已复制 ✓" : "复制"}
        </button>
      </div>
      <pre className="codeblock__pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className ?? "");
            const isInline = !match && !String(children).includes("\n");
            if (isInline) {
              return <code className="md-inline-code">{children}</code>;
            }
            return (
              <CodeBlock lang={match?.[1] ?? "text"} code={String(children).replace(/\n$/, "")} />
            );
          },
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <img
              src={src}
              alt={alt ?? ""}
              className="md-img"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}