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
  /**
   * 这次授权其实是**模型在申请放宽沙箱档位**（有值时界面必须讲清楚）。
   *
   * ── 为什么不能只说「内核请求授权」────────────────────────────────────
   * 内核走 ACP 发权限请求时，参数里只有 `toolCall.toolCallId` 与两个选项
   * （allow_once / reject_once）—— 模型的升级理由在过 ACP 时**丢了**。
   * 而用户此刻要判断的问题恰恰是「该不该为这一次操作放宽档位」，
   * 只给一个「允许/拒绝」等于让他盲批：他既不知道这是在申请升级，
   * 也不知道模型为什么要升级。
   *
   * 幸运的是入参没有丢：`tool_call` 通知里的 `rawInput` 带着
   * `sandbox_permissions` 与 `justification` 两个字段（见 `parseSandboxEscalation`），
   * 适配器据此把它补回审批请求里。
   */
  escalation?: SandboxEscalation;
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

/**
 * 内核沙箱拒绝的识别结果（从工具输出里读出来的）。
 *
 * ── 为什么要有它：拒绝是一句英文错误串，用户不该自己翻译 ────────────────
 * 2026-09-15 端到端取证（tools/sandbox-e2e.js）拿到的真帧：
 *
 *   Error: [sandbox: file access denied under workspace-write mode]
 *   [sandbox: escalation available — retry this exact operation once with
 *    sandbox_permissions (the narrowest wider mode that suffices) + justification;
 *    the approval prompt asks the user]
 *
 * 在那之前，界面上它就是一坨 `Error: ...`（ToolCard 的「输出（失败）」）。
 * 用户看到的是「写文件失败了」，而事实是「**被你自己设的档位拦下了**」——
 * 这两句话指向完全不同的下一步动作，前者会让你去查磁盘权限，后者会让你去改档位。
 */
export interface SandboxDenial {
  /**
   * 内核声明的有效档位。**原样保留，不做白名单过滤。**
   *
   * 内核将来加第四档时，这里会拿到一个我们不认识的值 —— 那时界面应该照实显示
   * 并提示「可能是内核新增的档位」，而不是因为不认识就当成「没有拒绝」。
   * 把一个不认识的事实丢掉，比多显示一个陌生字符串危险得多。
   */
  mode: string;
  /** mode 是否落在当前已知词汇（`SANDBOX_MODES`）里 */
  knownMode: boolean;
  /**
   * 内核是否随拒绝给出了升级路径。
   *
   * 有它意味着「拦住」不是终点：模型可以带一次 `sandbox_permissions` 重试同一操作，
   * **那时才会**出现问用户的审批弹窗（`the approval prompt asks the user`）。
   * 界面据此可以如实说明「它还留了一跳」，而不是让用户以为此路不通。
   */
  escalation: boolean;
}

/**
 * 升级重试所用的工具入参名。
 *
 * 真帧里就是这个字面量（`sandbox_permissions`）。记成常量而不是散落的字符串：
 * 它是内核契约的一部分，内核改名的那天，只有引用它的地方会一起被找出来。
 */
export const SANDBOX_ESCALATION_ARG = 'sandbox_permissions';

/**
 * 与升级参数成对出现的「理由」入参名。
 *
 * 内核的 `validateEscalationArgs` 把它们绑成一对：缺一个就报
 * `invalid escalation: sandbox_permissions requires a justification`。
 * 也就是说这个字段不是可选的装饰 —— 它是模型**写给用户的那一句话**。
 */
export const SANDBOX_JUSTIFICATION_ARG = 'justification';

/**
 * 模型发起的沙箱升级申请（从工具入参里读出来的）。
 *
 * 与 `SandboxDenial` 是一对：那个是「结果里怎么说」，这个是「模型怎么申请」。
 * 中间那一跳（被拒之后的那次重试）此前从未在本机被观测到过 ——
 * 只有真的跑一遍才知道模型到底把申请写在哪。
 */
export interface SandboxEscalation {
  /**
   * 模型申请的档位。**原样保留**，理由与 `SandboxDenial.mode` 相同：
   * 内核的档位词汇将来可能变宽，丢掉不认识的值等于把「它在申请什么」抹掉。
   */
  mode: string;
  /** mode 是否落在当前已知词汇（`SANDBOX_MODES`）里 */
  knownMode: boolean;
  /** 模型写给用户的理由；内核要求它非空，但缺字段时这里退化成空串而不是拒绝 */
  justification: string;
}

/**
 * 从工具入参里识别「模型在申请放宽沙箱档位」。
 *
 * 判据是 `sandbox_permissions` 字段存在且为非空字符串 —— 只要有它，这次调用就是
 * 一次升级申请（内核的校验保证它必然带理由）。不是升级申请就返回 `null`，
 * 与 `parseSandboxDenial` 同样拒绝「看起来像」的兜底猜测：
 * 把一次普通写入说成「模型在申请放宽权限」，会让用户在最该警惕的地方看到假警报。
 */
export function parseSandboxEscalation(rawInput: unknown): SandboxEscalation | null {
  if (!rawInput || typeof rawInput !== 'object') return null;
  const args = rawInput as Record<string, unknown>;
  const mode = args[SANDBOX_ESCALATION_ARG];
  if (typeof mode !== 'string' || !mode.trim()) return null;
  const justification = args[SANDBOX_JUSTIFICATION_ARG];
  return {
    mode: mode.trim(),
    knownMode: (SANDBOX_MODES as readonly string[]).includes(mode.trim()),
    justification: typeof justification === 'string' ? justification.trim() : '',
  };
}

/** 拒绝行的形状。`under <mode> mode` 里的 mode 允许未知值（见 SandboxDenial.mode）。 */
const SANDBOX_DENIAL_RE = /\[sandbox:\s*file access denied under\s+([A-Za-z][A-Za-z0-9_-]*)\s+mode\]/;
/** 升级提示行的形状。它单独出现没有意义，只有与拒绝行同现才算数。 */
const SANDBOX_ESCALATION_RE = /\[sandbox:\s*escalation available/;

/**
 * 从一段工具输出里识别「被内核沙箱拦下」。
 *
 * 不是沙箱拒绝就返回 `null` —— 绝不用「看起来像」去兜：普通工具失败与沙箱拒绝
 * 在界面上必须区分，误判会把「代码写错了」说成「权限被拦了」，用户会去改档位，
 * 然后问题依旧。参照物是 tools/sandbox-e2e.js 当场跑出来的真帧，不是手抄的样本。
 */
export function parseSandboxDenial(output: string): SandboxDenial | null {
  const matched = SANDBOX_DENIAL_RE.exec(output);
  if (!matched) return null;
  const mode = matched[1];
  return {
    mode,
    knownMode: (SANDBOX_MODES as readonly string[]).includes(mode),
    escalation: SANDBOX_ESCALATION_RE.test(output),
  };
}
