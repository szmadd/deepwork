/**
 * 事件流 → 视图模型 的归约。
 *
 * 为什么放在契约层，而不是渲染层：
 *  1. 「一串事件到底意味着什么」是契约语义，不是渲染细节。内核、壳层、UI 必须对
 *     同一份日志得出同一个结论 —— 否则「回放」只是另一套渲染逻辑，证明不了任何事；
 *  2. 放在这里，Node 侧（验证脚本、导出、以及未来的 fork 续跑）才能在不启动浏览器的
 *     前提下重放一份会话日志，并把它当成可断言的产物。
 *
 * 硬要求：本文件必须保持**纯函数** —— 无 IO、无时钟、无随机。相同的事件序列永远归约出
 * 相同的结果，这正是「回放结果 == 当初实时渲染结果」得以成立的前提。
 */

import type { AgentEvent } from './events';
import type { RunStatus, ToolCall, ToolResult, Usage } from './session';

export type TimelineItem =
  | { id: string; kind: 'user'; runId: string; text: string }
  | { id: string; kind: 'reasoning'; runId: string; text: string; streaming: boolean }
  | { id: string; kind: 'message'; runId: string; text: string; streaming: boolean }
  | { id: string; kind: 'tool'; runId: string; call: ToolCall; result?: ToolResult }
  | {
      id: string;
      kind: 'notice';
      level: 'info' | 'warn' | 'error';
      text: string;
      /**
       * 可行动的建议。有就单独一行显示，没有就不留空行 ——
       * 每条提示都补一句「请检查配置」会让真正有用的那句淹没在套话里。
       */
      remedy?: string;
      /**
       * 结论的依据（例如「某时刻的探测结果，不是此刻的实时状态」）。
       *
       * **界面必须显示它。** 带依据的提示与不带依据的提示在用户那里是两种东西：
       * 前者他会判断这条结论有多新，后者他会当成实时状态去排障 ——
       * 于是去查一个早就修好的服务，或者反过来无视一个真挂了的东西。
       */
      basis?: string;
    }
  | {
      id: string;
      kind: 'run';
      runId: string;
      status: RunStatus;
      durationMs: number;
      /**
       * 该轮结束事件的 seq，也就是「在这里分叉」时传给 session.fork 的 atSeq。
       * 带上它，界面就不必去解析 id 字符串来还原位置。
       */
      atSeq: number;
    };

export const EMPTY_TIMELINE: TimelineItem[] = [];

