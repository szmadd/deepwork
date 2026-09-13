import {
  DIFF_MAX_HUNKS,
  type DiffHunk,
  type DiffLine,
  type FileDiff,
} from '@deepwork/protocol';
import { createLogger } from '../logger';

const log = createLogger('diff');

/**
 * 行级差异引擎。
 *
 * 为什么自己写而不是引依赖：
 *  - core-host 是内核宿主，依赖面越小越好（当前运行时依赖为零）；
 *  - 这里需要的是**结构化 hunk**，而常见库直接给 unified diff 字符串，
 *    还得再解析回来，多一层出错面。
 *
 * 算法：Myers O(ND)，先剥公共前后缀再进主循环，最后加规模兜底。
 * 三道防线保证「再慢也不会挂住宿主」：
 *  1. 剥前后缀 —— 局部编辑场景下 N+D 极小，通常是微秒级；
 *  2. 规模阈值 —— 剩余规模超限直接退化为整体替换，不做精细 diff；
 *  3. 结果自检 —— 产物必须能把旧文还原成新文，否则整体替换兜底（见 verifyAndRepair）。
 */

/** hunk 上下文行数，与 git 默认一致 */
const CONTEXT = 3;
/** 剥离前后缀后，剩余规模超过该值就放弃精细 diff */
const MAX_MYERS_SIZE = 8000;

type Op =
  | { type: 'eq'; a: number; b: number }
  | { type: 'del'; a: number }
  | { type: 'ins'; b: number };

/**
 * 切行。
 *
 * 统一按 LF 切分并吞掉 CR，因此纯行尾风格差异（CRLF ↔ LF）不会产生噪音 hunk。
 * 注意：这只是**比较口径**，写入时仍然用调用方给的原始内容，不做行尾改写。
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 是否为二进制内容（含 NUL 字节），二进制不做行级差异 */
export function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}

/** Myers 差分，返回完整的增删改序列 */
function myersOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, index) => ({ type: 'ins' as const, b: index }));
  if (m === 0) return a.map((_, index) => ({ type: 'del' as const, a: index }));

  const max = n + m;
  const offset = max;
  const size = 2 * max + 1;
  const v = new Int32Array(size).fill(-1);
  v[offset + 1] = 0;

  const trace: Int32Array[] = [];
  let foundD = -1;

  for (let d = 0; d <= max; d += 1) {
    // 快照是「第 d 步开始前」的 v，回溯时据此判断上一步是从哪个 k 来的
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD >= 0) break;
  }

  if (foundD < 0) {
    // 理论上不可达（d = max 时必定收敛），保守退化为整体替换
    return [
      ...a.map((_, index) => ({ type: 'del' as const, a: index })),
      ...b.map((_, index) => ({ type: 'ins' as const, b: index })),
    ];
  }

  const ops: Op[] = [];
  let x = n;
  let y = m;

  for (let d = foundD; d > 0; d -= 1) {
    const previous = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = previous[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', a: x - 1, b: y - 1 });
      x -= 1;
      y -= 1;
    }

    if (down) {
      ops.push({ type: 'ins', b: y - 1 });
      y -= 1;
    } else {
      ops.push({ type: 'del', a: x - 1 });
      x -= 1;
    }
  }

  // 剩下的都是公共前缀
  while (x > 0 && y > 0) {
    ops.push({ type: 'eq', a: x - 1, b: y - 1 });
    x -= 1;
    y -= 1;
  }

  ops.reverse();
  return ops;
}

/** 转成带行号的 DiffLine 序列 */
function opsToLines(ops: Op[], a: string[], b: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const op of ops) {
    if (op.type === 'eq') {
      lines.push({ kind: 'context', text: a[op.a], oldLine: op.a + 1, newLine: op.b + 1 });
    } else if (op.type === 'del') {
      lines.push({ kind: 'remove', text: a[op.a], oldLine: op.a + 1 });
    } else {
      lines.push({ kind: 'add', text: b[op.b], newLine: op.b + 1 });
    }
  }
  return lines;
}

