/**
 * 调度引擎：定时扫描到期任务并触发。
 *
 * ── 可注入的时钟 ────────────────────────────────────────────────────
 * `tickMs` 与 `now()` 都在构造时注入。生产宿主用 30 秒 tick + 真实时钟；
 * 测试用 100ms tick + 偏移时钟，真实等到一次触发，而不是把「到期判定」
 * 复制一套到测试里 —— 被测的必须是引擎自己跑的那条路径。
 *
 * ── 触发纪律 ────────────────────────────────────────────────────────
 *  - 同一 tick 内同一任务最多触发一次（fired 集合防重入）；
 *  - 错过的时间不补跑：引擎启动时做一次过期清扫 —— nextRunAt 已过期的
 *    任务直接推进到下一个未来时刻而不触发（应用没开就是没跑，
 *    lastRunAt 如实反映上一次真实触发）；
 *  - 触发后立刻推进 nextRunAt（nextFire(spec, 触发时刻)），这是
 *    「同一任务不会重复触发」的结构保证，而不是靠 tick 内去重；
 *  - once 任务触发即自动停用（它的一生只有一次）；
 *  - 触发 = 调宿主注入的 onFire 回调；run 的结局（lastStatus 等）由宿主
 *    在 run 结束时写回，引擎不管 run 的生命周期；
 *  - 手动 runNow 与定时触发同一条 fire 路径，只是不推进 nextRunAt、
 *    不动启用状态 —— 「试一下」不该消耗一次性任务的那一次。
 */

import type { ScheduleTask } from '@deepwork/protocol';
import { createLogger } from '../logger';
import { nextFire } from './nextfire';
import type { ScheduleStore } from './store';

const log = createLogger('scheduler');

export interface SchedulerEngineOptions {
  store: ScheduleStore;
  /** 触发回调：返回派生出的 runId。同步调用，异步推进由宿主负责 */
  onFire: (task: ScheduleTask) => string;
  /** tick 间隔（毫秒），生产默认 30 秒 */
  tickMs?: number;
  /** 时钟，生产默认真实时间 */
  now?: () => Date;
}

export class SchedulerEngine {
  private readonly store: ScheduleStore;
  private readonly onFire: (task: ScheduleTask) => string;
  private readonly tickMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: SchedulerEngineOptions) {
    this.store = options.store;
    this.onFire = options.onFire;
    this.tickMs = options.tickMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    this.stop();
    this.sweepMissed();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // unref 让计时器不阻碍进程退出；但宿主 stop() 仍必须显式 clearInterval，
    // 不能把「能退出」交给 unref 的运气
    this.timer.unref();
    log.info(`调度引擎已启动（tick=${this.tickMs}ms）`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 过期清扫：启动时把「下次触发时刻已过去」的任务直接推进到未来，不触发。
   * 停机期间错过的每一次都不补跑 —— 这是「调度只在应用运行期间生效」的落点。
   */
  private sweepMissed(): void {
    const now = this.now();
    for (const task of this.store.list()) {
      if (!task.enabled || !task.nextRunAt) continue;
      if (new Date(task.nextRunAt).getTime() >= now.getTime()) continue;
      const next = task.spec.kind === 'once' ? undefined : nextFire(task.spec, now)?.toISOString();
      this.store.patch(task.id, task.spec.kind === 'once' ? { enabled: false, nextRunAt: undefined } : { nextRunAt: next });
      log.info(`任务「${task.title}」的计划时刻已过（${task.nextRunAt}），不补跑，推进到 ${next ?? '停用'}`);
    }
  }

  /** 扫描一次：触发所有 nextRunAt <= now 的 enabled 任务。返回被触发的任务 */
  tick(): ScheduleTask[] {
    // tick 回调是同步的，理论上不会重入；这层守卫是为了未来 fire 一旦变成异步
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const now = this.now();
      const fired: ScheduleTask[] = [];
      for (const task of this.store.list()) {
        if (!task.enabled || !task.nextRunAt) continue;
        if (new Date(task.nextRunAt).getTime() > now.getTime()) continue;
        this.fire(task, { manual: false });
        fired.push(task);
      }
      return fired;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 手动立即触发一次。与定时触发同一条 fire 路径（同样的 onFire、
   * 同样的计数写回），但不动 enabled 与 nextRunAt —— 手动试跑不改变计划。
   */
  runNow(id: string): { runId: string } {
    const task = this.store.get(id);
    if (!task) throw new Error(`定时任务不存在: ${id}`);
    const runId = this.fire(task, { manual: true });
    return { runId };
  }

  private fire(task: ScheduleTask, { manual }: { manual: boolean }): string {
    log.info(`触发定时任务「${task.title}」(${task.id}, ${manual ? '手动' : '定时'})`);
    const runId = this.onFire(task);
    const now = this.now();
    const patch: Parameters<ScheduleStore['patch']>[1] = {
      lastRunAt: now.toISOString(),
      runCount: task.runCount + 1,
    };
    if (!manual) {
      if (task.spec.kind === 'once') {
        // 一次性任务触发即完成使命：自动停用，而不是留着一个永远到不了的 nextRunAt
        patch.enabled = false;
        patch.nextRunAt = undefined;
      } else {
        // 先推进再谈别的：nextRunAt 移过当前时刻是「不重复触发」的结构保证
        patch.nextRunAt = nextFire(task.spec, now)?.toISOString();
      }
    }
    this.store.patch(task.id, patch);
    return runId;
  }
}
