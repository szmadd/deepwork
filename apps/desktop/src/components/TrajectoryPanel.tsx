import { useEffect, useRef, useState } from 'react';
import { parseSandboxDenial } from '@deepwork/protocol';
import type { AgentEvent, BranchCompareResult, BranchFileEntry } from '@deepwork/protocol';
import { DiffView } from './DiffView';

interface TrajectoryPanelProps {
  events: AgentEvent[];
  /** 当前会话 id（对比的右侧） */
  sessionId?: string;
  /** 来源会话 id（对比的左侧）；不是分叉会话时为空，此时不显示对比入口 */
  parentSessionId?: string;
  /** 拉取对比结果；未提供时不显示对比入口 */
  onCompare?: (leftId: string, rightId: string) => Promise<BranchCompareResult>;
  /**
   * 从某条事件处分叉（逐事件分叉）。
   *
   * 这是 Trajectory 视图独有的入口：对话视图只能给「某一轮之后」，
   * 而排查问题时真正想知道的是「这一条之前的那段历史」。
   * 未提供时不显示按钮。
   */
  onFork?: (atSeq: number) => void;
  onClose: () => void;
}

/**
 * Trajectory 视图 —— 会话日志的原始视图。
 *
 * 这是「过程可回放」这一卖点的最小实现：只读、按 seq 排列、不做任何美化。
 * 它的价值在于排查问题时能看到协议层真实发生了什么，而不是被 UI 的聚合掩盖。
 *
 * 两个操作都长在这里：**逐事件分叉**（每条事件一行，位置天然精确）与
 * **分支对比**（对比的是两条分支的改动，与事件列表是同一份数据的两种看法）。
 */