/** 按上下文行数归并 hunk，相距过远的变更各自成块 */
function buildHunks(lines: DiffLine[], maxHunks: number): { hunks: DiffHunk[]; truncated: boolean } {
  const changed: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== 'context') changed.push(index);
  });
  if (changed.length === 0) return { hunks: [], truncated: false };

  const ranges: Array<[number, number]> = [];
  let start = Math.max(0, changed[0] - CONTEXT);
  let end = Math.min(lines.length - 1, changed[0] + CONTEXT);

  for (let i = 1; i < changed.length; i += 1) {
    const index = changed[i];
    if (index - CONTEXT <= end) {
      end = Math.min(lines.length - 1, index + CONTEXT);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, index - CONTEXT);
      end = Math.min(lines.length - 1, index + CONTEXT);
    }
  }
  ranges.push([start, end]);

  const truncated = ranges.length > maxHunks;
  const used = truncated ? ranges.slice(0, maxHunks) : ranges;

  const hunks = used.map(([from, to]) => {
    const slice = lines.slice(from, to + 1);
    return {
      oldStart: slice.find((line) => line.oldLine !== undefined)?.oldLine ?? 0,
      oldCount: slice.filter((line) => line.kind !== 'add').length,
      newStart: slice.find((line) => line.newLine !== undefined)?.newLine ?? 0,
      newCount: slice.filter((line) => line.kind !== 'remove').length,
      lines: slice,
    };
  });

  return { hunks, truncated };
}

export interface BuildDiffInput {
  /** 展示用路径（相对工作区，/ 分隔） */
  path: string;
  /** 旧内容；null 表示文件此前不存在 */
  oldText: string | null;
  newText: string;
  maxHunks?: number;
}

/** 构造一份可审阅的文件差异 */
export function buildFileDiff(input: BuildDiffInput): FileDiff {
  const { path, oldText, newText } = input;
  const created = oldText === null;
  const previous = oldText ?? '';

  const base: FileDiff = {
    path,
    created,
    deleted: newText.length === 0 && !created,
    added: 0,
    removed: 0,
    hunks: [],
  };

  if (looksBinary(previous) || looksBinary(newText)) {
    return { ...base, binary: true };
  }

  // 内容完全一致：没有差异，不构造 hunk（调用方可据此跳过审批）
  if (previous === newText) return base;

  const diff = diffLines(previous, newText, input.maxHunks ?? DIFF_MAX_HUNKS);
  const repaired = verifyAndRepair(diff, previous, newText, path);
  repaired.created = created;
  repaired.deleted = newText.length === 0 && !created;
  repaired.path = path;
  return repaired;
}

/** 行级差异 → 带 hunk 的 FileDiff（不含 created/deleted 语义，由 buildFileDiff 补齐） */
function diffLines(previous: string, next: string, maxHunks: number): FileDiff {
  const a = splitLines(previous);
  const b = splitLines(next);

  const hunks = computeHunks(a, b, maxHunks);
  const added = hunks.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'add').length,
    0,
  );
  const removed = hunks.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'remove').length,
    0,
  );

  return {
    path: '',
    created: false,
    deleted: false,
    added,
    removed,
    hunks: hunks.hunks,
    truncated: hunks.truncated,
  };
}

function computeHunks(a: string[], b: string[], maxHunks: number): { hunks: DiffHunk[]; truncated: boolean } {
  // 剥公共前后缀：Agent 的编辑绝大多数是局部改动，这一步把 Myers 的输入压到极小
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const coreA = a.slice(head, a.length - tail);
  const coreB = b.slice(head, b.length - tail);

  let ops: Op[];
  if (coreA.length + coreB.length > MAX_MYERS_SIZE) {
    log.warn(`差异规模过大（${coreA.length}+${coreB.length} 行），退化为整体替换`);
    ops = [
      ...coreA.map((_, index) => ({ type: 'del' as const, a: index })),
      ...coreB.map((_, index) => ({ type: 'ins' as const, b: index })),
    ];
  } else {
    ops = myersOps(coreA, coreB);
  }

  // 拼回前缀/后缀的 context，再转成带全局行号的序列
  const full: Op[] = [
    ...Array.from({ length: head }, (_, index) => ({ type: 'eq' as const, a: index, b: index })),
    // core 内的行号要加上 head 偏移
    ...ops.map((op) =>
      op.type === 'eq'
        ? { type: 'eq' as const, a: op.a + head, b: op.b + head }
        : op.type === 'del'
          ? { type: 'del' as const, a: op.a + head }
          : { type: 'ins' as const, b: op.b + head },
    ),
    ...Array.from({ length: tail }, (_, index) => ({
      type: 'eq' as const,
      a: a.length - tail + index,
      b: b.length - tail + index,
    })),
  ];

  return buildHunks(opsToLines(full, a, b), maxHunks);
}

