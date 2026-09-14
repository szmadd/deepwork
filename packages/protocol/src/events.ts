/**
 * 归一化事件流 —— 本项目最重要的一份契约。
 *
 * 设计原则：
 *  1. UI 只认识这里的事件类型，永远不直接接触任何内核（Harness）原生结构；
 *  2. 内核换版本、换实现、甚至换框架，只需在 harness-adapter 内做一次映射；
 *  3. 事件全部可 JSON 序列化，天然可写入 append-only 日志，支持回放 / fork。
 */

import type { ApprovalDecision, ApprovalRequest } from './security';
import type { ScheduleTask } from './schedule';
import type { AgentMode, ForkOrigin, RunStatus, Session, ToolCall, Usage } from './session';
import type { MemoryLayerStat } from './memory';
import type { SkillAttachment } from './skills';

export type AgentEventType =
  | 'host.ready'
  | 'session.created'
  | 'session.updated'
  | 'session.forked'
  | 'user.message'
  | 'skill.attached'
  | 'memory.attached'
  | 'schedule.fired'
  | 'run.started'
  | 'reasoning.delta'
  | 'message.delta'
  | 'message.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'usage'
  | 'context.usage'
  | 'run.completed'
  | 'run.failed';

interface EventBase {
  /** 事件类型 */
  type: AgentEventType;
  /** 单调递增序号，用于日志顺序校验与断点续传 */
  seq: number;
  ts: number;
}

export interface HostReadyEvent extends EventBase {
  type: 'host.ready';
  adapter: 'mock' | 'harness';
  adapterVersion: string;
  capabilities: string[];
}

export interface SessionCreatedEvent extends EventBase {
  type: 'session.created';
  session: Session;
}

export interface SessionUpdatedEvent extends EventBase {
  type: 'session.updated';
  session: Session;
}

/**
 * 分叉标记。
 *
 * 它有一条硬性约定：**必须紧跟在被继承的那段历史之后**，即新会话的日志形状为
 *   [父会话前 N 行的逐字节复制...][session.forked]
 * 反过来说，任何「先写标记再写复制内容」的实现都会让新日志的前 N 行不再等于父日志的前 N 行，
 * 于是「这段历史确实来自那里」这句话就无法被验证了。
 *
 * 它同时取代了分叉会话的 session.created —— 新会话因此少一次事件，但日志自解释性更强。
 */
export interface SessionForkedEvent extends EventBase {
  type: 'session.forked';
  session: Session;
  from: ForkOrigin;
}

export interface RunStartedEvent extends EventBase {
  type: 'run.started';
  runId: string;
  sessionId: string;
  mode: AgentMode;
  model: string;
}

/**
 * 用户输入也必须进事件流。
 * 否则会话日志只有模型的半截对话，回放 / fork / 训练数据回填都会缺一半。
 */
export interface UserMessageEvent extends EventBase {
  type: 'user.message';
  runId: string;
  text: string;
  attachments?: string[];
}

/**
 * 技能挂载记录。
 *
 * 它必须进日志：事后复盘「这一轮模型为什么知道该这么做」时，技能上下文是唯一答案。
 * 不带 runId 的话会退化成全局事件，分叉会话的视图里会凭空多出别的会话的技能记录 ——
 * 与 session.forked 的归属问题同源，因此这里强制带 runId。
 */
export interface SkillAttachedEvent extends EventBase {
  type: 'skill.attached';
  runId: string;
  skills: SkillAttachment[];
}

/**
 * 记忆挂载记录。
 *
 * 与 skill.attached 同一条纪律：必须带 runId（否则退化成全局事件，污染分叉会话视图）、
 * 必须先于 run.started 发出、必须进日志 —— 事后复盘「这一轮模型为什么知道用户偏好」时，
 * 记忆上下文是唯一答案。没有任何记忆时不发这个事件。
 */
export interface MemoryAttachedEvent extends EventBase {
  type: 'memory.attached';
  runId: string;
  layers: MemoryLayerStat[];
}

