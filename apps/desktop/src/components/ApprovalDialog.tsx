import { useMemo, useState } from 'react';
import type { ApprovalDecision, ApprovalRequest, FileDiff } from '@deepwork/protocol';
import { DiffView } from './DiffView';

interface ApprovalDialogProps {
  request: ApprovalRequest;
  onDecide: (decision: ApprovalDecision, persist: boolean, hunks?: number[]) => void;
}

/**
 * 审批弹窗 —— 安全链路上唯一的人工闸门。
 *
 * 设计要点：
 *  - 主体内容（命令行 / 路径）必须完整展示，不允许截断或折叠；
 *  - **写文件的批准语义是「我读过这份差异了」**，所以差异必须在这里展示，
 *    而不是让用户回到对话流里翻工具卡片再回来点允许；
 *  - 「始终允许」默认不勾选，且只对命令前缀 / 文件路径生效，不做通配放宽；
 *  - 高危等级用醒目文案，诱导性措辞一律不用。
 *
 * ── 逐 hunk 授权 ──
 * 当内核标记这次授权可选块时（差异可拆成多个 hunk、且不是新建文件），
 * 每个块前面会出现勾选框，默认全选。
 *
 * 一条刻意的约定：**全部勾选时不发送 hunks**。
 * 因为「我全部同意」与「我逐块看过并全部同意」在日志里应当是同一个结论 ——
 * 都记成「整体授权」。否则复盘时会出现大量冗余的 hunk 列表，
 * 真正的部分授权反而淹没在里面。
 */
export function ApprovalDialog({ request, onDecide }: ApprovalDialogProps) {
  const [always, setAlways] = useState(false);
  const diff = request.diff;
  const selectable = Boolean(diff && request.selectable && diff.hunks.length > 1);

  const [selected, setSelected] = useState<Set<number>>(() =>
    selectable ? new Set(diff!.hunks.map((_, index) => index)) : new Set(),
  );

  const toggle = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const partial = selectable && selected.size > 0 && selected.size < diff!.hunks.length;
  const nothingSelected = selectable && selected.size === 0;

  const hunks = useMemo(
    () => (partial ? [...selected].sort((a, b) => a - b) : undefined),
    [partial, selected],
  );

  return (
    <div className="modal-mask">
      <div className={`modal${diff ? ' modal-wide' : ''}`}>
        <div className="modal-head">
          <span className={`tool-risk risk-${request.risk}`}>需要授权</span>
          <span className="modal-tool">{request.tool}</span>
        </div>

        <div className="modal-body">
          <div className="modal-label">{diff ? '即将写入' : '即将执行'}</div>
          <pre className="modal-subject">{request.subject}</pre>

          {request.cwd ? (
            <>
              <div className="modal-label">{diff ? '工作区' : '工作目录'}</div>
              <pre className="modal-subject modal-subject-dim">{request.cwd}</pre>
            </>
          ) : null}

          <div className="modal-label">判定依据</div>
          <div className="modal-reason">{request.reason}</div>

          {diff ? (
            <>
              <div className="modal-label">
                改动内容{diff.hunks.length > 1 ? `（${diff.hunks.length} 处，可逐处取舍）` : ''}
              </div>
              <DiffView
                diff={diff}
                previewLimit={40}
                selection={selectable ? selected : undefined}
                onToggleHunk={selectable ? toggle : undefined}
              />
              <div className="modal-hint">{impactText(diff, partial, selected.size, diff.hunks.length)}</div>
            </>
          ) : null}

          <label className="modal-check">
            <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} />
            {diff ? '以后对同一文件不再询问' : '以后同类命令不再询问（按命令前缀记忆）'}
          </label>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => onDecide('deny', false)}>
            拒绝
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={nothingSelected}
            onClick={() => onDecide(always ? 'allow_always' : 'allow', always, hunks)}
          >
            {partial ? `只应用选中的 ${selected.size} 处` : diff ? '允许并写入' : '允许并继续'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 用一句话说清「这次授权到底会发生什么」，避免用户对差异的适用范围产生误解 */
function impactText(
  diff: FileDiff,
  partial: boolean,
  selected: number,
  total: number,
): string {
  if (partial) {
    return `只应用选中的 ${selected}/${total} 处改动；其余 ${total - selected} 处保持文件原样，不会被写入。`;
  }
  if (diff.created) return '这是一个新文件，授权后将写入以上全部内容。';
  if (diff.deleted) return '授权后该文件内容将被清空。';
  return '授权后仅应用以上差异，未出现在差异中的行保持不变。';
}
