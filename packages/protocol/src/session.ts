/**
 * 会话与运行（run）的元数据模型。
 */

import type { FileDiff } from './diff';
import type { RiskLevel } from './security';

/** Harness 的四种预设模式（与内核能力一一对应） */
export type AgentMode = 'standard' | 'ptc' | 'minimal' | 'creative';

export const AGENT_MODE_LABEL: Record<AgentMode, string> = {
  standard: '标准',
  ptc: '程序化工具调用',
  minimal: '极简',
  creative: '创造',
};

export type SessionStatus = 'idle' | 'running' | 'aborted' | 'failed';

/**
 * 会话的分叉来源。
 *
 * 分叉的语义是「继承父会话的一段历史，然后独立往下走」——
 * 继承的那段是**字节级复制**的，因此它既是新会话的上下文，也是一份可核验的凭据：
 * 新会话日志的前 N 行与父会话前 N 行逐字节相同。
 */
export interface SessionFork {
  /** 父会话 id */
  sessionId: string;
  /** 分叉点：父会话中最后一条被继承的事件的 seq */
  atSeq: number;
}

/** 分叉操作的完整记录（比 SessionFork 多了「当时请求的位置」与继承条数） */
export interface ForkOrigin extends SessionFork {
  /**
   * 调用方请求的分叉点；null 表示「从末尾分叉」。
   * 与 atSeq 不同即说明请求落在一轮运行中间，被吸附回了最近的合法边界。
   */
  requestedSeq: number | null;
  /** 继承的事件条数（= 新会话日志中位于分叉标记之前的行数） */
  copied: number;
}

export interface Session {
  id: string;
  title: string;
  /** 会话绑定的工作区根目录；越界访问需显式授权 */
  workspace: string;
  mode: AgentMode;
  model: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  /** 累计用量，用于成本面板 */
  usage: Usage;
  /** 由分叉产生时记录来源；普通会话为空 */
  fork?: SessionFork;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** 预估花费（元） */
  costCny: number;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  provider: string;
  /** 是否支持程序化工具调用 */
  supportsPtc: boolean;
  contextWindow: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 结构化参数，用于卡片展示 */
  args: Record<string, unknown>;
  /** 人类可读的一句话摘要 */
  summary: string;
  risk: RiskLevel;
  /**
   * 写操作的差异预览，在工具真正执行之前生成。
   * 有了它，工具卡片在「执行中」阶段就能显示即将发生的改动，而不是等结果回来再补。
   */
  diff?: FileDiff;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  output: string;
  durationMs: number;
  truncated?: boolean;
}

export type RunStatus = 'completed' | 'aborted' | 'failed';
