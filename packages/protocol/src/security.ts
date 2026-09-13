/**
 * 风险等级与审批模型。
 *
 * 命令审批三档策略（见架构文档 §5 安全）：
 *  - safe    自动放行（只读、无副作用）
 *  - confirm 需要用户逐次确认
 *  - danger  需要确认且 UI 高亮告警（不可逆、越界、外发数据）
 */

import type { FileDiff } from './diff';

export type RiskLevel = 'safe' | 'confirm' | 'danger';

export type ApprovalDecision = 'allow' | 'allow_always' | 'deny';

/**
 * 逐 hunk 授权。
 *
 * 一次写入动辄几十行改动，但「全部接受」与「全部拒绝」之间的真实需求很高：
 * 用户常常认可主体改动、却不认可顺带的一次格式化或删行。
 * 只能整体点头的话，用户只剩两个选择 —— 要么放行自己不认可的那部分，要么整轮退回重来。
 *
 * 因此授权粒度下沉到 hunk：`hunks` 是被采纳的 hunk 下标（对应 ApprovalRequest.diff.hunks）。
 * 语义约定：
 *  - 省略 `hunks`      → 整体授权，写入内容与预览逐字一致（原有行为，未变）；
 *  - 给出 `hunks`      → 只应用这些 hunk，未列出的 hunk 保持文件原样；
 *  - `hunks: []`       → 等同于拒绝，宿主不得解释为「空写入」。
 */
export interface ApprovalSelection {
  hunks: number[];
}

export interface ApprovalRequest {
  id: string;
  /** 关联的工具调用 id */
  callId: string;
  tool: string;
  /** 需要用户确认的主体内容，例如完整命令行 */
  subject: string;
  cwd?: string;
  reason: string;
  risk: RiskLevel;
  /**
   * 写文件的改动预览。
   * 审批弹窗必须展示它：只看路径与理由不足以判断改动是否安全，
   * 「允许」这个动作的语义是「我读过这份差异了」。
   */
  diff?: FileDiff;
  /**
   * 该次授权是否支持逐 hunk 选择。
   *
   * 由内核侧判定（只有差异可拆成多个 hunk、且不是新建文件时才为 true），
   * 界面据此决定是否渲染勾选框 —— 规则只写一处，界面不重复推断。
   */
  selectable?: boolean;
  createdAt: number;
  expiresAt?: number;
}

export interface ApprovalRecord {
  request: ApprovalRequest;
  decision: ApprovalDecision;
  decidedAt: number;
}

/** 审批网关策略配置 */
export interface GuardPolicy {
  /** 全局档位：auto=安全自动放行；normal=按风险分级；strict=一律确认 */
  mode: 'auto' | 'normal' | 'strict';
  /** 用户勾选「始终允许」后累积的命令前缀 */
  alwaysAllow: string[];
  /** 硬拒绝模式（无论如何都不执行） */
  denyPatterns: string[];
}

export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  mode: 'normal',
  alwaysAllow: [],
  denyPatterns: [
    'rm -rf /',
    'rm -rf /*',
    ':(){:|:&};:',
    'mkfs',
    'dd if=/dev/zero',
    'format ',
    'shutdown',
    'diskpart',
  ],
};
