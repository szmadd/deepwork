/**
 * 三层记忆存储：目录布局、条目增删、预算闸门、每日日志与归档。
 *
 * ── 目录布局 ────────────────────────────────────────────────────────
 *   <home>/memory/profile.md                      画像（纯文本，本地画像，云同步属 M3）
 *   <home>/memory/user.json                       用户级条目数组
 *   <home>/memory/workspaces/<hash>/notes.json    工作区精选笔记（hash = 工作区绝对路径 sha256 前 16 位）
 *   <home>/memory/workspaces/<hash>/log/YYYY-MM-DD.md   每日 append-only 日志
 *   <home>/memory/workspaces/<hash>/archive/YYYY-MM.md  按月归档
 *
 * ── 预算纪律 ────────────────────────────────────────────────────────
 * 用户级与工作区精选是「存储预算」：add 超限直接拒绝并给出可行动的错误信息，
 * 而不是静默截断 —— 静默截断会让用户以为记下了实际没记下的东西。
 * 画像与今日日志是「注入预算」：内容照常保存，注入时截断并在 stat/注入文本里
 * 如实标记 truncated。
 *
 * ── 每日日志纪律 ────────────────────────────────────────────────────
 * append-only：只有追加（appendFileSync），没有覆盖路径。归档是唯一的「移动」：
 * 读取侧（list/stats/取日志尾部）惰性触发，mtime 超过 30 天的日记按月合并进
 * archive/YYYY-MM.md 后删除原文件。这是机械合并，不做语义蒸馏 —— 语义蒸馏
 * 需要内核摘要能力，见 DEVLOG M2-E 的遗留。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEntry, MemoryLayer, MemoryLayerStat, MemoryOrigin } from '@deepwork/protocol';
import { homeDir, readJson, writeJson } from '../paths';

/** 画像注入上限（字符） */
export const PROFILE_BUDGET = 2_000;
/** 用户级记忆总预算（字符，所有条目 text 之和） */
export const USER_MEMORY_BUDGET = 4_000;
/** 工作区精选笔记总预算（字符） */
export const WORKSPACE_NOTES_BUDGET = 4_000;
/** 今日日志注入取尾部字符数 */
export const DAILY_LOG_TAIL = 2_000;
/** 日记超过多少天被归档 */
export const ARCHIVE_AFTER_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;

export class MemoryStore {
  private readonly root: string;

  constructor(baseDir?: string) {
    this.root = path.join(baseDir ?? homeDir(), 'memory');
  }

  memoryDir(): string {
    return this.root;
  }

  // ── 画像 ──────────────────────────────────────────────────

  getProfile(): string {
    try {
      return fs.readFileSync(this.profilePath(), 'utf8').trim();
    } catch {
      return '';
    }
  }

  /** 画像整体覆写（它是整段文本，不是条目）；空文本 = 清空画像 */
  setProfile(text: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    const trimmed = text.trim();
    if (!trimmed) {
      fs.rmSync(this.profilePath(), { force: true });
      return;
    }
    fs.writeFileSync(this.profilePath(), `${trimmed}\n`, 'utf8');
  }

  // ── 条目（用户级 / 工作区精选）──────────────────────────────

