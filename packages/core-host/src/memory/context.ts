/**
 * 记忆上下文构建：把三层记忆变成本轮运行的注入文本。
 *
 * ── 三层各自的角色 ──────────────────────────────────────────────────
 *  1. 画像（profile）：跨会话跨项目，只读注入。本地纯文本（本项目无服务端，
 *     云同步属 M3）。注入侧截断至 PROFILE_BUDGET，截断如实标注。
 *  2. 用户级记忆（user）：本机所有项目共享的显式条目。存储预算在写入侧
 *     已闸门（超限拒绝），注入侧不截断 —— 记下的每一条都原样到达内核。
 *  3. 工作区记忆（workspace）：精选笔记（同用户级，写入侧闸门）+
 *     今日运行日志尾部 DAILY_LOG_TAIL 字符（append-only，截断如实标注）。
 *
 * ── 与技能注入同一条纪律 ────────────────────────────────────────────
 * 注入文本必须原样到达内核（适配层不得改写），且只走 RunContext.memoryContext，
 * 不进 user.message —— 日志里「用户说了什么」必须保持原文。
 * 没有任何记忆内容时 prompt 为 null，宿主不发 memory.attached 事件。
 */

import { PROFILE_BUDGET, DAILY_LOG_TAIL, type MemoryStore } from './store';
import type { MemoryLayerStat } from '@deepwork/protocol';

export interface MemoryContextResult {
  /** 注入文本；三层全空时为 null（宿主据此不发 memory.attached） */
  prompt: string | null;
  /** 三层的用量与预算画像（预算与截断必须可见） */
  layers: MemoryLayerStat[];
}

export function buildMemoryContext(store: MemoryStore, workspace: string): MemoryContextResult {
  const layers = store.stats(workspace);
  const profile = store.getProfile();
  const userEntries = store.list('user');
  const notes = store.list('workspace', workspace);
  const todayLog = store.readTodayLogTail(workspace);

  if (!profile && userEntries.length === 0 && notes.length === 0 && !todayLog.text) {
    return { prompt: null, layers };
  }

  const sections: string[] = [
    '[记忆上下文 —— 由 DeepWork 宿主注入，记忆写入先于本轮回复完成]',
    '以下是用户在本机积累的记忆。回答时把它们当作既定事实与用户偏好来尊重；',
    '画像为本地画像（无服务端，云同步未实现）。',
  ];

  if (profile) {
    const truncated = profile.length > PROFILE_BUDGET;
    const shown = truncated ? profile.slice(0, PROFILE_BUDGET) : profile;
    sections.push(
      '',
      `## 用户画像（跨会话只读注入${truncated ? `，已截断至 ${PROFILE_BUDGET} 字符` : ''}）`,
      shown,
    );
  }

  if (userEntries.length > 0) {
    sections.push('', `## 用户级记忆（${userEntries.length} 条，本机所有项目共享）`);
    for (const entry of userEntries) sections.push(`- ${entry.text}`);
  }

  if (notes.length > 0) {
    sections.push('', `## 工作区记忆 · 精选笔记（${notes.length} 条，仅本项目）`);
    for (const entry of notes) sections.push(`- ${entry.text}`);
  }

  if (todayLog.text) {
    sections.push(
      '',
      `## 工作区记忆 · 今日运行日志（append-only，取尾部 ${DAILY_LOG_TAIL} 字符${todayLog.truncated ? '，更早部分已截断' : ''}）`,
      todayLog.text,
    );
  }

  return { prompt: sections.join('\n'), layers };
}
