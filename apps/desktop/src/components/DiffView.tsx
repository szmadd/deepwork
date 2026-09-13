import { useMemo, useState } from 'react';
import type { DiffLine, FileDiff } from '@deepwork/protocol';

/**
 * 文件差异视图。
 *
 * 这个组件的职责很窄但很关键：把「即将写入磁盘的内容」如实摊开给用户看。
 * 因此它有意不做以下事情：
 *  - 不折叠删行（哪怕是空白行的删除也要显示，否则用户无法判断是否被夹带了删除）；
 *  - 不做语法高亮之外的修饰性渲染（避免行内容被二次解释，例如把 `+` 当成列表符号）；
 *  - 不隐藏增删统计（+N −M 必须常驻，它是判断改动规模的唯一线索）。
 *
 * 默认展示上限只是「首屏长度」，超出部分一次点击即可全部展开，不是省略。
 *
 * ── 逐 hunk 选择 ──
 * 当调用方提供 selection / onToggleHunk 时，每个 hunk 头部会出现勾选框。
 * 未勾选的块会被**灰掉但照样完整显示** —— 不显示就等于用户无法判断自己拒掉的是什么。
 * 统计区同时给出两行数字：整体改了多少、以及本次实际会写入多少。
 */

interface DiffViewProps {
  diff: FileDiff;
  /** 首屏最多展示的行数，超出折叠；用户可展开全部 */
  previewLimit?: number;
  className?: string;
  /** 被勾选的 hunk 下标；提供即启用逐块选择 */
  selection?: Set<number>;
  onToggleHunk?: (index: number) => void;
}

const DEFAULT_PREVIEW_LIMIT = 24;

type Row =
  | { key: string; kind: 'hunk'; text: string; index: number }
  | { key: string; kind: 'line'; line: DiffLine; hunkIndex: number };

/** 把全部 hunk 展平成一维行序列，便于统一做「首屏截断」 */
function flatten(diff: FileDiff, withHeaders: boolean): Row[] {
  const rows: Row[] = [];
  diff.hunks.forEach((hunk, hunkIndex) => {
    if (withHeaders) {
      rows.push({
        key: `h${hunkIndex}`,
        kind: 'hunk',
        index: hunkIndex,
        text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      });
    }
    hunk.lines.forEach((line, lineIndex) => {
      rows.push({ key: `h${hunkIndex}l${lineIndex}`, kind: 'line', line, hunkIndex });
    });
  });
  return rows;
}

export function DiffView({
  diff,
  previewLimit = DEFAULT_PREVIEW_LIMIT,
  className = '',
  selection,
  onToggleHunk,
}: DiffViewProps) {
  const [expanded, setExpanded] = useState(false);
  const selectable = Boolean(selection && onToggleHunk);
  const rows = useMemo(() => flatten(diff, diff.hunks.length > 1 || selectable), [diff, selectable]);

  if (diff.binary) {
    return (
      <div className={`diff-view diff-empty ${className}`}>
        二进制文件，不做行级差异展示
      </div>
    );
  }

  if (rows.length === 0) {
    return <div className={`diff-view diff-empty ${className}`}>内容无变化</div>;
  }

  const collapsible = rows.length > previewLimit;
  const visible = expanded || !collapsible ? rows : rows.slice(0, previewLimit);
  const hiddenCount = rows.length - visible.length;

  // 采纳部分的增删统计：单独算，因为「整体改了多少」与「这次写多少」是两个问题
  const acceptedStat = selectable
    ? diff.hunks.reduce(
        (acc, hunk, index) => {
          if (!selection!.has(index)) return acc;
          return {
            added: acc.added + hunk.lines.filter((line) => line.kind === 'add').length,
            removed: acc.removed + hunk.lines.filter((line) => line.kind === 'remove').length,
          };
        },
        { added: 0, removed: 0 },
      )
    : null;

  const acceptedCount = selectable ? diff.hunks.filter((_, index) => selection!.has(index)).length : 0;

  return (
    <div className={`diff-view ${className}`}>
      <div className="diff-head">
        <span className="diff-path">{diff.path}</span>
        <span className="diff-badges">
          {diff.created ? <span className="diff-badge diff-badge-new">新建</span> : null}
          {diff.deleted ? <span className="diff-badge diff-badge-del">清空</span> : null}
          {diff.added > 0 ? <span className="diff-stat diff-stat-add">+{diff.added}</span> : null}
          {diff.removed > 0 ? <span className="diff-stat diff-stat-del">−{diff.removed}</span> : null}
          {diff.truncated ? <span className="diff-badge">已截断</span> : null}
        </span>
      </div>

      {selectable ? (
        <div className="diff-selection-bar">
          <span>
            已选 <strong>{acceptedCount}</strong> / {diff.hunks.length} 处
          </span>
          {acceptedStat ? (
            <span className="diff-selection-stat">
              本次将写入 <span className="diff-stat diff-stat-add">+{acceptedStat.added}</span>{' '}
              <span className="diff-stat diff-stat-del">−{acceptedStat.removed}</span>
            </span>
          ) : null}
          <span className="panel-spacer" />
          <button
            type="button"
            className="btn btn-tiny"
            onClick={() => diff.hunks.forEach((_, index) => (selection!.has(index) ? undefined : onToggleHunk!(index)))}
          >
            全选
          </button>
          <button
            type="button"
            className="btn btn-tiny"
            onClick={() => diff.hunks.forEach((_, index) => (selection!.has(index) ? onToggleHunk!(index) : undefined))}
          >
            全不选
          </button>
        </div>
      ) : null}

      <div className="diff-body">
        {visible.map((row) =>
          row.kind === 'hunk' ? (
            <div className="diff-line diff-hunk" key={row.key}>
              {selectable ? (
                <label className="diff-hunk-check">
                  <input
                    type="checkbox"
                    checked={selection!.has(row.index)}
                    onChange={() => onToggleHunk!(row.index)}
                  />
                </label>
              ) : null}
              <span className="diff-text">{row.text}</span>
            </div>
          ) : (
            <div
              className={`diff-line diff-${row.line.kind}${
                selectable && !selection!.has(row.hunkIndex) ? ' diff-skipped' : ''
              }`}
              key={row.key}
            >
              <span className="diff-num">{row.line.oldLine ?? ''}</span>
              <span className="diff-num">{row.line.newLine ?? ''}</span>
              <span className="diff-sign">
                {row.line.kind === 'add' ? '+' : row.line.kind === 'remove' ? '−' : ' '}
              </span>
              {/* 空行也要占位，否则行高会塌陷、行号与内容错位 */}
              <span className="diff-text">{row.line.text === '' ? '\u00a0' : row.line.text}</span>
            </div>
          ),
        )}

        {hiddenCount > 0 ? (
          <button type="button" className="diff-more" onClick={() => setExpanded(true)}>
            还有 {hiddenCount} 行，全部展开
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 供卡片头部使用的紧凑统计文案 */
export function diffSummary(diff: FileDiff): string {
  if (diff.binary) return '二进制';
  if (diff.created) return `新建 +${diff.added}`;
  if (diff.deleted) return `清空 −${diff.removed}`;
  return `+${diff.added} −${diff.removed}`;
}