  list(layer?: MemoryLayer, workspace?: string): MemoryEntry[] {
    this.archiveOldLogs(workspace);
    const entries: MemoryEntry[] = [];
    // 画像以伪条目形式读出（id 恒为 'profile'）：UI 在 5 个 RPC 内即可拿到画像文本，
    // 不必为「读一段文本」单开方法。画像的写入只走 setProfile。
    if (!layer || layer === 'profile') {
      const profile = this.getProfile();
      if (profile) {
        let createdAt = '';
        try {
          createdAt = fs.statSync(this.profilePath()).mtime.toISOString();
        } catch {
          createdAt = new Date().toISOString();
        }
        entries.push({ id: 'profile', layer: 'profile', text: profile, createdAt, origin: 'user' });
      }
    }
    if (!layer || layer === 'user') entries.push(...this.readEntries(this.userPath(), 'user'));
    if (!layer || layer === 'workspace') {
      if (workspace) {
        entries.push(...this.readEntries(this.notesPath(workspace), 'workspace', workspace));
      } else {
        // 未指定工作区时汇总所有工作区的精选笔记（供管理面浏览）
        for (const dir of this.workspaceDirs()) {
          entries.push(...this.readEntries(path.join(dir, 'notes.json'), 'workspace'));
        }
      }
    }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 显式写入一条记忆。
   *
   * 预算是硬闸门：超限抛错（可行动信息），调用方必须让用户看见失败，
   * 而不是「看起来记下了」。画像层不走条目，必须用 setProfile。
   */
  add(
    layer: MemoryLayer,
    text: string,
    options?: { workspace?: string; origin?: MemoryOrigin },
  ): MemoryEntry {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('记忆内容不能为空');
    if (layer === 'profile') throw new Error('画像是整段文本，请使用 memory.setProfile 整体更新');

    let file: string;
    let budget: number;
    let layerLabel: string;
    if (layer === 'user') {
      file = this.userPath();
      budget = USER_MEMORY_BUDGET;
      layerLabel = '用户级记忆';
    } else {
      const workspace = options?.workspace?.trim();
      if (!workspace) throw new Error('工作区记忆必须携带 workspace（该条目属于哪个项目）');
      file = this.notesPath(workspace);
      budget = WORKSPACE_NOTES_BUDGET;
      layerLabel = '工作区精选笔记';
    }

    const existing = this.readEntries(file, layer, options?.workspace);
    const used = existing.reduce((sum, entry) => sum + entry.text.length, 0);
    if (used + trimmed.length > budget) {
      throw new Error(
        `${layerLabel}超出预算：已有 ${used} 字符 + 新增 ${trimmed.length} 字符 > 预算 ${budget} 字符；` +
          '请先在记忆面板删除不再需要的条目，再写入新记忆',
      );
    }

    const entry: MemoryEntry = {
      id: `m_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`,
      layer,
      text: trimmed,
      createdAt: new Date().toISOString(),
      origin: options?.origin ?? 'user',
      ...(layer === 'workspace' ? { workspace: path.resolve(options!.workspace!) } : {}),
    };
    writeJson(file, [...existing, entry]);
    return entry;
  }

  /** 按 id 删除：在用户级与所有工作区精选里找；id='profile' 表示清空画像 */
  remove(id: string): boolean {
    if (id === 'profile') {
      if (!this.getProfile()) return false;
      this.setProfile('');
      return true;
    }
    const files = [this.userPath(), ...this.workspaceDirs().map((dir) => path.join(dir, 'notes.json'))];
    for (const file of files) {
      const entries = readJson<MemoryEntry[]>(file, []);
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length !== entries.length) {
        writeJson(file, next);
        return true;
      }
    }
    return false;
  }

  stats(workspace?: string): MemoryLayerStat[] {
    this.archiveOldLogs(workspace);

    const profile = this.getProfile();
    const userEntries = this.readEntries(this.userPath(), 'user');
    const notes = workspace ? this.readEntries(this.notesPath(workspace), 'workspace', workspace) : [];
    const notesChars = notes.reduce((sum, entry) => sum + entry.text.length, 0);

    return [
      {
        layer: 'profile',
        entries: profile ? 1 : 0,
        chars: Math.min(profile.length, PROFILE_BUDGET),
        budget: PROFILE_BUDGET,
        truncated: profile.length > PROFILE_BUDGET,
      },
      {
        layer: 'user',
        entries: userEntries.length,
        chars: userEntries.reduce((sum, entry) => sum + entry.text.length, 0),
        budget: USER_MEMORY_BUDGET,
        // 写入侧已拒绝超限，这里恒为 false；保留字段是为了形状一致
        truncated: false,
      },
      {
        layer: 'workspace',
        entries: notes.length,
        chars: notesChars,
        budget: WORKSPACE_NOTES_BUDGET,
        // 同上：精选笔记超预算在写入侧被拒绝。今日日志的注入截断标记
        // 在注入文本里（见 context.ts），不进 stat —— stat 要回答的是
        // 「还能显式写多少」，把日志尾部算进来会让剩余预算提示失真。
        truncated: false,
      },
    ];
  }

