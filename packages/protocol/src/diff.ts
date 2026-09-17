/**
 * 文件差异模型 —— 写操作的「可审阅表达」。
 *
 * 为什么差异要进契约，而不是留在文件系统里：
 *
 *  Agent 能改代码之后，「改动」本身就是最需要用户看见的东西。
 *  如果只看得到「已写入 xxx.ts」，用户无法判断这次改动是否越界、是否夹带了删除。
 *  因此写类工具必须在**执行之前**产出一份差异，先给用户看、拿到授权，再落盘。
 *
 * 形态选择：
 *  这里存的是**结构化 hunk**，不是一段 unified diff 字符串。
 *  字符串会让 UI 必须自己再解析一次（反引号、转义、行号都要重算），
 *  结构化数据既能渲染，也能直接算增删统计，回放时也稳定。
 */

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  /** 行内容（不含行尾换行符） */
  text: string;
  /** 该行在旧文件中的行号（context / remove 有值） */
  oldLine?: number;
  /** 该行在新文件中的行号（context / add 有值） */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  /** 相对工作区的路径，统一用 / 分隔，便于跨平台展示 */
  path: string;
  /** 目标文件此前不存在（本次为新建） */
  created: boolean;
  /** 目标文件被清空 / 删除 */
  deleted: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** 差异规模超出上限，只保留了前面的 hunk */
  truncated?: boolean;
  /** 原文件被判定为二进制或不可安全解码，不做行级差异 */
  binary?: boolean;
}

/** 工具执行前的副作用预览。目前只有文件差异一种形态，保留包装以便后续扩展（如网络外发预览）。 */
export type ToolPreview = { kind: 'diff'; diff: FileDiff };

/** 一次差异的规模上限，超出则截断，避免把超大文件塞进事件流与日志 */
export const DIFF_MAX_HUNKS = 60;

// ════════════════════════════════════════════════════════════════
// 分支对比（M1 遗留：分支对比视图 / 同名文件差异并排）
// ════════════════════════════════════════════════════════════════

/** 对比的一侧：一条分支自己的改动 */
export interface BranchCompareSide {
  sessionId: string;
  title: string;
  /** 这条分支改过的文件数（按路径去重） */
  changedFiles: number;
  /** 从哪个会话分叉来的；非分叉会话为空 */
  forkedFrom?: string;
}

/** 一个文件在两个分支里的改动 */
export interface BranchFileEntry {
  path: string;
  /** 左分支对该文件**最后一次**改动；该分支没碰过则为空 */
  left?: FileDiff;
  /** 右分支对该文件最后一次改动 */
  right?: FileDiff;
}

/**
 * 分支对比结果。
 *
 * ── 为什么数据源是「写工具的差异预览」而不是「两边的工作区文件」──────
 * 本产品的分叉共享**同一个工作区**：分叉复制的是会话日志，不是文件系统快照
 * （见 host.forkSession）。所以磁盘上根本不存在「左分支的 a.ts」与
 * 「右分支的 a.ts」两个版本 —— 去读文件只能读到「最后写成的那个」，
 * 两边永远是同一份，对比恒为空。
 *
 * 真实存在的两份东西是**两次改动本身**（`tool.started` 里带出来的差异预览）。
 * 「同名文件差异并排」因此实现为：把两条分支对同一个路径的改动并排摊开。
 * 这不是退而求其次 —— 它恰好是用户想看的那个问题：「同一个文件，
 * 这条分支改了什么、那条分支改了什么」。
 *
 * `basis` 如实说明这个结论的取数范围（哪些事件、以哪一次为准），
 * 界面直接展示 —— 它是「这份对比有多完整」的唯一线索。
 */
export interface BranchCompareResult {
  left: BranchCompareSide;
  right: BranchCompareSide;
  /** 两边都改过的文件 —— 并排展示的主体 */
  shared: BranchFileEntry[];
  /** 只有左 / 右分支改过的文件（单列展示，不并排） */
  leftOnly: BranchFileEntry[];
  rightOnly: BranchFileEntry[];
  basis: string;
}
