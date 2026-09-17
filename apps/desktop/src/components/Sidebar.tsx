import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostState, HostStatus, Session } from '@deepwork/protocol';
import { HostChip } from './HostChip';

interface SidebarProps {
  sessions: Session[];
  currentId: string | null;
  currentWorkspace: string | null;
  status: HostStatus | null;
  hostState: { state: HostState; detail?: string };
  onSelect: (id: string) => void;
  onCreate: () => void;
  onOpenWorkspace: () => void;
  onRemove: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

/**
 * 只取末级目录名，完整路径放 title 里 —— 标题那一行宽度有限，完整路径会把别的挤掉。
 * 侧栏与输入区工具行（App）都用它：同一个「显示哪一段路径」的判据只写一份。
 */
export function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? target;
}

export function Sidebar({
  sessions,
  currentId,
  currentWorkspace,
  status,
  hostState,
  onSelect,
  onCreate,
  onOpenWorkspace,
  onRemove,
  onRename,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) editRef.current?.select();
  }, [editingId]);

  /**
   * 搜索在本地做，不新增一条 RPC。
   *
   * 会话列表本来就整份在内存里（几十到几百条的量级），多开一条查询路径只会带来
   * 「搜索结果与列表不同步」这类问题。匹配范围刻意包含工作区路径 ——
   * 找会话时人往往记得的是「那个在 xxx 项目里的会话」，而不是标题。
   */
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return sessions;
    return sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(keyword) ||
        session.workspace.toLowerCase().includes(keyword) ||
        session.model.toLowerCase().includes(keyword),
    );
  }, [sessions, query]);

  const commitRename = (id: string) => {
    const next = draft.trim();
    setEditingId(null);
    const current = sessions.find((item) => item.id === id);
    if (!next || next === current?.title) return;
    onRename(id, next);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <div className="brand-name">深边AI Work</div>
            <div className="brand-sub">DeepSeek Harness + Electron</div>
          </div>
        </div>

        <HostChip state={hostState.state} adapter={status?.adapter} detail={hostState.detail} />

        <button type="button" className="btn btn-primary btn-block" onClick={onCreate}>
          新建会话
        </button>
        {/*
          工作区在会话创建时绑定，之后不可更改。
          所以这里是「在新目录里开一个会话」，不是「切换当前会话的目录」——
          按钮措辞必须如实反映这一点，否则用户会以为改了当前会话。
        */}
        <button
          type="button"
          className="btn btn-block btn-subtle"
          onClick={onOpenWorkspace}
          title="选择目录并在其中新建会话"
        >
          打开文件夹…
        </button>

        <input
          className="sidebar-search"
          value={query}
          placeholder="搜索会话（标题 / 目录 / 模型）"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="empty-hint">还没有会话</div>
        ) : filtered.length === 0 ? (
          <div className="empty-hint">没有匹配「{query}」的会话</div>
        ) : (
          filtered.map((session) => (
            <div
              key={session.id}
              className={`session-item${session.id === currentId ? ' active' : ''}`}
              onClick={() => onSelect(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSelect(session.id);
              }}
            >
              <div className="session-main">
                <div className="session-title">
                  {editingId === session.id ? (
                    <input
                      ref={editRef}
                      className="session-rename"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={() => commitRename(session.id)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') commitRename(session.id);
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                    />
                  ) : (
                    <span
                      className="session-title-text"
                      title="双击重命名"
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        setEditingId(session.id);
                        setDraft(session.title);
                      }}
                    >
                      {session.title}
                    </span>
                  )}
                  {/*
                    分支来源要一直可见。分叉出的会话与父会话在内容上高度相似，
                    界面上不标明来源，用户很快就会分不清哪条是主线、哪条是试验分支。
                  */}
                  {session.fork ? (
                    <span
                      className="session-fork"
                      title={`分叉自 ${session.fork.sessionId}（第 ${session.fork.atSeq} 条事件之后）`}
                    >
                      分支
                    </span>
                  ) : null}
                </div>
                <div className="session-meta">
                  <span className={`status-dot status-${session.status}`} />
                  {session.mode} · {session.model}
                </div>
                <div className="session-workspace" title={session.workspace}>
                  {baseName(session.workspace)}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                title="重命名"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditingId(session.id);
                  setDraft(session.title);
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="icon-btn"
                title="删除会话"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(session.id);
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-foot">
        {status ? (
          <>
            <div className="foot-row">
              <span>内核</span>
              <code>
                {status.adapter} · {status.version}
              </code>
            </div>
            <div className="foot-row">
              <span>当前工作区</span>
              <code title={currentWorkspace ?? ''}>{currentWorkspace ? baseName(currentWorkspace) : '未选择'}</code>
            </div>
            <div className="foot-row">
              <span>默认目录</span>
              <code title={status.workspace}>{baseName(status.workspace)}</code>
            </div>
            <div className="foot-row">
              <span>Node</span>
              <code>{status.nodeVersion}</code>
            </div>
            <div className="foot-row">
              <span>数据</span>
              <code title={status.home}>{status.home}</code>
            </div>
          </>
        ) : (
          <div className="empty-hint">等待内核就绪…</div>
        )}
      </div>
    </aside>
  );
}
