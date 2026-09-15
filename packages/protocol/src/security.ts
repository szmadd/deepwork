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

/**
 * 内核沙箱的逐调用**文件**策略模式。
 *
 * ── 与 `GuardPolicy` 是两层，别混────────────────────────────────────
 * `GuardPolicy.mode`（auto/normal/strict）回答的是「**哪些命令要问人**」，
 * 由宿主侧的静态规则匹配决定；这个 `SandboxMode` 回答的是「**命令能对文件做什么**」，
 * 由**内核**在执行时强制执行。两者都叫「权限」，但一个管「问不问」，
 * 一个管「做不做得成」—— 一个命令可以既被批准、又写不成（被沙箱拒）。
 *
 * ── 词汇来自内核，不要自造 ──────────────────────────────────────────
 * 这三个值是 `dsh-sandbox-policy` 的 `mode` 字段，与 `dsh-permission-presets`
 * 的三个预置同名。产品侧只做透传与呈现，不另起一套名字：一旦两处词汇不同步，
 * 界面上显示的档位与内核实际执行的档位就会是两件事。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** 内核沙箱模式的三个合法值，顺序与内核 README 的表格一致（由窄到宽） */
export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

/**
 * 该模式是谁定的。
 *
 * 模式只在**内核启动**时生效（`dsh-sandbox-policy` 的 `mode` 是插件配置，
 * 而 ACP 侧没有暴露它的运行时切换 —— 见 `dsh-acp` README「不支持界面」一节），
 * 所以「当前值从哪来」必须由宿主记住并交出来，界面才有的可说。
 */
export type SandboxModeSource = 'product-default' | 'env-override';

export interface SandboxStatus {
  /** 内核进程启动时拿到的模式 */
  mode: SandboxMode;
  /** 该值的来源 */
  source: SandboxModeSource;
  /**
   * 覆盖值给了但不可用时留下的原值。
   *
   * 有值时说明「有人想设一个模式，但那个值不合法，实际用的是默认值」——
   * 界面必须把它显示出来。静默回落到默认会让设错的人以为自己的设置生效了，
   * 而权限这类设置上「以为生效了」正是最不该出现的状态。
   */
  rejected?: string;
  /**
   * 该平台的已知边界说明（没有已知边界时为 undefined）。
   *
   * 由宿主按平台填好交给界面 —— 渲染层不自己按平台分支写文案：那些边界是
   * 内核包自述的**平台事实**（win32 档报告 partial 强制执行，只交叉检查写访问），
   * 它属于知识而不是判断，放一处才不会与实现漂移。
   *
   * 注意它是**平台级事实**，不是运行时测量值：ACP 面不暴露强制执行等级，
   * 所以这里不会出现「实测 full/partial」这种字样。
   */
  note?: string;
}
