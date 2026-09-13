/**
 * Office 文档能力契约（M2-I）。
 *
 * ── 三条产品判断 ───────────────────────────────────────────────
 *
 * 1. **生成侧只承诺一件事：写出来的文件能被真实 Office / WPS 打开。**
 *    不为格式完备性买单（不做修订、公式、图表、母版），但绝不自造私有格式 ——
 *    那等于交付一个「只有本机能开」的文件，是最坏的一种「能用」。
 *    docx / xlsx 都是 zip + XML 的公开规范（OOXML），按规范拼最小可用形态即可。
 *
 * 2. **零第三方依赖。** docx / xlsx / ofd 三者本质都是 zip + XML：
 *    zip 用 node:zlib 手写，XML 用最小生成器 / 抽取器拼。理由与浏览器同源
 *    （「装完就能跑」是硬约束），并且额外避开两条供应链风险：xlsx 系库的许可与
 *    官方源迁移、以及「为了写一个表格引入几十个传递依赖」。
 *    先例：`tools/make-icon.js` 手写 PNG 编码器，效果可验收。
 *
 * 3. **读侧原生支持 OFD。** OFD 是国标版式文档（GB/T 33190-2016），
 *    在票据、公文、电子证照场景里是法定格式，而主流文档库对它的支持远不如 PDF。
 *    「原生」的界定很具体：不调外部转换器、不装第三方库、不依赖 WPS/Adobe，
 *    直接按规范解包取文本。这条能力顺带回补了生成侧 —— 写出去的文档能被自己读回来
 *    （审批弹窗里的「内容视图」就是靠它算出来的）。
 *
 * ── 一条看不见的纪律 ──────────────────────────────────────────
 * `office.docx` / `office.xlsx` 会落盘二进制包，**字节不进事件日志**（与终端、
 * 浏览器截图同源）。事件流里只留路径、类型、字节数与内容视图的文本差异。
 */

import type { RiskLevel } from './security';

/** 生成 Word 文档（.docx） */
export const OFFICE_DOCX_TOOL = 'office.docx';
/** 生成 Excel 工作簿（.xlsx） */
export const OFFICE_XLSX_TOOL = 'office.xlsx';
/** 读取文档（.ofd 原生解析；.docx / .xlsx / 文本同理） */
export const OFFICE_READ_TOOL = 'office.read';

export type OfficeTool = 'office.docx' | 'office.xlsx' | 'office.read';

export const OFFICE_TOOLS: readonly OfficeTool[] = [OFFICE_DOCX_TOOL, OFFICE_XLSX_TOOL, OFFICE_READ_TOOL];

/**
 * 读侧**原生解析**的扩展名。
 *
 * 不在此列的文件按 UTF-8 文本读 —— 这比「不支持该格式」更有用：
 * 模型把 .csv 当表格读、把 .md 当笔记读都是合理动作，没必要为每个扩展名开一个工具。
 * 但反过来，认不出的**二进制**（.pdf / .zip / 图片）必须明确拒绝，
 * 不能让模型拿到一段乱码还以为读到了内容。
 */
export const OFFICE_NATIVE_EXTENSIONS = ['.ofd', '.docx', '.xlsx'] as const;

/** 按纯文本读取的扩展名（白名单；未列出的二进制一律拒绝） */
export const OFFICE_TEXT_EXTENSIONS = [
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.log',
  '.xml',
  '.yaml',
  '.yml',
] as const;

export type OfficeNativeKind = 'ofd' | 'docx' | 'xlsx';
export type OfficeDocKind = OfficeNativeKind | 'text';

/**
 * 读回的文本上限。
 *
 * 20k 字符与浏览器 `content` 同量级：文档全文进不了上下文没有意义，
 * 而把一份 200 页的公文整段塞进事件流会直接吃掉当轮的预算。
 */
export const OFFICE_TEXT_LIMIT = 20_000;

/**
 * 待解析文件的体积上限。
 *
 * 这道闸不是性能优化，是**安全边界**：OFD / docx 都是 zip，
 * 一个 5KB 的包可以解出 10GB（zip bomb）。两条一起卡：
 * 包本身 ≤ 40MB，单条目解压后 ≤ 8MB，且条目总数 ≤ 2048。
 */
export const OFFICE_MAX_BYTES = 40 * 1024 * 1024;
export const OFFICE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const OFFICE_MAX_ENTRIES = 2048;

/** 生成侧的规模上限（超过就报错，而不是悄悄截断一半数据） */
export const OFFICE_MAX_ROWS = 20_000;
export const OFFICE_MAX_COLS = 256;
/** 单元格文本上限（Excel 自身是 32767） */
export const OFFICE_MAX_CELL_CHARS = 32_000;

/**
 * 工具风险档。
 *
 * 写类与前缀确认一致（confirm）；`office.read` 只读、且被工作区边界约束，
 * 与 `fs.read` 同级（safe）—— 给读操作加审批只会训练用户闭眼点「允许」。
 */
export const OFFICE_TOOL_RISK: Record<OfficeTool, RiskLevel> = {
  [OFFICE_DOCX_TOOL]: 'confirm',
  [OFFICE_XLSX_TOOL]: 'confirm',
  [OFFICE_READ_TOOL]: 'safe',
};

/** 生成结果。`bytes` 是实际落盘字节数（不是文本长度，文本是它的视图）。 */
export interface OfficeWriteResult {
  /** 相对工作区的路径，/ 分隔 */
  path: string;
  kind: OfficeNativeKind;
  bytes: number;
  created: boolean;
  /** 供审批与回执使用的规模摘要，例如「12 段 / 3 标题 / 1 表格」 */
  summary: string;
}

/** 读取结果。`blocks` 是取到的段落或单元格数，用来区分「文档是空的」与「解析失败了」。 */
export interface OfficeReadResult {
  path: string;
  kind: OfficeDocKind;
  text: string;
  truncated: boolean;
  /** 页数（OFD 的 Page 数 / docx 的显式分页数）；取不到就不给这个字段 */
  pages?: number;
  blocks?: number;
}

/**
 * 扩展名 → 文档类型。
 *
 * 大小写不敏感：Windows 上 .OFD / .OFd 都真实存在，而扩展名判断一旦漏了大小写，
 * 症状是「同一个文件换个写法就读不出来了」。
 */
export function officeDocKindOf(ext: string): OfficeDocKind | null {
  const lower = ext.toLowerCase();
  if ((OFFICE_NATIVE_EXTENSIONS as readonly string[]).includes(lower)) {
    return lower.slice(1) as OfficeNativeKind;
  }
  if ((OFFICE_TEXT_EXTENSIONS as readonly string[]).includes(lower)) return 'text';
  return null;
}

/** 原生解析支持人类可读的列举（供工具描述与错误文案复用） */
export function officeNativeExtensionList(): string {
  return OFFICE_NATIVE_EXTENSIONS.join(' / ');
}
