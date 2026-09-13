import { useEffect, useRef } from 'react';
import type { AgentEvent } from '@deepwork/protocol';

interface TrajectoryPanelProps {
  events: AgentEvent[];
  onClose: () => void;
}

/**
 * Trajectory 视图 —— 会话日志的原始视图。
 *
 * 这是「过程可回放」这一卖点的最小实现：只读、按 seq 排列、不做任何美化。
 * 它的价值在于排查问题时能看到协议层真实发生了什么，而不是被 UI 的聚合掩盖。
 */
export function TrajectoryPanel({ events, onClose }: TrajectoryPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  return (
    <aside className="trajectory">
      <div className="trajectory-head">
        <span>Trajectory</span>
        <span className="trajectory-count">{events.length} 事件</span>
        <button type="button" className="icon-btn" onClick={onClose} title="关闭">
          ×
        </button>
      </div>

      <div className="trajectory-body">
        {events.map((event) => (
          <div className={`traj-row traj-${event.type.replace('.', '-')}`} key={event.seq}>
            <span className="traj-seq">#{event.seq}</span>
            <span className="traj-type">{event.type}</span>
            <span className="traj-time">{new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <pre className="traj-payload">{summarize(event)}</pre>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </aside>
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
    case 'tool.completed':
      return `${event.ok ? 'ok' : 'fail'} ${event.durationMs}ms`;
    case 'approval.requested':
      return `${event.request.tool}: ${event.request.subject}`;
    case 'approval.resolved':
      return `${event.requestId} → ${event.decision}`;
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
