/**
 * 会话树面板：从任意历史消息回溯 / 分支（对应 PI 终端 /tree）。
 * - 树形渲染会话条目（message 缩进 + 分支线，内置条目如 model_change 折叠）
 * - 高亮当前 leaf
 * - 点击 message 节点 → fork（从该点开新分支）
 */
import { useCallback, useEffect, useState } from "react";
import { piSend } from "../pi/bridge";

export interface TreeNode {
  id: string | null;
  type: string | null;
  parentId: string | null;
  role: string | null;
  text: string;
  label: string | null;
  leaf?: boolean;
  children: TreeNode[];
}

export function TreePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [forkMsg, setForkMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await piSend({ type: "get_tree" });
      if (res?.success) {
        setTree(res.data?.tree ?? []);
        setLeafId(res.data?.leafId ?? null);
      } else {
        setErr(res?.error ?? "获取会话树失败");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const forkAt = useCallback(async (entryId: string) => {
    setForkMsg(null);
    try {
      const res = await piSend({ type: "fork", entryId });
      if (res?.success) {
        setForkMsg(`已从该消息创建新分支（新会话）`);
        void refresh();
        window.setTimeout(() => setForkMsg(null), 2500);
      } else {
        setErr(res?.error ?? "分支失败");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  const cloneCurrent = useCallback(async () => {
    setForkMsg(null);
    try {
      const res = await piSend({ type: "fork", position: "at" });
      if (res?.success) {
        setForkMsg("已克隆当前分支（新会话）");
        void refresh();
        window.setTimeout(() => setForkMsg(null), 2500);
      } else {
        setErr(res?.error ?? "克隆失败");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  if (!open) return null;

  return (
    <div className="treepanel-overlay" onClick={onClose}>
      <div className="treepanel" onClick={(e) => e.stopPropagation()}>
        <div className="treepanel__head">
          <span className="treepanel__title">🌳 会话树</span>
          <div className="treepanel__actions">
            {forkMsg && <span className="treepanel__ok">✓ {forkMsg}</span>}
            <button className="chip chip--sm" onClick={() => void cloneCurrent()} title="在当前分支位置复制出新的后续分支（原链不受影响）">
              ⧉ 克隆当前
            </button>
            <button className="chip chip--sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? "刷新中…" : "⟳ 刷新"}
            </button>
            <button className="chip chip--sm" onClick={onClose}>
              ✕ 关闭
            </button>
          </div>
        </div>
        <div className="treepanel__body">
          {err && <div className="msg__error">⚠️ {err}</div>}
          {!err && tree.length === 0 && !loading && <div className="treepanel__empty">暂无会话树</div>}
          <ul className="treepanel__list">
            {tree.map((node) => (
              <TreeBranch key={node.id ?? `r-${Math.random()}`} node={node} leafId={leafId} onFork={forkAt} depth={0} />
            ))}
          </ul>
        </div>
        <div className="treepanel__foot">
          <span>点击消息可「从此分支」新建会话 · 高亮 = 当前叶子</span>
        </div>
      </div>
    </div>
  );
}

function TreeBranch({
  node,
  leafId,
  onFork,
  depth,
}: {
  node: TreeNode;
  leafId: string | null;
  onFork: (id: string) => void;
  depth: number;
}) {
  // 只展示 message 类型（含对话内容）；model_change 等内置条目可视需要折叠为分组
  const isMessage = node.type === "message";
  const isLeaf = node.leaf || node.id === leafId;
  const kids = (node.children ?? []).filter((c) => c.type === "message" || (c.children?.length ?? 0) > 0);

  return (
    <li className="treepanel__item">
      {isMessage ? (
        <div
          className={`treepanel__node${isLeaf ? " treepanel__node--leaf" : ""}`}
          style={{ paddingLeft: depth * 18 }}
          title="点击从此分支新建会话"
        >
          <span className={`treepanel__role treepanel__role--${node.role ?? "sys"}`}>
            {node.role === "user" ? "U" : node.role === "assistant" ? "A" : "·"}
          </span>
          <span className="treepanel__text">{node.text || (node.role === "user" ? "（用户）" : "（回复）")}</span>
          {isLeaf && <span className="treepanel__leaf">● 当前</span>}
          <button
            className="treepanel__fork"
            onClick={() => onFork(node.id!)}
            title="在此消息处分叉（fork）为新的后续分支"
          >
            分支
          </button>
        </div>
      ) : (
        <div
          className="treepanel__group"
          style={{ paddingLeft: depth * 18 }}
          title={`${node.label || node.type || "条目"}（内部）`}
        >
          <span className="treepanel__roledic">▸ {node.label || node.type || "条目"}</span>
        </div>
      )}
      {kids.length > 0 && (
        <ul className="treepanel__list">
          {kids.map((c) => (
            <TreeBranch key={c.id ?? Math.random()} node={c} leafId={leafId} onFork={onFork} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}