export function applyEvent(items: TimelineItem[], event: AgentEvent): TimelineItem[] {
  switch (event.type) {
    case 'user.message':
      return [...items, { id: `u_${event.seq}`, kind: 'user', runId: event.runId, text: event.text }];

    case 'reasoning.delta':
      return appendDelta(items, event.runId, 'reasoning', event.text);

    case 'message.delta':
      return appendDelta(items, event.runId, 'message', event.text);

    case 'message.completed': {
      const next = [...items];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const item = next[i];
        if (item.kind === 'message' && item.runId === event.runId && item.streaming) {
          next[i] = { ...item, text: event.text || item.text, streaming: false };
          return next;
        }
      }
      return next;
    }

    case 'tool.started':
      return [
        ...items,
        { id: event.call.id, kind: 'tool', runId: event.runId, call: event.call },
      ];

    case 'tool.completed': {
      const next = [...items];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const item = next[i];
        if (item.kind === 'tool' && item.call.id === event.callId) {
          next[i] = {
            ...item,
            result: {
              callId: event.callId,
              ok: event.ok,
              output: event.output,
              durationMs: event.durationMs,
            },
          };
          return next;
        }
      }
      return next;
    }

    case 'approval.resolved':
      return [
        ...items,
        {
          id: `n_${event.seq}`,
          kind: 'notice',
          level: event.decision === 'deny' ? 'warn' : 'info',
          text: `审批${event.decision === 'deny' ? '被拒绝' : '已放行'}（${event.requestId}）`,
        },
      ];

    case 'skill.attached': {
      const explicit = event.skills.filter((s) => s.explicit);
      const summary = event.skills.map((s) => (s.explicit ? `${s.name}（显式调用）` : s.name)).join('、');
      return [
        ...items,
        {
          id: `n_${event.seq}`,
          kind: 'notice',
          level: 'info',
          text:
            explicit.length > 0
              ? `已挂载技能：${summary} —— 显式调用的技能全文已随本轮注入内核`
              : `已挂载技能：${summary}（摘要注入，内核可按需读取 SKILL.md 全文）`,
        },
      ];
    }

    case 'skill.skipped':
      return [
        ...items,
        {
          id: `n_${event.seq}`,
          kind: 'notice',
          level: 'warn',
          text: `以下技能已启用但 SKILL.md 读取/解析失败，本轮已跳过（对内核不可见）：${event.skills.join('、')}。请到技能面板检查或重装。`,
        },
      ];

    case 'memory.attached': {
      const count = (layer: string) => event.layers.find((stat) => stat.layer === layer)?.entries ?? 0;
      return [
        ...items,
        {
          id: `n_${event.seq}`,
          kind: 'notice',
          level: 'info',
          text: `已挂载记忆：画像 ${count('profile')} 条 · 用户级 ${count('user')} 条 · 工作区 ${count('workspace')} 条`,
        },
      ];
    }

    case 'schedule.fired':
      return [
        ...items,
        {
          id: `n_${event.seq}`,
          kind: 'notice',
          level: 'info',
          text: `定时任务「${event.task.title}」已触发，本轮由自动化调度发起`,
        },
      ];

    case 'run.completed':
      return [
        ...closeStreams(items, event.runId),
        {
          id: `r_${event.seq}`,
          kind: 'run',
          runId: event.runId,
          status: event.status,
          durationMs: event.durationMs,
          atSeq: event.seq,
        },
      ];

    case 'run.notice':
      return [
        ...items,
        {
          id: `n_${event.seq}`,
          kind: 'notice',
          level: event.level,
          text: event.message,
          ...(event.remedy ? { remedy: event.remedy } : {}),
          ...(event.basis ? { basis: event.basis } : {}),
        },
      ];

    case 'run.failed':
      return [
        ...closeStreams(items, event.runId),
        { id: `e_${event.seq}`, kind: 'notice', level: 'error', text: event.message },
        {
          id: `r_${event.seq}`,
          kind: 'run',
          runId: event.runId,
          status: 'failed',
          durationMs: 0,
          atSeq: event.seq,
        },
      ];

    // fork 标记描述的是「这份日志从哪来」，不是对话内容的一部分，
    // 因此不进对话视图（它是 Trajectory 视图的素材）。
    case 'session.forked':
    default:
      return items;
  }
}

function appendDelta(
  items: TimelineItem[],
  runId: string,
  kind: 'reasoning' | 'message',
  text: string,
): TimelineItem[] {
  const next = [...items];
  const last = next[next.length - 1];
  if (last && last.kind === kind && last.runId === runId && last.streaming) {
    next[next.length - 1] = { ...last, text: last.text + text };
    return next;
  }
  next.push({ id: `${kind}_${runId}_${next.length}`, kind, runId, text, streaming: true });
  return next;
}

function closeStreams(items: TimelineItem[], runId: string): TimelineItem[] {
  return items.map((item) =>
    (item.kind === 'reasoning' || item.kind === 'message') && item.runId === runId && item.streaming
      ? { ...item, streaming: false }
      : item,
  );
}

export function buildTimeline(events: AgentEvent[]): TimelineItem[] {
  return events.reduce<TimelineItem[]>((acc, event) => applyEvent(acc, event), []);
}

/** 从事件流汇总用量，用于会话级的成本展示 */
export function sumUsage(events: AgentEvent[]): Usage {
  return events.reduce<Usage>(
    (acc, event) => {
      if (event.type !== 'usage') return acc;
      return {
        promptTokens: acc.promptTokens + event.usage.promptTokens,
        completionTokens: acc.completionTokens + event.usage.completionTokens,
        costCny: Number((acc.costCny + event.usage.costCny).toFixed(6)),
      };
    },
    { promptTokens: 0, completionTokens: 0, costCny: 0 },
  );
}

/**
 * 可作为分叉点的事件 seq 列表（升序）。
 *
 * 只有一轮运行**结束**的位置才是合法分叉点：在半轮里分叉，日志会停在一个
 * 悬空的 tool.started 或半截流式消息上，而那个状态无法继续往下跑。
 */
export function runBoundaries(events: AgentEvent[]): number[] {
  const boundaries: number[] = [];
  for (const event of events) {
    if (event.type === 'run.completed' || event.type === 'run.failed') boundaries.push(event.seq);
  }
  return boundaries;
}
