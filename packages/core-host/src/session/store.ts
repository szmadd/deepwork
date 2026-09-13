import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentEvent, AgentMode, Session, Usage } from '@deepwork/protocol';
import { ensureDirs, readJson, sessionDir, sessionsDir, writeJson } from '../paths';

/**
 * 会话存储：目录 + append-only 事件日志。
 *
 *   <home>/sessions/<sessionId>/meta.json      会话元数据（可覆盖写）
 *   <home>/sessions/<sessionId>/events.jsonl   事件流（只追加，永不修改）
 *
 * 事件日志是会话的唯一事实来源：进程崩溃后可从日志完整重建对话与 Trajectory，
 * 这也是后续支持 fork / 回放的基础。
 */

export const EMPTY_USAGE: Usage = { promptTokens: 0, completionTokens: 0, costCny: 0 };

export interface CreateSessionInput {
  workspace: string;
  title?: string;
  mode?: AgentMode;
  model?: string;
}

export class SessionStore {
  constructor() {
    ensureDirs();
    fs.mkdirSync(sessionsDir(), { recursive: true });
  }

  list(): Session[] {
    let ids: string[] = [];
    try {
      ids = fs
        .readdirSync(sessionsDir(), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }

    const sessions: Session[] = [];
    for (const id of ids) {
      const meta = this.get(id);
      if (meta) sessions.push(meta);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | null {
    return readJson<Session | null>(path.join(sessionDir(id), 'meta.json'), null);
  }

  create(input: CreateSessionInput): Session {
    const now = Date.now();
    const session: Session = {
      id: `s_${now.toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
      title: input.title?.trim() || '新会话',
      workspace: path.resolve(input.workspace),
      mode: input.mode ?? 'ptc',
      model: input.model ?? 'deepseek-flash',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      usage: { ...EMPTY_USAGE },
    };
    fs.mkdirSync(sessionDir(session.id), { recursive: true });
    writeJson(path.join(sessionDir(session.id), 'meta.json'), session);
    return session;
  }

  update(id: string, patch: Partial<Omit<Session, 'id' | 'createdAt'>>): Session {
    const current = this.get(id);
    if (!current) throw new Error(`会话不存在: ${id}`);
    const next: Session = { ...current, ...patch, updatedAt: Date.now() };
    writeJson(path.join(sessionDir(id), 'meta.json'), next);
    return next;
  }

  accumulateUsage(id: string, delta: Partial<Usage>): Session {
    const current = this.get(id);
    if (!current) throw new Error(`会话不存在: ${id}`);
    const usage: Usage = {
      promptTokens: current.usage.promptTokens + (delta.promptTokens ?? 0),
      completionTokens: current.usage.completionTokens + (delta.completionTokens ?? 0),
      costCny: Number((current.usage.costCny + (delta.costCny ?? 0)).toFixed(6)),
    };
    return this.update(id, { usage });
  }

  remove(id: string): void {
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
  }

  /** 追加一个事件到日志。失败不能中断主流程，只记录。 */
  append(sessionId: string, event: AgentEvent): void {
    const file = path.join(sessionDir(sessionId), 'events.jsonl');
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  }

  readEvents(sessionId: string): AgentEvent[] {
    const file = path.join(sessionDir(sessionId), 'events.jsonl');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const events: AgentEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as AgentEvent);
      } catch {
        // 崩溃可能导致最后一行不完整，跳过即可
      }
    }
    return events;
  }

  /**
   * 读原始行（不重新序列化）。
   *
   * fork 必须走这条路：把事件解析成对象再序列化回字符串，字段顺序、数字格式与转义都
   * 可能变化，于是「新会话的前 N 行与父会话前 N 行逐字节相同」这句话就不成立了，
   * 而那条等式正是「这段历史确实继承自那里」的唯一凭据。
   *
   * 过滤规则与 readEvents 完全一致（丢掉无法解析的行），保证两者的下标严格对齐 ——
   * 否则宿主按解析结果算出的条数，与这里实际复制的行数会错位。
   */
  readRawLines(sessionId: string): string[] {
    const file = path.join(sessionDir(sessionId), 'events.jsonl');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const lines: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
        lines.push(line);
      } catch {
        // 与 readEvents 同样跳过不完整行
      }
    }
    return lines;
  }

  /**
   * 用父会话的前 count 行铺成新会话的日志。
   *
   * 只铺历史、不追加任何东西：分叉标记由调用方随后 `emit`，那时它才会落到文件末尾。
   * 反过来（先写标记再铺历史）会让日志顺序错乱，前缀等式随之失效。
   *
   * @returns 实际复制的条数
   */
  seedFrom(parentId: string, childId: string, count: number): number {
    const lines = this.readRawLines(parentId).slice(0, Math.max(0, count));
    const file = path.join(sessionDir(childId), 'events.jsonl');
    fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
    return lines.length;
  }
}
