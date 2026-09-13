/**
 * 调度任务存储：`<home>/schedules.json` 数组持久化。
 *
 * ── nextRunAt 是持久化状态，不是读取时的派生值 ──────────────────────
 * 曾经试过「读取时对 enabled 任务重算 nextRunAt」—— 它让引擎永远无法触发：
 * 重算用当前时刻，结果严格在未来，于是「到期」这个状态根本不会出现。
 * 所以 nextRunAt 由三处写入、其余时刻原样读出：
 *  1. add / 重新启用时：nextFire(spec, now)；
 *  2. 引擎启动时的过期清扫（错过不补跑，见 engine.ts）；
 *  3. 引擎触发后的推进（once 清空并停用，周期任务推进到下一次）。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { validateScheduleSpec, type ScheduleSpec, type ScheduleTask } from '@deepwork/protocol';
import { homeDir, readJson, writeJson } from '../paths';
import { nextFire } from './nextfire';

export class ScheduleStore {
  private readonly file: string;

  constructor(baseDir?: string) {
    this.file = path.join(baseDir ?? homeDir(), 'schedules.json');
  }

  list(): ScheduleTask[] {
    return readJson<ScheduleTask[]>(this.file, []);
  }

  get(id: string): ScheduleTask | null {
    return this.list().find((task) => task.id === id) ?? null;
  }

  add(input: { title: string; prompt: string; workspace: string; spec: ScheduleSpec }): ScheduleTask {
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    const workspace = input.workspace.trim();
    if (!title) throw new Error('任务标题不能为空');
    if (!prompt) throw new Error('任务内容（提示词）不能为空');
    if (!workspace) throw new Error('任务必须绑定一个工作区');
    const invalid = validateScheduleSpec(input.spec);
    if (invalid) throw new Error(invalid);
    // 一次性任务的「时刻已过」在这里拒绝，而不是等引擎永远等不到：
    // 「加了但永远不会跑」必须以可行动的错误出现，不能静默落盘
    const next = nextFire(input.spec, new Date());
    if (!next) throw new Error('一次性任务的触发时刻已过，请选择一个将来的时刻');

    const task: ScheduleTask = {
      id: `t_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`,
      title: title.slice(0, 60),
      prompt,
      workspace: path.resolve(workspace),
      spec: input.spec,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
      nextRunAt: next.toISOString(),
    };
    this.persist([...this.list(), task]);
    return task;
  }

  remove(id: string): boolean {
    const tasks = this.list();
    const next = tasks.filter((task) => task.id !== id);
    if (next.length === tasks.length) return false;
    this.persist(next);
    return true;
  }

  /** 停用清空 nextRunAt；重新启用时按当前时刻重算（停着不跑的时间不追补） */
  toggle(id: string, enabled: boolean): ScheduleTask | null {
    const task = this.get(id);
    if (!task) return null;
    const nextRunAt = enabled ? (nextFire(task.spec, new Date())?.toISOString()) : undefined;
    return this.patch(id, { enabled, nextRunAt });
  }

  /**
   * 引擎与宿主的写回通道（触发推进 / 计数 / 上次状态 / 绑定会话 / 启停）。
   * 这是 nextRunAt 在运行期唯一的写入口。
   */
  patch(
    id: string,
    patch: Partial<
      Pick<ScheduleTask, 'enabled' | 'nextRunAt' | 'lastRunAt' | 'lastStatus' | 'lastSessionId' | 'runCount'>
    >,
  ): ScheduleTask | null {
    const tasks = this.list();
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) return null;
    tasks[index] = { ...tasks[index], ...patch };
    this.persist(tasks);
    return tasks[index];
  }

  private persist(tasks: ScheduleTask[]): void {
    writeJson(this.file, tasks);
  }
}
