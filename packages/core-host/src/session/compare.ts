/**
 * 分支对比（M1 遗留：分支对比视图 / 同名文件差异并排）。
 *
 * ── 对比的是「改动」，不是「文件」────────────────────────────────────
 * 分叉共享同一个工作区（分叉复制的是会话日志，不是文件系统快照，见
 * host.forkSession），所以磁盘上不存在「左分支的 a.ts」与「右分支的 a.ts」
 * 两个版本 —— 去读文件只能读到同一份，对比恒为空。
 *
 * 真正存在两份的东西是**改动本身**：写工具执行前的差异预览（mock 与宿主工具
 * 走 `tool.started.call.diff`）、以及真实内核写文件前的审批请求
 * （`approval.requested.request.diff`）。两类都要收 —— 只看其中一类，
 * 在另一种适配器下对比会静默变成空的，而「空」在这里会被读成「两边没冲突」。
 *
 * ── 每个文件以「最后一次改动」为准 ──────────────────────────────────
 * 同一路径可能被改多次。逐次平铺会让对比区变成一长串同一文件的历史，
 * 而用户在这里要回答的是「两条分支最终各自把这个文件改成了什么」。
 * 最后一次之前的那些不丢：它们仍在会话日志（轨迹视图）里。
 */

import type {
  AgentEvent,
  BranchCompareResult,
  BranchCompareSide,
  BranchFileEntry,
  FileDiff,
  Session,
} from '@deepwork/protocol';

/** 从事件里取出它携带的文件改动；不带差异的事件返回 null */
function diffOf(event: AgentEvent): FileDiff | null {
  if (event.type === 'approval.requested') return event.request.diff ?? null;
  if (event.type === 'tool.started') return event.call.diff ?? null;
  return null;
}

/** 路径 → 该分支对它的最后一次改动（事件序即时间序） */
export function collectLastDiffs(events: AgentEvent[]): Map<string, FileDiff> {
  const map = new Map<string, FileDiff>();
  for (const event of events) {
    const diff = diffOf(event);
    // 后写覆盖先写：日志按 seq 追加，所以最后落进 map 的就是最后一次改动
    if (diff) map.set(diff.path, diff);
  }
  return map;
}

/**
 * 对比两条分支。
 *
 * 两个来源都必须在场（由调用方保证）：这里不做存在性校验，也不知道
 * 「谁是分叉出来的那条」—— 那属于会话管理，不属于差异计算。
 */
export function compareBranches(input: {
  left: { session: Session; events: AgentEvent[] };
  right: { session: Session; events: AgentEvent[] };
}): BranchCompareResult {
  const leftDiffs = collectLastDiffs(input.left.events);
  const rightDiffs = collectLastDiffs(input.right.events);

  const shared: BranchFileEntry[] = [];
  const leftOnly: BranchFileEntry[] = [];
  const rightOnly: BranchFileEntry[] = [];

  for (const [path, diff] of leftDiffs) {
    const other = rightDiffs.get(path);
    if (other) shared.push({ path, left: diff, right: other });
    else leftOnly.push({ path, left: diff });
  }
  for (const [path, diff] of rightDiffs) {
    if (!leftDiffs.has(path)) rightOnly.push({ path, right: diff });
  }

  const byPath = (a: BranchFileEntry, b: BranchFileEntry): number => a.path.localeCompare(b.path);
  shared.sort(byPath);
  leftOnly.sort(byPath);
  rightOnly.sort(byPath);

  return {
    left: sideOf(input.left.session, leftDiffs.size),
    right: sideOf(input.right.session, rightDiffs.size),
    shared,
    leftOnly,
    rightOnly,
    basis:
      '取自两条会话日志中带差异预览的事件（写工具的改动预览与真实内核的写审批请求），' +
      '每个文件以最后一次改动为准；分叉共享同一工作区，所以这里对比的是改动而不是磁盘文件。',
  };
}

function sideOf(session: Session, changedFiles: number): BranchCompareSide {
  return {
    sessionId: session.id,
    title: session.title,
    changedFiles,
    ...(session.fork ? { forkedFrom: session.fork.sessionId } : {}),
  };
}
