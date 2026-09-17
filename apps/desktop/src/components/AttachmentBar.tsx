import type { AttachmentPreview } from '@deepwork/protocol';
import { formatBytes } from '../api';

interface AttachmentBarProps {
  attachments: AttachmentPreview[];
  onRemove: (path: string) => void;
  onPreview: (attachment: AttachmentPreview) => void;
}

/**
 * 已附加文件清单（输入卡片的上沿）。
 *
 * ── 只画清单，不画入口 ──
 * 「+」是卡片左下角的裸图标按钮（见 `Composer`）。入口与清单分居两处是刻意的：
 * 入口属于动作栏（每次输入都要看得见），清单属于「这一轮带了什么」
 * （有才出现，没有就不占一行）。空态的说明文案跟着入口走，挂在它的 title 上。
 *
 * ── 一条克制的设计 ──
 * 这里**不做内容摘要**。附件可能是一份 5 万行的日志，摘一段出来展示，
 * 用户既无法据此判断 Agent 看到了什么，又会以为「它只看了这一段」。
 * 因此只如实展示元信息：文件名、体积、以及**读取是否成功**。
 *
 * 读取结果必须分四种情况说清楚（不存在 / 是目录 / 二进制 / 超出上限），
 * 全都笼统显示成「已附加」的话，用户会以为一份读不到的文件已经进了上下文。
 */
export function AttachmentBar({ attachments, onRemove, onPreview }: AttachmentBarProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="attach-bar">
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
    </div>
  );
}

function describeProblem(item: AttachmentPreview): string | null {
  if (item.error) return '读取失败';
  if (item.binary) return '二进制';
  if (item.truncated) return '超出上限';
  return null;
}
