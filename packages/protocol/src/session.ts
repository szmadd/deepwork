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
   * 分叉按事件 seq 精确切：请求位置恰好命中某条事件时 atSeq === requestedSeq。
   * 仅当请求的 seq 不存在于日志（手改日志或界面传了不存在的位置）时，
   * atSeq 才取「不晚于该 seq 的最近事件」—— 二者的差异只表示这一件事，
   * **不是**「请求落在轮次中间被吸附回边界」（旧语义，见 M1 遗留「逐事件分叉」）。
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
  /**
   * 最近一次内核上报的上下文占用；内核一次都没报过时为空。
   *
   * 落进会话 meta 而不是只留在事件流里，是为了让「切走再切回来 / 重启应用」
   * 之后仍然看得到 —— 上下文占用是用户判断「这轮还能不能塞下」的即时依据，
   * 只在当次事件流里有效的话，它的可用窗口会短得没有意义。
   */
  context?: SessionContextUsage;
  /** 由分叉产生时记录来源；普通会话为空 */
  fork?: SessionFork;
}

/**
 * 上下文占用快照。
 *
 * `size` 是**内核认定的容量**（官方模型来自内核目录，自定义端点模型来自
 * 我们在运行时补丁里填的 contextWindow），所以界面上不必标注"估计"。
 */
export interface SessionContextUsage {
  used: number;
  size: number;
  /** 该快照的采集时刻 */
  ts: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** 预估花费（元） */
  costCny: number;
}

/**
 * 模型条目的来源。
 *
 * 每个条目都必须能回答「这个结论从哪来的」—— 从内核 session/new 真帧读来的，
 * 与从用户填的端点配置里抄来的，可信度完全不同，界面上也不该长得一样。
 */
export type ModelSource =
  /** 真实内核 session/new 公布的 configOptions（已核对） */
  | 'kernel'
  /** 用户填写的自定义端点模型名（未与端点核对） */
  | 'endpoint'
  /** mock 内核自报的链路验证模型 */
  | 'mock';

export interface ModelDescriptor {
  id: string;
  label: string;
  provider: string;
  /** 是否支持程序化工具调用 */
  supportsPtc: boolean;
  /**
   * 上下文窗口。
   *
   * **只有真的知道时才带这个字段**：内核的 configOptions 帧里没有它，
   * 自定义端点也要用户自己填。此前这里对所有模型写死 256_000 —— 那是自编数据，
   * 界面显示得很精确，实际没有任何来源。缺省即「未知」，界面显示「未提供」。
   */
  contextWindow?: number;
  source: ModelSource;
  /** 自定义端点的地址，用于区分同名模型来自哪个端点；内核与 mock 条目为空 */
  endpoint?: string;
}

/** 内核公布的推理档位（configOptions 的 reasoning_effort 项）。 */
export interface ReasoningEffortOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * 模型目录：`models.list` / `models.refresh` 的返回。
 *
 * 它同时承载「有哪些模型」与「这份清单是怎么来的」—— 后者不是装饰：
 * 真实内核的清单要建一个探针会话去取帧，取不到时必须如实说「没核对上」，
 * 而不是回退到一份写死的官方清单让人以为一切正常。
 */
export interface ModelCatalog {
  models: ModelDescriptor[];
  /**
   * 内核公布的推理档位。空数组 = 内核没公布（mock 内核，或取帧失败）——
   * 此时界面只提供「不干预」，不构造一套看起来合理的默认档位。
   */
  reasoningEfforts: ReasoningEffortOption[];
  /** 内核 session/new 当时的默认模型（取自 currentValue）；null = 未知 */
  kernelDefaultModel: string | null;
  /** 内核 session/new 当时的默认推理档位；null = 未知 */
  kernelDefaultReasoningEffort: string | null;
  source: ModelSource | 'unknown';
  /** 与内核核对的时间戳（ms）；null = 从未核对成功过 */
  checkedAt: number | null;
  /** 一句话如实说明这份清单的来历，界面直接展示，不做二次解释 */
  note: string;
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
