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