/**
 * 自检：把 hunk 应用回原文必须得到新文。
 * 不满足就退化为整体替换 —— 宁可给出「整文件重写」这种粗糙但正确的差异，
 * 也不能让用户看到一份错的改动预览。这是审批链路的信任基础。
 */
function verifyAndRepair(diff: FileDiff, previous: string, next: string, label: string): FileDiff {
  // 比对口径必须与 applyDiff 一致：按行序列比，忽略末尾换行与行尾风格差异。
  // 直接用原始字符串比较会把「只有末尾换行差异」的文件判定为不一致，
  // 于是每一份差异都退化成整体替换 —— 自检会因此从「防线」变成「噪音」。
  const expected = splitLines(next).join('\n');
  try {
    if (applyDiff(previous, diff) === expected) return diff;
    log.warn(`差异自检未通过（${label}），退化为整体替换`);
  } catch (error) {
    log.warn(`差异自检异常（${label}）: ${String(error)}`);
  }

  const a = splitLines(previous);
  const b = splitLines(next);
  const lines: DiffLine[] = [
    ...a.map((text, index) => ({ kind: 'remove' as const, text, oldLine: index + 1 })),
    ...b.map((text, index) => ({ kind: 'add' as const, text, newLine: index + 1 })),
  ];
  return {
    ...diff,
    added: b.length,
    removed: a.length,
    truncated: false,
    hunks: lines.length
      ? [
          {
            oldStart: a.length ? 1 : 0,
            oldCount: a.length,
            newStart: b.length ? 1 : 0,
            newCount: b.length,
            lines,
          },
        ]
      : [],
  };
}

/**
 * 把差异应用到旧文本，得到新文本（行序列以 LF 连接，末尾不带换行）。
 *
 * 这个函数有两个用途：
 *  1. 自检（证明生成的差异真的能还原新文）；
 *  2. 「撤销 / 重放」基础 —— 差别在于反向应用即可回滚。
 *
 * 注意：返回值做了行尾规范化，不保留原文件的 CRLF 与末尾换行细节。
 * 若要用于真正回写磁盘，请用 applySelectedHunks（它负责还原行尾形态）。
 */
export function applyDiff(oldText: string, diff: FileDiff): string {
  return applyHunks(oldText, diff, null);
}

/**
 * 按选择应用差异 —— 逐 hunk 授权的落盘实现。
 *
 * @param selection 被采纳的 hunk 下标；**省略表示整体授权**。
 *                  `[]` 表示一个都不采纳，返回内容与原文等价。
 *
 * 三条可核验的等式（它们就是「部分应用没写歪」的定义）：
 *   省略选择   → 结果 == 目标文件（逐字节）
 *   选择为空   → 结果 == 原文（逐字节）
 *   选择为全集 → 结果 == 目标文件（逐字节）
 * 前两条与第三条同时成立，才能说明「选一部分」真的只是「选一部分」。
 *
 * 两个刻意的取舍：
 *
 * 1. **未采纳的 hunk 不做校验。** 直接整块跳过、原样带过，而不是去比对它的上下文行。
 *    理由：用户只对部分改动负责，未采纳部分「当时是否与文件一致」不该影响本次写入；
 *    对它做校验只会让「文件在我看差异之后被别人改过」这种无关状况把这次写入也拖失败。
 *
 * 2. **保留原文件的行尾风格与末尾换行约定。** 内部在规范化空间（LF、无末尾换行）里计算，
 *    最后按原文形态还原。混合行尾的极端文件会被统一成主流行尾 —— 这是个已知的近似，
 *    换来的是「局部改动绝不重写整份文件的行尾」这条更重要的性质。
 *
 * 注意 `applyDiff`（规范化、无末尾换行）与它的分工：那个版本服务于自检与对拍，
 * 需要一个稳定的比较口径；这个版本服务于落盘，需要保住原文件的形态。两者不可互相替代。
 */