  // ── 每日日志 ────────────────────────────────────────────────

  /**
   * 向该工作区的当日日志追加一行。append-only 的唯一写入口：
   * 只追加、不覆盖、不重排 —— 它是「这个项目里实际发生过什么」的流水账。
   */
  appendDailyLog(workspace: string, line: string): void {
    const logDir = path.join(this.workspaceDir(workspace), 'log');
    fs.mkdirSync(logDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(logDir, `${day}.md`), `${line}\n`, 'utf8');
  }

  /** 读取今日日志的注入段：取尾部 DAILY_LOG_TAIL 字符，截断如实标记 */
  readTodayLogTail(workspace: string): { text: string; truncated: boolean } {
    this.archiveOldLogs(workspace);
    const day = new Date().toISOString().slice(0, 10);
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(this.workspaceDir(workspace), 'log', `${day}.md`), 'utf8');
    } catch {
      return { text: '', truncated: false };
    }
    const text = raw.trim();
    if (text.length <= DAILY_LOG_TAIL) return { text, truncated: false };
    return { text: text.slice(text.length - DAILY_LOG_TAIL), truncated: true };
  }

  // ── 归档（机械合并，读取侧惰性触发）────────────────────────────

  /**
   * 把 mtime 超过 ARCHIVE_AFTER_DAYS 的日记按月并入 archive/YYYY-MM.md 后删除原文件。
   * 返回归档掉的日记文件数。workspace 省略时扫描所有工作区。
   */
  archiveOldLogs(workspace?: string): number {
    const dirs = workspace ? [this.workspaceDir(workspace)] : this.workspaceDirs();
    let archived = 0;
    for (const dir of dirs) {
      const logDir = path.join(dir, 'log');
      let names: string[] = [];
      try {
        names = fs.readdirSync(logDir);
      } catch {
        continue;
      }
      const cutoff = Date.now() - ARCHIVE_AFTER_DAYS * DAY_MS;
      const byMonth = new Map<string, Array<{ day: string; content: string }>>();
      for (const name of names) {
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
        const file = path.join(logDir, name);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        const month = name.slice(0, 7);
        const list = byMonth.get(month) ?? [];
        list.push({ day: name.slice(0, 10), content: fs.readFileSync(file, 'utf8').trim() });
        byMonth.set(month, list);
      }
      if (byMonth.size === 0) continue;
      const archiveDir = path.join(dir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      for (const [month, days] of [...byMonth.entries()].sort()) {
        const body = days
          .sort((a, b) => a.day.localeCompare(b.day))
          .map((item) => `\n\n## ${item.day}\n\n${item.content}`)
          .join('');
        // 归档同样是 append：同月可能分多次归档（月初跑了一次、月底又归档一批）
        fs.appendFileSync(path.join(archiveDir, `${month}.md`), `${body}\n`, 'utf8');
        for (const item of days) fs.rmSync(path.join(logDir, `${item.day}.md`), { force: true });
        archived += days.length;
      }
    }
    return archived;
  }

  // ── 路径工具 ────────────────────────────────────────────────

  private profilePath(): string {
    return path.join(this.root, 'profile.md');
  }

  private userPath(): string {
    return path.join(this.root, 'user.json');
  }

  private notesPath(workspace: string): string {
    return path.join(this.workspaceDir(workspace), 'notes.json');
  }

  /** 工作区目录名 = 绝对路径 sha256 前 16 位：稳定、不含路径分隔符、不泄露原路径 */
  private workspaceDir(workspace: string): string {
    const hash = crypto.createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 16);
    return path.join(this.root, 'workspaces', hash);
  }

  private workspaceDirs(): string[] {
    const base = path.join(this.root, 'workspaces');
    try {
      return fs
        .readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(base, entry.name));
    } catch {
      return [];
    }
  }

  private readEntries(file: string, layer: MemoryLayer, workspace?: string): MemoryEntry[] {
    const entries = readJson<MemoryEntry[]>(file, []);
    return entries.map((entry) => ({
      ...entry,
      layer,
      ...(layer === 'workspace' && workspace ? { workspace: path.resolve(workspace) } : {}),
    }));
  }
}
