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

// ════════════════════════════════════════════════════════════════
// 技能来源（本地目录 / URL）
// ════════════════════════════════════════════════════════════════

/**
 * 技能源的种类。
 *
 * ── 为什么只有这两种（M2-C 遗留的「技能市场 URL 安装源」）────────────
 * 安装流程的关键一步是**审计前置**：任何来源都必须先落到一个本地目录、
 * 过完审计、再拷进技能目录。所以「来源」这件事只需要回答一个问题：
 * 怎么把它变成本地目录。本地目录是零成本的那一种，URL 是另一种 ——
 * 其余形态（git 仓库、市场 API）本质上都是「先下载再解包」的特例。
 *
 * git 刻意不做：它会引入凭据（私库）、需要外部 git 二进制、且内网里
 * 多半只能走 http(s) 的静态分发包。真要做，正确的路径是先下载归档
 * （zip），也就是已经支持的那条。
 */
export type SkillSourceKind = 'local-dir' | 'url';

export const SKILL_SOURCE_LABEL: Record<SkillSourceKind, string> = {
  'local-dir': '本地目录',
  url: '网络地址',
};

/**
 * 协议头判定。
 *
 * 为什么不能简单用 `^https?://`：那样 ftp / data / file 都会落到「本地目录」，
 * 于是用户拿到的是**误导性**的报错（「来源目录不存在：ftp:\x\y」），
 * 而真正的问题是「这个协议我们不支持」。
 *
 * 也不能简单用 `^[a-z]+:`：Windows 盘符（`C:\a`、`D:/x`）长着一模一样的开头。
 * 判据因此是「协议名长度 ≥ 2」—— 盘符恒为单个字母。
 */
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function schemeOf(source: string): string | null {
  const match = SCHEME_RE.exec(source.trim());
  if (!match) return null;
  if (match[1].length === 1) return null; // 单字母 = 盘符，不是协议
  return match[1].toLowerCase();
}

/** 判定来源种类。不做 URL 可达性检查 —— 那是拉取层的事 */
export function classifySkillSource(source: string): SkillSourceKind {
  return schemeOf(source) ? 'url' : 'local-dir';
}

/**
 * 校验来源，返回人读错误；合法返回 null。
 *
 * 只接受 http/https：`file://` 看着像 URL 其实是本地路径（本地目录那条路
 * 更直接，直接填路径即可），而其它协议（ftp / data / …）我们没有能力安全地
 * 拉取 —— 与其让它们走到下载器里失败，不如在这里说清楚。
 */
export function validateSkillSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return '技能来源不能为空';
  const scheme = schemeOf(trimmed);
  if (!scheme) return null; // 本地路径：是否存在由拉取层判断
  if (scheme !== 'http' && scheme !== 'https') {
    return `不支持的协议 ${scheme}: —— 只接受 http / https；本地目录请直接填路径（不要 ${scheme}:// 前缀）`;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `网络来源不是一个合法地址：${trimmed}`;
  }
  if (!parsed.hostname) return '网络来源缺少主机名';
  return null;
}

/** 一次来源拉取的结果摘要（写进 SkillRecord.source 的说明里，供界面展示） */
export interface SkillSourceDigest {
  kind: SkillSourceKind;
  /** 用户给的原值（本地路径或 URL） */
  source: string;
  /** 实际落成的形态：整包解压 / 单个 SKILL.md / 直接使用本地目录 */
  shape: 'directory' | 'zip' | 'skill-md';
  /** 解包后剥掉的顶层目录名（GitHub 归档的 `repo-main/` 那种壳）；没有则为空 */
  strippedRoot?: string;
  /** 下载字节数（本地目录为 0） */
  bytes: number;
}

/**
 * 来源摘要的人读文案。
 *
 * 放在契约层而不是界面里：它同时出现在安装结果、技能列表的「来源」一栏
 * 以及日志里，三处各写一遍必然漂 —— 而这里漂掉的后果是同一份来源
 * 在两个地方读起来像两件事。
 */
export function describeSkillSource(digest: SkillSourceDigest): string {
  if (digest.kind === 'local-dir') return `本地目录 ${digest.source}`;
  const shape = digest.shape === 'zip' ? 'zip 归档' : '单个 SKILL.md';
  const stripped = digest.strippedRoot ? `，已剥掉顶层目录 ${digest.strippedRoot}` : '';
  return `${digest.source}（${shape}，${digest.bytes} 字节${stripped}）`;
}

/** SKILL.md frontmatter 里声明、解析后交给宿主与 UI 的元数据 */
export interface SkillManifest {
  /** 技能唯一名（目录名，kebab-case；frontmatter 与目录名不一致时以 frontmatter 为准并拒绝含路径分隔符的值） */
  name: string;
  /** 一句话描述（列表页与语义匹配的输入之一） */
  description: string;
  /** 作者声明的版本（semver 写法，manifest 层强制校验：x.y.z，可带 -/+ 后缀） */
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
  /**
   * SKILL.md 清单解析结果（干跑审计路径也会给出）。
   *
   * 存在 manifestError 时这个包根本装不上 —— 必须在用户确认安装**之前**
   * 暴露，而不是等他点完「确认安装」才看到「清单不合法」。manifest 解析成功时
   * 附带 name/version，让确认页能显示「将要安装的是哪个技能」。
   */
  manifest?: SkillManifest;
  /** 清单解析失败的人读原因；与 manifest 互斥 */
  manifestError?: string;
}

