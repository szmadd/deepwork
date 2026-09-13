import { useMemo, useState } from 'react';
import type { GuardPolicy, WorkspaceTree } from '@deepwork/protocol';
import { formatBytes } from '../api';

interface FileTreePanelProps {
  tree: WorkspaceTree | null;
  loading: boolean;
  /** 当前会话改动过的相对路径，用于高亮 */
  changedPaths: Set<string>;
  onRefresh: () => void;
  onOpen: (path: string) => void;
}

/**
 * 工作区文件树。
 *
 * 存在的理由很直接：Agent 改的是**用户的目录**，而此前界面上唯一能看见这个目录的地方
 * 是顶部那行路径。用户要判断「这次改动有没有越界」，至少得能看见边界里有什么。
 *
 * 两条实现纪律：
 *  1. **高亮来自会话日志，不来自额外查询。** 被改动的文件从工具调用的差异里直接推出来，
 *     与用户当初审批时看到的内容同源，因此不会出现「树上有标记、审批记录里没有」的矛盾。
 *  2. **忽略与截断要写在界面上。** node_modules 被跳过、条目数被截断，这些必须说出来 ——
 *     沉默地展示一棵残缺的树，等于给用户一个假的完整性。
 */
export function FileTreePanel({ tree, loading, changedPaths, onRefresh, onOpen }: FileTreePanelProps) {
  /** 只显示被改动过的文件 */
  const [onlyChanged, setOnlyChanged] = useState(false);

  const visible = useMemo(() => {
    if (!tree) return [];
    if (!onlyChanged) return tree.nodes;
    return filterChanged(tree.nodes, changedPaths);
  }, [tree, onlyChanged, changedPaths]);

  const changedCount = changedPaths.size;

  return (
    <div className="panel-body">
      <div className="panel-toolbar">
        <button
          type="button"
          className={`chip-toggle${onlyChanged ? ' chip-toggle-on' : ''}`}
          onClick={() => setOnlyChanged((value) => !value)}
          title="只显示本次会话中被改动过的文件"
        >
          仅看改动 {changedCount > 0 ? `(${changedCount})` : ''}
        </button>
        <span className="panel-spacer" />
        <button type="button" className="btn btn-tiny" onClick={onRefresh} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {!tree ? (
        <div className="empty-hint">正在读取工作区…</div>
      ) : visible.length === 0 ? (
        <div className="empty-hint">{onlyChanged ? '本次会话还没有改动过文件' : '（空目录）'}</div>
      ) : (
        <div className="tree-body">
          <ul className="tree-list">
            {visible.map((node) => (
              <TreeRow key={node.path} node={node} depth={0} changedPaths={changedPaths} onOpen={onOpen} />
            ))}
          </ul>

          {tree.truncated ? (
            <div className="panel-note panel-note-warn">
              条目数已达上限，这棵树不完整（已显示 {tree.count} 项）
            </div>
          ) : null}
          {tree.ignored.length > 0 ? (
            <div className="panel-note">已跳过：{tree.ignored.join('、')}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface TreeRowProps {
  node: WorkspaceTree['nodes'][number];
  depth: number;
  changedPaths: Set<string>;
  onOpen: (path: string) => void;
}

function TreeRow({ node, depth, changedPaths, onOpen }: TreeRowProps) {
  // 目录默认展开：这是「看一眼边界里有什么」的视图，默认收起会让它需要额外一次点击才有用
  const [open, setOpen] = useState(depth < 2);
  const changed = node.type === 'file' && changedPaths.has(node.path);
  const indent = { paddingLeft: `${8 + depth * 14}px` };

  if (node.type === 'dir') {
    return (
      <li>
        <button type="button" className="tree-row tree-dir" style={indent} onClick={() => setOpen((v) => !v)}>
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          <span className="tree-name">{node.name}/</span>
          {node.deep ? <span className="tree-flag" title="超出展开深度">…</span> : null}
        </button>
        {open && node.children ? (
          <ul className="tree-list">
            {node.children.map((child) => (
              <TreeRow key={child.path} node={child} depth={depth + 1} changedPaths={changedPaths} onOpen={onOpen} />
            ))}
            {node.children.length === 0 && !node.deep ? (
              <li className="tree-row tree-empty" style={{ paddingLeft: `${22 + depth * 14}px` }}>
                （空）
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={`tree-row tree-file${changed ? ' tree-changed' : ''}`}
        style={indent}
        title={changed ? `${node.path}（本次会话已改动）` : node.path}
        onClick={() => onOpen(node.path)}
      >
        <span className="tree-dot" />
        <span className="tree-name">{node.name}</span>
        <span className="tree-size">{formatBytes(node.size ?? 0)}</span>
      </button>
    </li>
  );
}

/** 保留被改动的文件，以及通往它们的目录 */
function filterChanged(
  nodes: WorkspaceTree['nodes'],
  changedPaths: Set<string>,
): WorkspaceTree['nodes'] {
  const out: WorkspaceTree['nodes'] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      if (changedPaths.has(node.path)) out.push(node);
      continue;
    }
    const children = filterChanged(node.children ?? [], changedPaths);
    if (children.length > 0) out.push({ ...node, children });
  }
  return out;
}
