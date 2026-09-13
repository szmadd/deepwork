'use strict';

/**
 * 自动化调度测试 —— 「什么时候触发」与「触发了什么」如何被证明。
 *
 *   npm run test:schedule
 *
 * 四层各自独立断言：
 *   1. nextFire 纯函数（正确性核心，密测）：每种的正常与边界 ——
 *      once 过期、当日已过点推到明天/下周、月末溢出落到当月最后一天、interval 对齐；
 *   2. store 层：持久化、nextRunAt 是持久化状态（读取不改写）、启停重算、校验拒绝；
 *   3. 引擎层：tickMs 与 now() 注入，100ms tick 真实等到触发 ——
 *      触发即推进不重复、once 触发后自动停用、手动 runNow 不改计划、
 *      启动时过期清扫（错过不补跑）；
 *   4. host 链路 + RPC 接线：定时触发真的产生 run（会话里有 run.started）、
 *      schedule.fired 先于 run.started 且 runId 归属正确、结局写回任务。
 *
 * 这条链路最危险的失败形态是「任务看起来加了，但永远不会跑 / 跑了但没留痕」，
 * 所以断言全部落在事件流与落盘的任务记录上。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-schedule-'));

const { nextFire } = require('../packages/core-host/dist/scheduler/nextfire');
const { ScheduleStore } = require('../packages/core-host/dist/scheduler/store');
const { SchedulerEngine } = require('../packages/core-host/dist/scheduler/engine');
const { DeepworkHost } = require('../packages/core-host/dist/host');
const { buildHandlers } = require('../packages/core-host/dist/rpc/stdio-server');
const { describeSchedule, validateScheduleSpec } = require('../packages/protocol/dist/schedule');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '[32mPASS[0m' : '[31mFAIL[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到条件成立或超时；返回是否等到 */
async function until(fn, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return true;
    await sleep(60);
  }
  return false;
}

// ══════════════════════════════════════════════════════════
// 1. nextFire 纯函数（from 显式传入，无 IO 无时钟）
// ══════════════════════════════════════════════════════════
console.log('\n── nextFire 纯函数 ──');

