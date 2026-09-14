/**
 * 用量聚合契约（M2-J）。
 *
 * ── 为什么要有三种分组 ──
 * 同一份用量数据，三个维度回答三个不同的问题：
 *  - `byDay`     「这两天是不是突然变贵了」→ 看趋势；
 *  - `byModel`   「换成本地模型能省多少」→ 看口径（本地模型 costCny 恒 0）；
 *  - `bySession` 「哪个会话烧得最凶」→ 定位到具体任务。
 *
 * ── 一条硬等式 ──
 * **三种分组各自的合计必须与 `totals` 逐项相等。** 它既是给用户的承诺，
 * 也是测试里那条最硬的断言：分组之和 ≠ 总数，说明有一类事件没被归进去，
 * 而那种漏洞在界面上表现为「数字看起来都对，就是加起来不对」，肉眼极难发现。
 *
 * ── 费用为什么有两个口径 ──
 * `costCny` 是**内核上报的**实际花费（本地模型恒 0）；`estimatedCostCny` 是
 * 用配置里的单价表**按 token 重算**的估算。两者都对，但回答的问题不同 ——
 * 混成一个数就会在「换模型之后」这段窗口里给出自相矛盾的结论。
 * 模型没有配置单价时估算返回 `null` 而不是 0：**0 会被读成「免费」**。
 *
 * ── 第三个口径：根本没上报 ──
 * 真实内核的 ACP 通道不上报 token 与费用（见 `UsageCoverage`）。此时
 * `costCny = 0` 与「免费」无关，`estimatedCostCny = null`（无样本 ⇒ 无单价问题）
 * 也读不出原因。所以汇总必须带上 `coverage`，让界面能说「这几轮的用量内核没报」
 * 而不是替内核宣称用户没花钱。三件事——上报的、估算的、没上报的——必须能分开看。
 */

import type { Usage } from './session';

/** 一个聚合桶的用量合计 */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  /** prompt + completion，单独给出是因为界面到处要显示它，不想让每个调用方各算一遍 */
  totalTokens: number;
  /** 内核上报的累计花费（元） */
  costCny: number;
  /** 参与归集的 run 数（= usage 事件条数） */
  runs: number;
}

export interface UsageSessionRow {
  sessionId: string;
  title: string;
  workspace: string;
  updatedAt: number;
  totals: UsageTotals;
  /** 按单价估算的花费；该会话用过无单价的模型时为 null */
  estimatedCostCny: number | null;
}

export interface UsageDayRow {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  totals: UsageTotals;
  estimatedCostCny: number | null;
}

export interface UsageModelRow {
  model: string;
  totals: UsageTotals;
  estimatedCostCny: number | null;
}

export interface UsageSummary {
  totals: UsageTotals;
  /** 全局估算花费；存在无单价模型时为 null（不假装 0） */
  estimatedCostCny: number | null;
  /** 按日期升序 —— 图表从左到右就是时间方向 */
  byDay: UsageDayRow[];
  /** 按 token 降序 */
  byModel: UsageModelRow[];
  bySession: UsageSessionRow[];
  /**
   * 有 token 消耗但配置里查不到单价的模型。
   * 界面必须如实标出它们 —— 否则「估算」会静默漏掉一部分用量。
   */
  unpricedModels: string[];
  /**
   * 数据完整性：有几轮跑了、其中几轮有用量数据。
   *
   * ── 为什么必须有它 ──
   * 真实内核（ACP）**不上报 token 与费用**，只上报上下文占用。所以真实模式下
   * `totals` 会是三个 0 —— 那是「内核没上报」，不是「没花钱也没用 token」。
   * 少了这个字段，界面只能把 0 显示成 0，用户在真实内核下花了钱却看到 ¥0.0000，
   * 而这恰恰是"看起来一切正常"的错。
   *
   * 口径：`runs` 来自日志里的 `run.started`，`runsWithUsage` 来自有 `usage` 事件的
   * run。两者不等时，界面必须说明差额而不是把它混进总数里。
   */
  coverage: UsageCoverage;
  /** 本次汇总的生成时刻 */
  generatedAt: number;
}

export interface UsageCoverage {
  /** 日志里出现过 run.started 的 run 数 */
  runs: number;
  /** 其中有 usage 数据的 run 数 */
  runsWithUsage: number;
}

export function emptyUsageTotals(): UsageTotals {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costCny: 0, runs: 0 };
}

/** 桶里累加一次 usage；costCny 保留 6 位，避免浮点误差在长会话里滚成可见的脏数字 */
export function addUsage(totals: UsageTotals, usage: Usage): UsageTotals {
  return {
    promptTokens: totals.promptTokens + usage.promptTokens,
    completionTokens: totals.completionTokens + usage.completionTokens,
    totalTokens: totals.totalTokens + usage.promptTokens + usage.completionTokens,
    costCny: Number((totals.costCny + usage.costCny).toFixed(6)),
    runs: totals.runs + 1,
  };
}

export interface ModelPrice {
  /** 每千 prompt token 的价格（元） */
  promptPer1k: number;
  completionPer1k: number;
}

/** 按单价表估算一次调用的花费；模型未配置单价返回 null */
export function estimateCost(usage: Usage, price: ModelPrice | undefined): number | null {
  if (!price) return null;
  const cost =
    (usage.promptTokens / 1000) * price.promptPer1k +
    (usage.completionTokens / 1000) * price.completionPer1k;
  return Number(cost.toFixed(6));
}
