import { useState } from 'react';
import type { ToolCall, ToolResult } from '@deepwork/protocol';
import { DiffView, diffSummary } from './DiffView';

interface ToolCardProps {
  call: ToolCall;
  result?: ToolResult;
}

const RISK_LABEL: Record<ToolCall['risk'], string> = {
  safe: '只读',
  confirm: '需确认',
  danger: '高危',
};

/** 差异已经表达了这几个字段的内容，参数区再重复一遍只会淹没重点 */
const REDUNDANT_WHEN_DIFF = ['content', 'old_string', 'new_string'];

function displayArgs(call: ToolCall): Record<string, unknown> {
  if (!call.diff) return call.args;
  return Object.fromEntries(
    Object.entries(call.args).filter(([key]) => !REDUNDANT_WHEN_DIFF.includes(key)),
  );
}

export function ToolCard({ call, result }: ToolCardProps) {
  // 有差异的写操作默认展开：改动内容就是这张卡片存在的意义，
  // 让用户为「看一眼改了什么」再点一次是没道理的
  const [open, setOpen] = useState(Boolean(call.diff));
  const pending = !result;
  const args = displayArgs(call);

  return (
    <div className={`tool-card${result && !result.ok ? ' tool-card-failed' : ''}`}>
      <div className="tool-head" onClick={() => setOpen((value) => !value)} role="button" tabIndex={0}>
        <span className={`tool-risk risk-${call.risk}`}>{RISK_LABEL[call.risk]}</span>
        <code className="tool-name">{call.name}</code>
        <span className="tool-summary">{call.summary}</span>
        <span className="tool-spacer" />
        {call.diff ? <span className="tool-diff-stat">{diffSummary(call.diff)}</span> : null}
        {pending ? (
          <span className="tool-pending">执行中…</span>
        ) : (
          <span className="tool-duration">{result.durationMs}ms</span>
        )}
        <span className="tool-chevron">{open ? '▾' : '▸'}</span>
      </div>

      {open ? (
        <div className="tool-body">
          {call.diff ? <DiffView diff={call.diff} /> : null}

          {Object.keys(args).length > 0 ? (
            <div className="tool-section">
              <div className="tool-section-title">参数</div>
              <pre>{JSON.stringify(args, null, 2)}</pre>
            </div>
          ) : null}

          {result ? (
            <div className="tool-section">
              <div className="tool-section-title">输出{result.ok ? '' : '（失败）'}</div>
              <pre>{result.output || '(空)'}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
