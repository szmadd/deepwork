import type { AttachmentPreview } from '@deepwork/protocol';
import { formatBytes } from '../api';

interface AttachmentBarProps {
  attachments: AttachmentPreview[];
  onAdd: () => void;
  onRemove: (path: string) => void;
  onPreview: (attachment: AttachmentPreview) => void;
  disabled?: boolean;
}

/**
 * 附件栏。
 *
 * ── 一条克制的设计 ──
 * 这里**不做内容摘要**。附件可能是一份 5 万行的日志，摘一段出来展示，
 * 用户既无法据此判断 Agent 看到了什么，又会以为「它只看了这一段」。
 * 因此只如实展示元信息：文件名、体积、以及**读取是否成功**。
 *
 * 读取结果必须分四种情况说清楚（不存在 / 是目录 / 二进制 / 超出上限），
 * 全都笼统显示成「已附加」的话，用户会以为一份读不到的文件已经进了上下文。
 */
export function AttachmentBar({ attachments, onAdd, onRemove, onPreview, disabled }: AttachmentBarProps) {
  return (
    <div className="attach-bar">
      <button type="button" className="btn btn-tiny" onClick={onAdd} disabled={disabled} title="选择要附加给 Agent 的文件">
        + 附件
      </button>

      {attachments.length === 0 ? (
        <span className="attach-empty">未附加文件。附件的路径会随本轮对话进入会话日志，Agent 可自行按需读取。</span>
      ) : (
        <div className="attach-chips">
          {attachments.map((item) => {
            const problem = describeProblem(item);
            return (
              <span className={`attach-chip${problem ? ' attach-chip-warn' : ''}`} key={item.path}>
                <button
                  type="button"
                  className="attach-name"
                  title={`${item.path}\n点击查看内容`}
                  onClick={() => onPreview(item)}
                >
                  {item.name}
                </button>
                <span className="attach-size">{formatBytes(item.size)}</span>
                {problem ? <span className="attach-flag">{problem}</span> : null}
                <button
                  type="button"
                  className="icon-btn"
                  title="移除"
                  onClick={() => onRemove(item.path)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function describeProblem(item: AttachmentPreview): string | null {
  if (item.error) return '读取失败';
  if (item.binary) return '二进制';
  if (item.truncated) return '超出上限';
  return null;
}