{
  const from = new Date(2026, 8, 13, 10, 0, 0); // 2026-09-13 10:00 周日

  // once
  const future = new Date(2026, 8, 13, 11, 30, 0);
  check('once：将来时刻返回该时刻', nextFire({ kind: 'once', at: future.toISOString() }, from)?.getTime() === future.getTime());
  check('once：已过期返回 null', nextFire({ kind: 'once', at: new Date(2026, 8, 13, 9, 0).toISOString() }, from) === null);
  check('once：恰好等于 from 也算过期', nextFire({ kind: 'once', at: from.toISOString() }, from) === null);
  check('once：非法时刻返回 null', nextFire({ kind: 'once', at: 'not-a-date' }, from) === null);

  // daily
  const daily = { kind: 'daily', time: '09:00' };
  check('daily：当日已过点推到明天', eq(nextFire(daily, from), new Date(2026, 8, 14, 9, 0)));
  check('daily：当日未到点就在今天', eq(nextFire({ kind: 'daily', time: '18:05' }, from), new Date(2026, 8, 13, 18, 5)));
  check('daily：恰好等于 from 推到明天（严格大于）', eq(nextFire({ kind: 'daily', time: '10:00' }, from), new Date(2026, 8, 14, 10, 0)));
  check('daily：非法时间返回 null', nextFire({ kind: 'daily', time: '25:00' }, from) === null);

  // weekly（from 是周日）
  check('weekly：当日已过点推到下周', eq(nextFire({ kind: 'weekly', weekdays: [0], time: '09:00' }, from), new Date(2026, 8, 20, 9, 0)));
  check('weekly：当日未到点就在今天', eq(nextFire({ kind: 'weekly', weekdays: [0], time: '18:00' }, from), new Date(2026, 8, 13, 18, 0)));
  // 每周一三五 09:00：从周日 10:00 出发，下一个是周一
  check('weekly：多日组合（一三五）取最近的周一', eq(nextFire({ kind: 'weekly', weekdays: [1, 3, 5], time: '09:00' }, from), new Date(2026, 8, 14, 9, 0)));
  // 从周三 10:00 出发，下一个是一三五里的周五
  check('weekly：多日组合从周三推到周五', eq(nextFire({ kind: 'weekly', weekdays: [1, 3, 5], time: '09:00' }, new Date(2026, 8, 16, 10, 0)), new Date(2026, 8, 18, 9, 0)));
  check('weekly：空星期返回 null', nextFire({ kind: 'weekly', weekdays: [], time: '09:00' }, from) === null);

  // monthly
  check('monthly：本月日期未到取本月', eq(nextFire({ kind: 'monthly', day: 15, time: '09:00' }, from), new Date(2026, 8, 15, 9, 0)));
  check('monthly：本月日期已过取下月', eq(nextFire({ kind: 'monthly', day: 5, time: '09:00' }, from), new Date(2026, 9, 5, 9, 0)));
  check('monthly：当日时间已过也推到下月', eq(nextFire({ kind: 'monthly', day: 13, time: '09:00' }, from), new Date(2026, 9, 13, 9, 0)));
  // 月末溢出：31 日遇到 2 月，落到 2 月最后一天（2026 非闰年 → 28 日；2024 闰年 → 29 日）
  check('monthly：31 日遇非闰年 2 月落到 28 日', eq(nextFire({ kind: 'monthly', day: 31, time: '09:00' }, new Date(2026, 1, 1, 0, 0)), new Date(2026, 1, 28, 9, 0)));
  check('monthly：31 日遇闰年 2 月落到 29 日', eq(nextFire({ kind: 'monthly', day: 31, time: '09:00' }, new Date(2024, 1, 1, 0, 0)), new Date(2024, 1, 29, 9, 0)));
  // 3 月 31 日 10:00（当日 09:00 已过）→ 下月 4 月没有 31 日，落到 4 月 30 日
  check('monthly：3/31 过点后落到 4/30（不丢月）', eq(nextFire({ kind: 'monthly', day: 31, time: '09:00' }, new Date(2026, 2, 31, 10, 0)), new Date(2026, 3, 30, 9, 0)));
  check('monthly：非法日期返回 null', nextFire({ kind: 'monthly', day: 32, time: '09:00' }, from) === null);

  // interval：对齐到 everyMinutes 的整点刻度（epoch 整数倍）
  const stepMs = 30 * 60_000;
  const anyFrom = new Date(2026, 8, 13, 10, 7, 33);
  const got = nextFire({ kind: 'interval', everyMinutes: 30 }, anyFrom);
  const expected = Math.floor(anyFrom.getTime() / stepMs) * stepMs + stepMs;
  check('interval：对齐到整点刻度且严格大于 from', got?.getTime() === expected && got.getTime() > anyFrom.getTime());
  const onBoundary = new Date(expected);
  check('interval：恰好压在刻度上取下一档', nextFire({ kind: 'interval', everyMinutes: 30 }, onBoundary)?.getTime() === expected + stepMs);
  check('interval：非法间隔返回 null', nextFire({ kind: 'interval', everyMinutes: 0 }, anyFrom) === null);
}

// 共享纯函数：UI 与测试共用同一份文案与校验
{
  check('describeSchedule：每周一三五', describeSchedule({ kind: 'weekly', weekdays: [1, 3, 5], time: '09:00' }) === '每周一三五 09:00');
  check('describeSchedule：每月 31 日带溢出说明', describeSchedule({ kind: 'monthly', day: 31, time: '09:00' }).includes('最后一天'));
  check('describeSchedule：间隔 60 分钟显示为小时', describeSchedule({ kind: 'interval', everyMinutes: 60 }) === '每 1 小时');
  check('validateScheduleSpec：每周至少选一天', validateScheduleSpec({ kind: 'weekly', weekdays: [], time: '09:00' }) !== null);
  check('validateScheduleSpec：非法时间格式', validateScheduleSpec({ kind: 'daily', time: '9点' }) !== null);
  check('validateScheduleSpec：合法', validateScheduleSpec({ kind: 'daily', time: '09:00' }) === null);
}

function eq(actual, wanted) {
  return actual instanceof Date && actual.getTime() === wanted.getTime();
}

// ══════════════════════════════════════════════════════════
// 2. store 层：持久化与 nextRunAt 重算
// ══════════════════════════════════════════════════════════
console.log('\n── 调度存储 ──');

const storeHome = path.join(root, 'store-home');
const wsA = path.join(root, 'ws-a');
fs.mkdirSync(wsA, { recursive: true });