/**
 * 定时任务触发记录。
 *
 * 它派生出一个真实 run（runId），且必须先于 run.started 落盘 ——
 * 与 skill.attached 同一条归属纪律：不带 runId 会退化成全局事件，
 * 污染其他会话的视图。sessionId 一并带上，让 UI 在「该会话不是当前会话」时
 * 能直接提供跳转，而不必反查映射。
 *
 * 它必须进日志：事后复盘「这一轮是谁发起的」时，这条记录是唯一答案。
 */
export interface ScheduleFiredEvent extends EventBase {
  type: 'schedule.fired';
  runId: string;
  sessionId: string;
  task: ScheduleTask;
}

export interface ReasoningDeltaEvent extends EventBase {
  type: 'reasoning.delta';
  runId: string;
  text: string;
}

export interface MessageDeltaEvent extends EventBase {
  type: 'message.delta';
  runId: string;
  text: string;
}

export interface MessageCompletedEvent extends EventBase {
  type: 'message.completed';
  runId: string;
  text: string;
}

export interface ToolStartedEvent extends EventBase {
  type: 'tool.started';
  runId: string;
  call: ToolCall;
}

export interface ToolCompletedEvent extends EventBase {
  type: 'tool.completed';
  runId: string;
  callId: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface ApprovalRequestedEvent extends EventBase {
  type: 'approval.requested';
  runId: string;
  request: ApprovalRequest;
}

export interface ApprovalResolvedEvent extends EventBase {
  type: 'approval.resolved';
  runId: string;
  requestId: string;
  decision: ApprovalDecision;
  /**
   * 逐 hunk 授权时被采纳的 hunk 下标；整体授权时省略。
   *
   * 它必须进日志：事后复盘「这次为什么只写进去一半」时，唯一能回答的就是这条记录。
   * 只记 decision 的话，部分授权在日志里与完全授权长得一模一样。
   */
  hunks?: number[];
}

export interface UsageEvent extends EventBase {
  type: 'usage';
  runId: string;
  usage: Usage;
}

/**
 * 上下文占用 —— 内核上报的「现在装了多少、最多能装多少」。
 *
 * ── 它和 `usage` 不是一件事，不能合并 ──
 *  - `usage`        本轮花了多少 token、多少钱。**只有 mock 内核报**；真实内核的
 *                   ACP 通道不上报 token 与费用（规格明确把 provider 原始增量与
 *                   呈现数据留在链路外，2026-09-14 实测确认）。
 *  - `context.usage` 当前上下文占了多少、容量多大。**真实内核报**（ACP 的
 *                   `usage_update`，每提交一条助手消息后各报一次）。
 *
 * 两者恰好互补：真实模式下能答的只有后者。把前者显示成 `0 / ¥0.0000` 是拿
 * 「没上报」冒充「没花钱」——那正是这个事件存在的理由。
 *
 * ── size 为什么不必标「估计」──
 * 它是**内核认定的容量**，不是我们算的：官方模型由内核目录给出，自定义端点模型
 * 取的是我们在运行时补丁里填的 `contextWindow`（2026-09-14 实测：补丁填 123456，
 * 帧里 `size` 就是 123456）。所以「用户填的 contextWindow」这条链路
 * 由此变成可验证的，而不是"填了应该有用"。
 */
export interface ContextUsageEvent extends EventBase {
  type: 'context.usage';
  runId: string;
  /** 已占用 token（内核 token meter 的测量值） */
  used: number;
  /** 容量 token（内核认定的上下文窗口） */
  size: number;
}

export interface RunCompletedEvent extends EventBase {
  type: 'run.completed';
  runId: string;
  status: RunStatus;
  durationMs: number;
}

export interface RunFailedEvent extends EventBase {
  type: 'run.failed';
  runId: string;
  message: string;
  /** 是否可通过重试恢复 */
  retryable: boolean;
}

export type AgentEvent =
  | HostReadyEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionForkedEvent
  | UserMessageEvent
  | SkillAttachedEvent
  | MemoryAttachedEvent
  | ScheduleFiredEvent
  | RunStartedEvent
  | ReasoningDeltaEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | UsageEvent
  | ContextUsageEvent
  | RunCompletedEvent
  | RunFailedEvent;

/** 去掉 seq/ts 的事件载荷，便于适配层构造 */
export type AgentEventInput = AgentEvent extends infer T
  ? T extends AgentEvent
    ? Omit<T, 'seq' | 'ts'>
    : never
  : never;
