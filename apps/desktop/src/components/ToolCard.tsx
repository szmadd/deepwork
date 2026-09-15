import { useState } from 'react';
import { parseSandboxDenial, SANDBOX_ESCALATION_ARG } from '@deepwork/protocol';
import type { SandboxDenial, ToolCall, ToolResult } from '@deepwork/protocol';
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

/**
 * 「被沙箱拦下」这句人话。
 *
 * 分档写文案而不是套一句通用话，是因为三种档位下用户的**下一步动作完全不同**：
 * read-only 要去把档位放宽；workspace-write 要看清目标在不在工作区；
 * danger-full-access 下出现拒绝则说明内核行为与文档不符，该去核对版本。
 * 通用话（「文件写入被拒绝」）在这三种情况下都等于没说。
 */
function sandboxExplanation(denial: SandboxDenial): string {
  switch (denial.mode) {
    case 'read-only':
      return '当前内核档位是 read-only：一切文件变更都被拒绝，包括工作区内的文件。';
    case 'workspace-write':
      return '当前内核档位是 workspace-write：只允许修改会话工作区（以及平台临时区）内的文件，本次目标在其之外。';
    case 'danger-full-access':
      return '当前内核档位是 danger-full-access，按内核文档它不限制文件变更 —— 出现拒绝说明实际行为与文档不符，建议核对内核版本。';
    default:
      return `内核报告的档位是 ${denial.mode}，本版本不认识这个值（可能内核新增了档位）—— 拒绝是内核给的，请以内核为准。`;
  }
}

export function ToolCard({ call, result }: ToolCardProps) {
  /**
   * 展开状态 = 用户的显式选择 ?? 推导出来的默认值。
   *
   * 不写成 `useState(Boolean(call.diff))` 是因为 `result` 是**后到**的：
   * 卡片先以「执行中」挂载，工具失败之后才知道是不是被沙箱拦下 ——
   * 用 useState 的初值就永远看不到那一帧，卡片会保持折叠，
   * 用户得自己点开才知道「不是磁盘的问题，是档位的问题」。
   * `null` 表示「用户还没表过态」，一旦表态就以此后为准。
   */
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const pending = !result;
  const args = displayArgs(call);
  /**
   * 被内核沙箱拦下 ≠ 工具失败。
   *
   * 两者在事件层都是 `ok=false`，但成因与后续动作完全不同：前者是**你自己设的档位**
   * 在起作用（去改档位或改目标），后者是工具/代码出错（去查日志）。
   * 事件层没有区分字段，只能从输出里读 —— 方言与解析见 protocol/security.ts。
   */
  const sandbox = result && !result.ok ? parseSandboxDenial(result.output) : null;
  // 有差异的写操作、以及被沙箱拦下的卡片，默认展开：那两块内容就是卡片存在的意义
  const open = userToggled ?? (Boolean(call.diff) || Boolean(sandbox));
  const toggle = () => setUserToggled(!open);

  return (
    <div
      className={`tool-card${result && !result.ok ? ' tool-card-failed' : ''}${
        sandbox ? ' tool-card-sandboxed' : ''
      }`}
    >
      <div className="tool-head" onClick={toggle} role="button" tabIndex={0}>
        <span className={`tool-risk risk-${call.risk}`}>{RISK_LABEL[call.risk]}</span>
        <code className="tool-name">{call.name}</code>
        <span className="tool-summary">{call.summary}</span>
        <span className="tool-spacer" />
        {/* 判定放在头部而不是折叠区里：不点开也该看见「被拦的是档位，不是磁盘」 */}
        {sandbox ? <span className="tool-sandbox-chip">被沙箱拦下 · {sandbox.mode}</span> : null}
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

          {sandbox ? (
            <div className="tool-section tool-sandbox">
              <div className="tool-section-title">被内核沙箱拦下</div>
              <p>{sandboxExplanation(sandbox)}</p>
              {sandbox.escalation ? (
                <p className="tool-sandbox-escalation">
                  内核还留了一条升级路径：模型可以带一次{' '}
                  <code>{SANDBOX_ESCALATION_ARG}</code> 重试同一操作，
                  <strong>那时才会</strong>弹出问你的审批。本条调用到此为止。
                </p>
              ) : null}
              {!sandbox.knownMode ? (
                <p className="tool-sandbox-escalation">
                  注意：档位取值 <code>{sandbox.mode}</code> 不在本版本已知的三个档位里。
                </p>
              ) : null}
            </div>
          ) : null}

          {Object.keys(args).length > 0 ? (
            <div className="tool-section">
              <div className="tool-section-title">参数</div>
              <pre>{JSON.stringify(args, null, 2)}</pre>
            </div>
          ) : null}

          {result ? (
            <div className="tool-section">
              <div className="tool-section-title">
                输出{result.ok ? '' : sandbox ? '（原始）' : '（失败）'}
              </div>
              <pre>{result.output || '(空)'}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