{
  const store = new ScheduleStore(storeHome);
  const task = store.add({ title: '每日巡检', prompt: '巡检一遍工作区', workspace: wsA, spec: { kind: 'daily', time: '09:00' } });
  check('新增任务：enabled、runCount=0、nextRunAt 在未来',
    task.enabled === true && task.runCount === 0 && new Date(task.nextRunAt).getTime() > Date.now());

  // 持久化：换一个实例读同一份文件
  const reread = new ScheduleStore(storeHome).list();
  check('落盘后可被新实例读回', reread.length === 1 && reread[0].id === task.id);

  // 校验拒绝
  check('一次性时刻已过被拒绝', throwsWith(() => store.add({ title: 'x', prompt: 'x', workspace: wsA, spec: { kind: 'once', at: new Date(2020, 0, 1).toISOString() } }), '已过'));
  check('非法调度参数被拒绝', throwsWith(() => store.add({ title: 'x', prompt: 'x', workspace: wsA, spec: { kind: 'daily', time: '99:99' } }), 'HH:MM'));
  check('空标题被拒绝', throwsWith(() => store.add({ title: '  ', prompt: 'x', workspace: wsA, spec: { kind: 'daily', time: '09:00' } }), '标题'));

  // 启停
  const off = store.toggle(task.id, false);
  check('停用后 nextRunAt 为空', off.enabled === false && off.nextRunAt === undefined);
  const on = store.toggle(task.id, true);
  check('重新启用后 nextRunAt 重算到未来', on.enabled === true && new Date(on.nextRunAt).getTime() > Date.now());

  // nextRunAt 是持久化状态：手工改写过期的值会被原样读出。
  // 「错过不补跑」不由读取侧兜底，而由引擎启动时的过期清扫完成（见引擎段）
  const file = path.join(storeHome, 'schedules.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw[0].nextRunAt = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  const rereadStale = new ScheduleStore(storeHome).list()[0];
  check('落盘的过期 nextRunAt 被原样读出（推进是引擎启动清扫的职责）',
    new Date(rereadStale.nextRunAt).getTime() < Date.now(), rereadStale.nextRunAt);

  check('删除任务', store.remove(task.id) === true && store.list().length === 0);
  check('删除不存在的任务返回 false', store.remove('t_nope') === false);
}

// ══════════════════════════════════════════════════════════
// 3. 引擎层：注入 tick 与时钟，真实等到一次触发
// ══════════════════════════════════════════════════════════
console.log('\n── 调度引擎 ──');

async function engineSection() {
  const engineHome = path.join(root, 'engine-home');
  const store = new ScheduleStore(engineHome);

  // 两个任务的计划时刻都在「真实 now + 1 分钟」；引擎的时钟偏移 +2 分钟，
  // 于是它们对引擎而言都已到期 —— 被测的是引擎自己的 tick 与到期判定。
  // 引擎先于任务启动：过期清扫只在启动时跑一次（扫的是「停机期间错过」的任务），
  // 后加的任务走的是正常 tick 触发路径
  const fired = [];
  const engine = new SchedulerEngine({
    store,
    tickMs: 100,
    now: () => new Date(Date.now() + 120_000),
    onFire: (task) => {
      fired.push(task.id);
      return `r_fake_${task.id}`;
    },
  });
  engine.start();

  const soon = new Date(Date.now() + 60_000);
  const hhmm = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
  const daily = store.add({ title: '日报', prompt: '写日报', workspace: wsA, spec: { kind: 'daily', time: hhmm } });
  const once = store.add({ title: '一次性', prompt: '只跑一次', workspace: wsA, spec: { kind: 'once', at: soon.toISOString() } });

  const got = await until(() => fired.includes(daily.id) && fired.includes(once.id), 10_000);
  check('到期任务被引擎真实触发', got, `fired=${fired.length}`);

  await sleep(400); // 多等几个 tick：不该有第二次触发
  check('同一任务不重复触发（错过不追补、同 tick 去重）',
    fired.filter((id) => id === daily.id).length === 1 && fired.filter((id) => id === once.id).length === 1);

  const onceAfter = store.get(once.id);
  check('once 触发后自动停用且 nextRunAt 清空', onceAfter.enabled === false && onceAfter.nextRunAt === undefined);
  const dailyAfter = store.get(daily.id);
  check('daily 触发后重算 nextRunAt 且仍启用',
    dailyAfter.enabled === true && new Date(dailyAfter.nextRunAt).getTime() > Date.now() + 120_000);
  check('触发计数与 lastRunAt 写回', dailyAfter.runCount === 1 && Boolean(dailyAfter.lastRunAt));

  // 手动立即触发：同一条 fire 路径，但不动计划与启停
  const before = store.get(daily.id).nextRunAt;
  const { runId } = engine.runNow(daily.id);
  const afterManual = store.get(daily.id);
  check('runNow 返回 runId 并再次触发', runId === `r_fake_${daily.id}` && fired.filter((id) => id === daily.id).length === 2);
  check('runNow 不改变 nextRunAt 与启用状态', afterManual.nextRunAt === before && afterManual.enabled === true && afterManual.runCount === 2);
  check('runNow 不存在的任务抛错', throwsWith(() => engine.runNow('t_nope'), '不存在'));

  // stop 必须清掉定时器：停掉之后任务再到期也不触发
  engine.stop();
  const firedCount = fired.length;
  await sleep(350);
  check('engine.stop 后不再触发（tick 已清除）', fired.length === firedCount);

  // 过期清扫：模拟「应用停机期间错过了触发」—— 手工把 nextRunAt 改到过去再启动引擎。
  // 引擎必须把它们推进到未来而不触发（错过不补跑），once 则直接停用
  const sweepHome = path.join(root, 'sweep-home');
  const sweepStore = new ScheduleStore(sweepHome);
  const staleDaily = sweepStore.add({ title: '错过的日报', prompt: 'x', workspace: wsA, spec: { kind: 'daily', time: '09:00' } });
  const staleOnce = sweepStore.add({
    title: '错过的一次性',
    prompt: 'x',
    workspace: wsA,
    spec: { kind: 'once', at: new Date(Date.now() + 3600_000).toISOString() },
  });
  const sweepFile = path.join(sweepHome, 'schedules.json');
  const raw = JSON.parse(fs.readFileSync(sweepFile, 'utf8')).map((t) => ({
    ...t,
    nextRunAt: new Date(Date.now() - 3600_000).toISOString(),
  }));
  fs.writeFileSync(sweepFile, JSON.stringify(raw), 'utf8');

  const sweepFired = [];
  const sweepEngine = new SchedulerEngine({
    store: sweepStore,
    tickMs: 60_000, // 大到不会真 tick：被测的只是启动时的清扫
    onFire: (task) => {
      sweepFired.push(task.id);
      return 'r_nope';
    },
  });
  sweepEngine.start();
  await sleep(200);
  check('启动清扫：过期任务不补跑', sweepFired.length === 0, `fired=${sweepFired.length}`);
  const sweptDaily = sweepStore.get(staleDaily.id);
  const sweptOnce = sweepStore.get(staleOnce.id);
  check('启动清扫：周期任务推进到未来', new Date(sweptDaily.nextRunAt).getTime() > Date.now(), sweptDaily.nextRunAt);
  check('启动清扫：过期 once 直接停用', sweptOnce.enabled === false && sweptOnce.nextRunAt === undefined);
  sweepEngine.stop();
}

// ══════════════════════════════════════════════════════════
// 4. host 链路 + RPC 接线（mock 内核）
// ══════════════════════════════════════════════════════════
console.log('\n── host 触发链路与 RPC ──');

async function hostSection() {
  const hostHome = path.join(root, 'host-home');
  const wsHost = path.join(root, 'ws-host');
  fs.mkdirSync(wsHost, { recursive: true });
  process.env.DEEPWORK_HOME = hostHome;

  const host = new DeepworkHost({ scheduler: { tickMs: 100, now: () => new Date(Date.now() + 120_000) } });
  await host.start(wsHost);
  host.setGuard({ mode: 'auto' });

  const events = [];
  host.onEvent((event) => events.push(event));

  const soon = new Date(Date.now() + 60_000);
  const task = host.addSchedule({
    title: '定时巡检',
    prompt: '巡检任务 SCHED_MARK',
    workspace: wsHost,
    spec: { kind: 'daily', time: `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}` },
  });

  const firedOk = await until(() => events.some((e) => e.type === 'schedule.fired'), 15_000);
  check('schedule.fired 事件发出', firedOk);
  const firedEvent = events.find((e) => e.type === 'schedule.fired');
  check('schedule.fired 带任务、runId 与 sessionId',
    firedEvent?.task?.id === task.id && Boolean(firedEvent?.runId) && Boolean(firedEvent?.sessionId));

  // 触发的会话以「⏰ 标题」为名新建
  const session = host.listSessions().find((s) => s.id === firedEvent.sessionId);
  check('触发会话以「⏰ 任务标题」新建', session?.title === '⏰ 定时巡检', session?.title);

  // 等 run 结束（mock 内核会真的跑完一轮）
  const runOk = await until(() => events.some((e) => e.type === 'run.completed' && e.runId === firedEvent.runId), 90_000);
  check('调度派生的 run 真实跑完', runOk);

  const log = host.sessionEvents(firedEvent.sessionId);
  const seqOf = (type) => log.find((e) => e.type === type)?.seq ?? -1;
  check('日志中 schedule.fired 先于 user.message 先于 run.started',
    seqOf('schedule.fired') > 0 && seqOf('schedule.fired') < seqOf('user.message') && seqOf('user.message') < seqOf('run.started'));
  check('user.message 原文就是任务提示词', log.find((e) => e.type === 'user.message')?.text === '巡检任务 SCHED_MARK');
  check('schedule.fired 的 runId 与 run.started 一致（归属正确）',
    log.find((e) => e.type === 'schedule.fired')?.runId === log.find((e) => e.type === 'run.started')?.runId);

  // run 结局写回（发生在 run.completed 之后的 promise 回调里，轮询等它落盘）
  const writtenBack = await until(() => host.listSchedules().find((t) => t.id === task.id)?.lastStatus === 'completed', 10_000);
  const after = host.listSchedules().find((t) => t.id === task.id);
  check('run 结束后 lastStatus/lastSessionId/runCount 写回任务',
    writtenBack && after.lastSessionId === firedEvent.sessionId && after.runCount === 1 && Boolean(after.lastRunAt),
    JSON.stringify({ lastStatus: after?.lastStatus, runCount: after?.runCount }));
  check('daily 任务触发后仍启用且 nextRunAt 在未来',
    after.enabled === true && new Date(after.nextRunAt).getTime() > Date.now());

  // 手动立即触发：复用绑定会话，与定时触发同一条路径
  const manual = host.runScheduleNow(task.id);
  const manualFired = await until(
    () => events.some((e) => e.type === 'schedule.fired' && e.runId === manual.runId),
    10_000,
  );
  const manualEvent = events.find((e) => e.type === 'schedule.fired' && e.runId === manual.runId);
  check('runNow 派生真实 run 并复用绑定会话', manualFired && manualEvent.sessionId === firedEvent.sessionId);
  const manualPlan = host.listSchedules().find((t) => t.id === task.id);
  check('runNow 不改变计划（nextRunAt 不变、仍启用）',
    manualPlan.nextRunAt === after.nextRunAt && manualPlan.enabled === true);
  await until(() => events.some((e) => e.type === 'run.completed' && e.runId === manual.runId), 90_000);

  await host.stop();

  // ── RPC 接线 ──
  const rpcHost = new DeepworkHost({ scheduler: { tickMs: 60_000 } });
  await rpcHost.start(wsA);
  const handlers = buildHandlers(rpcHost);
  const names = ['schedule.list', 'schedule.add', 'schedule.remove', 'schedule.toggle', 'schedule.runNow'];
  check('5 个 schedule.* 方法全部注册', names.every((name) => typeof handlers[name] === 'function'));

  const added = await handlers['schedule.add']({ title: 'RPC 任务', prompt: 'RPC 触发', workspace: wsA, spec: { kind: 'interval', everyMinutes: 30 } });
  check('schedule.add 返回任务且 nextRunAt 在未来', Boolean(added?.id) && new Date(added.nextRunAt).getTime() > Date.now());
  const listed = await handlers['schedule.list']({});
  check('schedule.list 读回该任务', listed.some((t) => t.id === added.id));
  const toggled = await handlers['schedule.toggle']({ id: added.id, enabled: false });
  check('schedule.toggle 停用生效', toggled?.enabled === false && toggled.nextRunAt === undefined);
  await handlers['schedule.toggle']({ id: added.id, enabled: true });
  const runNow = await handlers['schedule.runNow']({ id: added.id });
  check('schedule.runNow 返回 runId', typeof runNow?.runId === 'string' && runNow.runId.length > 0);
  const removed = await handlers['schedule.remove']({ id: added.id });
  check('schedule.remove 删除生效', removed?.ok === true && !(await handlers['schedule.list']({})).some((t) => t.id === added.id));

  await rpcHost.stop();
}

function throwsWith(fn, keyword) {
  try {
    fn();
  } catch (error) {
    return String(error instanceof Error ? error.message : error).includes(keyword);
  }
  return false;
}

async function main() {
  await engineSection();
  await hostSection();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n自动化调度测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