export function applySelectedHunks(
  oldText: string,
  diff: FileDiff,
  selection?: number[],
): string {
  const accepted = selection === undefined ? null : new Set(selection);
  const normalized = applyHunks(oldText, diff, accepted);

  const shape = detectShape(oldText);
  if (normalized === '') return '';
  if (shape.eol === '\n') return shape.trailingNewline ? `${normalized}\n` : normalized;
  const body = normalized.split('\n').join(shape.eol);
  return shape.trailingNewline ? `${body}${shape.eol}` : body;
}

/** 只保留被采纳的 hunk，得到一份「即将应用」的差异（用于统计与预览） */
export function pickHunks(diff: FileDiff, selection?: number[]): FileDiff {
  if (selection === undefined) return diff;
  const accepted = new Set(selection);
  const hunks = diff.hunks.filter((_, index) => accepted.has(index));
  return {
    ...diff,
    hunks,
    added: hunks.reduce((sum, hunk) => sum + hunk.lines.filter((l) => l.kind === 'add').length, 0),
    removed: hunks.reduce((sum, hunk) => sum + hunk.lines.filter((l) => l.kind === 'remove').length, 0),
  };
}

/** 被采纳部分的增删统计，用于工具输出「采纳了 N/M 处」 */
export function selectionStat(diff: FileDiff, selection?: number[]): { added: number; removed: number; hunks: number } {
  const picked = pickHunks(diff, selection);
  return { added: picked.added, removed: picked.removed, hunks: picked.hunks.length };
}

/** 行尾形态：主流换行符 + 是否以换行结尾 */
function detectShape(text: string): { eol: '\n' | '\r\n' | '\r'; trailingNewline: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
  return { eol, trailingNewline: text.length > 0 && /(?:\r\n|\r|\n)$/.test(text) };
}

/**
 * 应用差异的核心。
 *
 * @param accepted null 表示全部采纳；否则只采纳集合内的 hunk 下标
 */
function applyHunks(oldText: string, diff: FileDiff, accepted: Set<number> | null): string {
  const oldLines = splitLines(oldText);
  const out: string[] = [];
  let cursor = 0; // 已消费到 oldLines 的哪个位置（0-based）

  diff.hunks.forEach((hunk, index) => {
    if (accepted !== null && !accepted.has(index)) return;

    // hunk 之前的未变更区域原样带过
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunkStart < cursor) throw new Error(`hunk 区间重叠: ${hunk.oldStart}`);
    out.push(...oldLines.slice(cursor, hunkStart));
    cursor = hunkStart;

    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        if (oldLines[cursor] !== line.text) {
          throw new Error(`上下文不匹配（旧文件第 ${cursor + 1} 行）`);
        }
        out.push(line.text);
        cursor += 1;
      } else if (line.kind === 'remove') {
        if (oldLines[cursor] !== line.text) {
          throw new Error(`待删除行不匹配（旧文件第 ${cursor + 1} 行）`);
        }
        cursor += 1;
      } else {
        out.push(line.text);
      }
    }
  });

  out.push(...oldLines.slice(cursor));
  return out.join('\n');
}

/** 把差异压成一行统计文案，供卡片与审批弹窗复用 */
export function diffStat(diff: FileDiff): string {
  if (diff.binary) return '二进制文件';
  if (diff.created) return `新建 · ${diff.added} 行`;
  if (diff.deleted) return `清空 · 删除 ${diff.removed} 行`;
  return `+${diff.added} −${diff.removed}`;
}