export function TrajectoryPanel({
  events,
  sessionId,
  parentSessionId,
  onCompare,
  onFork,
  onClose,
}: TrajectoryPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [compare, setCompare] = useState<BranchCompareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  // 切换会话后旧会话的对比结果必须失效：留着会让标题是 A、内容是 B 的对比
  // 继续显示，而它看起来完全正常
  useEffect(() => {
    setCompare(null);
    setError(null);
  }, [sessionId]);

  const canCompare = Boolean(onCompare && sessionId && parentSessionId);

  const runCompare = async () => {
    if (!onCompare || !sessionId || !parentSessionId) return;
    setBusy(true);
    setError(null);
    try {
      // 左 = 来源分支，右 = 当前分支：与「从左边分叉出右边」的方向一致，
      // 反过来的话并排的两列谁是谁全凭记忆
      setCompare(await onCompare(parentSessionId, sessionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="trajectory">
      <div className="trajectory-head">
        {compare ? (
          <button type="button" className="btn btn-tiny" onClick={() => setCompare(null)}>
            ← 事件列表
          </button>
        ) : null}
        <span>{compare ? '分支对比' : 'Trajectory'}</span>
        <span className="trajectory-count">
          {compare
            ? `${compare.shared.length + compare.leftOnly.length + compare.rightOnly.length} 个文件`
            : `${events.length} 事件`}
        </span>
        {!compare && canCompare ? (
          <button
            type="button"
            className="btn btn-tiny"
            disabled={busy}
            title="与来源分支并排看两边对同一个文件各改了什么"
            onClick={() => void runCompare()}
          >
            {busy ? '对比中…' : '与来源分支对比'}
          </button>
        ) : null}
        <button type="button" className="icon-btn" onClick={onClose} title="关闭">
          ×
        </button>
      </div>

      {error ? <div className="modal-hint modal-hint-warn">{error}</div> : null}

      <div className="trajectory-body">
        {compare ? (
          <CompareBody result={compare} />
        ) : (
          <>
            {events.map((event) => (
              <div className={`traj-row traj-${event.type.replace('.', '-')}`} key={event.seq}>
                <span className="traj-seq">#{event.seq}</span>
                <span className="traj-type">{event.type}</span>
                <span className="traj-time">
                  {new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                {onFork ? (
                  <button
                    type="button"
                    className="traj-fork"
                    title={`从 #${event.seq}（${event.type}）处分叉：新会话继承到此为止的历史`}
                    onClick={() => onFork(event.seq)}
                  >
                    从此处分叉
                  </button>
                ) : null}
                <pre className="traj-payload">{summarize(event)}</pre>
              </div>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * 对比结果的渲染。
 *
 * 「两边都改过」的文件并排 —— 那是这个视图存在的理由（同名文件差异并排）。
 * 只有一边改过的**照样列出来**、只是单列：它们同样回答了「这条分支动了什么」，
 * 而省略会让「只改了一边」被读成「没改」。
 *
 * 依据（basis）常驻在最上面：这份对比取的是改动记录、每个文件以最后一次为准，
 * 不写出来用户会以为它在比磁盘上的两份文件。
 */
function CompareBody({ result }: { result: BranchCompareResult }) {
  return (
    <div className="branch-compare">
      <div className="branch-basis">{result.basis}</div>

      {result.shared.length === 0 && result.leftOnly.length === 0 && result.rightOnly.length === 0 ? (
        <div className="branch-empty">
          两条分支都没有留下带差异的写操作 —— 没有可比的内容。
        </div>
      ) : null}

      {result.shared.length > 0 ? (
        <div className="branch-group-title">两边都改过（{result.shared.length}）</div>
      ) : null}
      {result.shared.map((entry) => (
        <div className="branch-file" key={entry.path}>
          <div className="branch-file-head">
            <span className="branch-file-path">{entry.path}</span>
            <span className="branch-file-badge">两边都改过</span>
          </div>
          <div className="branch-cols">
            <BranchColumn title={result.left.title} entry={entry} side="left" />
            <BranchColumn title={result.right.title} entry={entry} side="right" />
          </div>
        </div>
      ))}

      <SingleList
        title="只有来源分支改过"
        entries={result.leftOnly}
        side="left"
        branchTitle={result.left.title}
      />
      <SingleList
        title="只有当前分支改过"
        entries={result.rightOnly}
        side="right"
        branchTitle={result.right.title}
      />
    </div>
  );
}

function BranchColumn({
  title,
  entry,
  side,
}: {
  title: string;
  entry: BranchFileEntry;
  side: 'left' | 'right';
}) {
  const diff = side === 'left' ? entry.left : entry.right;
  return (
    <div className="branch-col">
      <div className="branch-col-head">{title}</div>
      {diff ? <DiffView diff={diff} previewLimit={14} /> : <div className="diff-empty">未改动</div>}
    </div>
  );
}

function SingleList({
  title,
  entries,
  side,
  branchTitle,
}: {
  title: string;
  entries: BranchFileEntry[];
  side: 'left' | 'right';
  branchTitle: string;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      <div className="branch-group-title">
        {title}（{entries.length}）
      </div>
      {entries.map((entry) => {
        const diff = side === 'left' ? entry.left : entry.right;
        return (
          <div className="branch-file" key={entry.path}>
            <div className="branch-file-head">
              <span className="branch-file-path">{entry.path}</span>
              <span className="branch-file-badge">{branchTitle}</span>
            </div>
            {diff ? <DiffView diff={diff} previewLimit={14} /> : null}
          </div>
        );
      })}
    </>
  );
}

function summarize(event: AgentEvent): string {
  switch (event.type) {
    case 'message.delta':
    case 'reasoning.delta':
    case 'user.message':
      return JSON.stringify(event.text);
    case 'message.completed':
      return `${event.text.length} 字符`;
    case 'tool.started':
      return `${event.call.name} ${event.call.summary}`;
    case 'tool.completed': {
      // 这一栏刻意不做美化（见文件头），但 `fail` 与 `fail` 不是同一件事：
      // 「被内核沙箱拦下」是既定边界在生效，「工具报错」才是异常。
      // 不区分的话，排查时最该先看的那一类失败会淹没在噪声里。
      const denial = event.ok ? null : parseSandboxDenial(event.output);
      return `${event.ok ? 'ok' : 'fail'} ${event.durationMs}ms${denial ? ` · 沙箱拦下(${denial.mode})` : ''}`;
    }
    case 'approval.requested':
      return `${event.request.tool}: ${event.request.subject}`;
    case 'approval.resolved':
      return `${event.requestId} → ${event.decision}`;
    case 'run.notice':
      return `${event.level}: ${event.message}`;
    case 'run.completed':
      return `${event.status} ${event.durationMs}ms`;
    case 'run.failed':
      return event.message;
    case 'usage':
      return `prompt=${event.usage.promptTokens} completion=${event.usage.completionTokens}`;
    case 'session.created':
    case 'session.updated':
      return `${event.session.title} (${event.session.status})`;
    case 'host.ready':
      return `${event.adapter} ${event.adapterVersion}`;
    default:
      return '';
  }
}