/**
 * 安装结果：要么成功带回记录，要么被 critical 阻断并给出报告。
 */
export interface SkillInstallResult {
  ok: boolean;
  /** ok=false 且被审计阻断时给出完整报告；成功时与记录内的 audit 相同 */
  audit: SkillAuditReport;
  /** ok=true 时非空 */
  record?: SkillRecord;
  /** ok=false 时的人读原因 */
  reason?: string;
  /**
   * 同名同 version 重复安装时为 true：磁盘与清单不做任何改动，
   * record 是已存在的那条。契约承诺「只比较字符串相等性做同版本已安装判断」，
   * 兑现就在这里 —— 不让重复安装伪装成一次全新的「安装成功」。
   */
  reinstalled?: boolean;
  /**
   * 来源拉取的摘要（仅 URL 来源有值）。
   *
   * 它必须回给调用方而不只是写进日志：URL 安装有两个用户看不见的中间步骤
   * （下载、剥掉顶层目录），出问题时「下载到的是不是我以为的那个东西」
   * 是第一个要回答的问题。界面上据此显示「从 X 下载了 N 字节、按 zip 解包、
   * 剥掉顶层目录 repo-main」，而不是只说一句「安装成功」。
   */
  source?: SkillSourceDigest;
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

// ════════════════════════════════════════════════════════════════
// Composer 的 `/` 补全（M2-D 遗留）
// ════════════════════════════════════════════════════════════════

/** 补全候选项 —— 只有最小必要信息，界面不再去翻 manifest */
export interface SkillCommandCandidate {
  name: string;
  description: string;
  version: string;
}

export interface SkillCommandCompletion {
  /** 替换区间 `[start, end)`；end 即光标位置 */
  start: number;
  end: number;
  /** 已输入的名字片段（不含 `/`），可能是空串 */
  query: string;
  candidates: SkillCommandCandidate[];
}

/**
 * 技能名允许的字符。
 *
 * 与内核侧 `EXPLICIT_RE`（`^\/([a-z0-9][a-z0-9-]*)(?=\s|$)`）口径一致，
 * 但在补全阶段刻意**放宽大小写**：用户手打 `/Work` 时仍应给出 `/workspace-check`
 * 这个候选（插入的永远是技能自己的规范名），而不是因为没有小写而一个候选都不给。
 * 「开头必须是小写字母或数字」这条也放宽到补全阶段不判 —— 打错的字符让候选为空，
 * 用户自己会看出来，这里报错反而打断输入。
 */
const SKILL_NAME_FRAGMENT_RE = /^[A-Za-z0-9_-]*$/;

/**
 * 算出此刻该不该弹技能补全。
 *
 * ── 为什么只在「文本的第一个词」上补 ───────────────────────────────
 * 显式调用只认开头的 `/技能名`（内核侧 EXPLICIT_RE 锚在 `^`）。如果用户在
 * 「看一下 /work」这种位置也弹出候选，他选中之后**什么也不会发生** ——
 * 补全把一个不会生效的东西写进了输入框。补全存在的意义是「省去记住名字」，
 * 而不是「提示这里能打斜杠」。所以：位置不对就不给候选，而不是给了再解释。
 *
 * 返回 null 表示「不显示补全」：不是 `/` 开头、名字已写完（后面出现空白）、
 * 出现了不可能是技能名的字符、或一个候选都没匹配上 —— 这几种情况下
 * 弹一个空气泡比不弹更糟。
 */
export function skillCommandCompletion(input: {
  text: string;
  caret: number;
  skills: SkillRecord[];
}): SkillCommandCompletion | null {
  const caret = Math.max(0, Math.min(input.caret, input.text.length));
  const head = input.text.slice(0, caret);
  if (!head) return null;

  const lead = head.length - head.trimStart().length;
  const token = head.slice(lead);
  if (!token.startsWith('/')) return null;

  const query = token.slice(1);
  // 名字与参数之间有空白 = 名字已写完（`/workspace-check 看一下`），不再补全
  if (/\s/.test(query)) return null;
  if (!SKILL_NAME_FRAGMENT_RE.test(query)) return null;

  const lowered = query.toLowerCase();
  const candidates = input.skills
    .filter((record) => record.enabled)
    .filter((record) => record.manifest.name.toLowerCase().startsWith(lowered))
    .map((record) => ({
      name: record.manifest.name,
      description: record.manifest.description,
      version: record.manifest.version,
    }))
    // 名字短的排前面：输入 `/a` 时 `/a` 比 `/abc-long` 更可能是想找的那个
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));

  if (candidates.length === 0) return null;
  return { start: lead, end: caret, query, candidates };
}

/**
 * 应用一个候选：把 `[start, end)` 换成 `/名字 `（**带尾随空格**）。
 *
 * 尾随空格是刻意的：`/workspace-check` 后面紧跟内容时，内核侧的正则要求
 * 名字后面必须是空白或行尾，否则整段退化成环境注入（没有报错，只是那个技能
 * 的正文没进来）。补上空格，用户接着打参数就自然是对的。
 *
 * 光标停在空格之后，用户可以直接继续输入任务描述。
 */
export function applySkillCommandCompletion(
  text: string,
  completion: SkillCommandCompletion,
  name: string,
): { text: string; caret: number } {
  const inserted = `/${name} `;
  const next = text.slice(0, completion.start) + inserted + text.slice(completion.end);
  return { text: next, caret: completion.start + inserted.length };
}
