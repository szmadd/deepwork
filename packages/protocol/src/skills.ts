/**
 * 技能系统契约。
 *
 * ── 技能是什么 ──────────────────────────────────────────────────────
 * 技能 = 一个目录：根下 `SKILL.md`（声明元数据与使用说明）+ 任意资源文件
 * （脚本、模板、参考文档）。内核在会话中按「语义匹配 + 显式 `/` 调用」
 * 两种方式触发；安装、审计、启停由宿主管理。
 *
 * ── 审计是不可绕过的安装前置 ────────────────────────────────────────
 * 技能本质上是「别人写的、会在你机器上生效的指令」。安装前必须过审计引擎：
 *   - critical 发现 → 拒绝安装（不落盘，源目录不进家目录）；
 *   - warn 发现 → 允许安装，但发现永久记录在清单里，UI 可展示。
 * 这与写工具的审批网关同一哲学：先让用户看见要发生什么，再发生。
 *
 * ── 版本约定 ────────────────────────────────────────────────────────
 * `version` 是技能作者声明的 semver 字符串（只比较字符串相等性做「同版本
 * 已安装」判断，不做 semver 排序 —— 升级 = 传入不同 version 的同名技能，
 * 覆盖安装并记录升级来源）。
 */

/** SKILL.md frontmatter 里声明、解析后交给宿主与 UI 的元数据 */
export interface SkillManifest {
  /** 技能唯一名（目录名，kebab-case；frontmatter 与目录名不一致时以 frontmatter 为准并拒绝含路径分隔符的值） */
  name: string;
  /** 一句话描述（列表页与语义匹配的输入之一） */
  description: string;
  /** 作者声明的版本 */
  version: string;
  /**
   * 触发提示：作者建议的触发场景描述。
   * 语义匹配由内核侧消费，宿主只透传不解释。
   */
  triggers?: string[];
  /**
   * 作者声明的权限需求（如 'fs-write' | 'net' | 'shell'）。
   * 仅作展示与审计交叉参考 —— 实际权限由审计引擎按文件内容判定，
   * 声明不足不会让危险文件漏网，声明过度也不阻断安装。
   */
  permissions?: string[];
}

/** frontmatter 之外、安装时宿主生成的记录字段 */
export interface SkillRecord {
  manifest: SkillManifest;
  /** 安装来源描述：本地目录绝对路径；URL/市场安装上线后是 URL */
  source: string;
  installedAt: string;
  /** 停用的技能对内核不可见，但文件保留在磁盘（与卸载区分） */
  enabled: boolean;
  /** 安装时的审计发现（warn/info 也会留档，供 UI 展示「这个技能有什么前科」） */
  audit: SkillAuditReport;
}

/** 审计发现级别。critical 阻断安装；warn/info 仅记录。 */
export type SkillAuditSeverity = 'info' | 'warn' | 'critical';

/** 单条审计发现 */
export interface SkillAuditFinding {
  /** 规则标识（如 'dangerous-command'），程序化消费用 */
  rule: string;
  severity: SkillAuditSeverity;
  /** 相对技能根目录的文件路径（SKILL.md 正文发现记为 'SKILL.md'） */
  file: string;
  /** 从 1 开始的行号；文件级发现（如二进制载荷）为 0 */
  line: number;
  /** 人读信息：命中了什么、为什么危险 */
  message: string;
  /** 命中行原文（去除首尾空白后），空串表示文件级发现 */
  snippet: string;
}

/** 安装前审计报告 */
export interface SkillAuditReport {
  /** 发现列表，按 severity 降序、行号升序 */
  findings: SkillAuditFinding[];
  /** 扫描过的文本文件数（不含跳过的二进制） */
  scannedFiles: number;
  /** 技能目录总字节数 */
  totalBytes: number;
  /** 审计时刻（ISO 8601） */
  auditedAt: string;
}

/** 安装结果：要么成功带回记录，要么被 critical 阻断并给出报告 */
export interface SkillInstallResult {
  ok: boolean;
  /** ok=false 且被审计阻断时给出完整报告；成功时与记录内的 audit 相同 */
  audit: SkillAuditReport;
  /** ok=true 时非空 */
  record?: SkillRecord;
  /** ok=false 时的人读原因 */
  reason?: string;
}

/**
 * 一次运行中被挂载进内核上下文的技能。
 *
 * 两种挂载方式：
 *  - 环境注入（explicit=false）：每轮把启用技能的「名称/描述/触发提示/SKILL.md 路径」
 *    摘要带给内核，由内核决定要不要去读全文（语义匹配是内核侧职责）；
 *  - 显式调用（explicit=true）：用户输入以 `/技能名` 开头，该技能的 SKILL.md 正文
 *    全文随本轮注入（受体积上限截断）。
 */
export interface SkillAttachment {
  name: string;
  version: string;
  explicit: boolean;
  /** 实际注入的正文长度（字符）；环境注入为 0（只带摘要） */
  bodyChars: number;
  /** 正文是否因体积上限被截断 */
  truncated: boolean;
}
