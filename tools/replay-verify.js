'use strict';

/**
 * 回放与分叉验证 —— 不启动 Electron，验证「事件日志能不能被当成可核验的产物」。
 *
 * 这一层要证明的是四件事：
 *  1. **日志是忠实的记录**：落盘的每一行与当初推给壳层的那条事件逐字节相同，
 *     而不是事后重新拼出来的近似物；
 *  2. **回放是确定的**：对同一份日志归约两次结果相同，且回放结果与实时渲染一致；
 *     这靠的是归约器住在契约层、且必须是纯函数；
 *  3. **分叉是可核验的**：新会话日志的前 N 行与父会话前 N 行逐字节相同 ——
 *     「这段历史继承自那里」因此不是一句声明，而是一条可断言的不等式；
 *  4. **分叉点精确**：按事件 seq 切，落在半轮里就精确切在半轮（**不再吸附回轮次边界**，
 *     见 M1 遗留「逐事件分叉」）。请求一个不存在的 seq 时取「不晚于它的最近事件」，
 *     并如实记录 requestedSeq 与 atSeq 的差异。
 *
 *   npm run test:replay
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoreHostClient } = require('../apps/desktop/electron/core-host-client');
const {
  applyEvent,
  buildTimeline,
  runBoundaries,
  sumUsage,
} = require('../packages/protocol/dist');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 与 host.sessionIdOf 保持同一口径：决定一条事件是否属于某个会话日志 */
function isPersisted(event) {
  if (event.type === 'session.created') return true;
  if (event.type === 'session.updated') return true;
  if (event.type === 'session.forked') return true;
  return 'runId' in event;
}

function rawLines(home, sessionId) {
  const file = path.join(home, 'sessions', sessionId, 'events.jsonl');
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 轮询等待条件成立（用于等推送追平落盘，避免把时序窗口当成缺陷） */
async function settleUntil(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return condition();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-replay-'));
  const home = path.join(root, '.deepwork');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'replay', version: '1.0.0' }, null, 2),
  );

  const client = new CoreHostClient();
  const live = [];

  client.on('event', (event) => {
    live.push(event);
    if (event.type === 'approval.requested') {
      setTimeout(() => {
        client
          .invoke('approval.respond', { requestId: event.request.id, decision: 'allow' })
          .catch(() => undefined);
      }, 15);
    }
  });

  /** 等一轮运行结束，返回结束事件 */
  function waitForRun(fromIndex, timeoutMs = 90_000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const hit = live
          .slice(fromIndex)
          .find((event) => event.type === 'run.completed' || event.type === 'run.failed');
        if (hit) {
          clearInterval(timer);
          resolve(hit);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('等待运行结束超时'));
        }
      }, 80);
    });
  }

  console.log('\n深边AI Work · 回放与分叉验证\n');

  client.start({ workspace, home });

  const parent = await client.invoke('session.create', { workspace, title: '主线' });
  const from0 = live.length;
  await client.invoke('run.send', { sessionId: parent.id, text: '看一下这个工程，把运行笔记写好' });
  await waitForRun(from0);
  // 第二轮是为了拿到两个运行边界：这样才能挑一条「落在半轮里」的事件来验证精确分叉。
  // 只在轮末分叉的话，「精确切」与「轮末切」恰好重合，测不出两者的差别。
  const from1 = live.length;
  await client.invoke('run.send', { sessionId: parent.id, text: '再确认一次运行时环境' });
  await waitForRun(from1);

  // 推送与落盘之间存在一个刻意的时间窗：宿主先落盘、再推送。顺序不能反 ——
  // 「已经推给界面但没记进日志」是不可接受的，反过来只是延迟一瞬。
  // 因此快照时推送条数可能略少于落盘条数，这里等它追平，并把真正的不变量单独断言。
  const scoped = () => live.filter(isPersisted);
  const rawNow = () => rawLines(home, parent.id);

  check(
    '推送不超前于落盘（日志是事实来源）',
    scoped().length <= rawNow().length,
    `推送 ${scoped().length} / 落盘 ${rawNow().length}`,
  );
  const caughtUp = await settleUntil(() => scoped().length === rawNow().length);
  check('静止后推送与落盘条数一致', caughtUp, `推送 ${scoped().length} / 落盘 ${rawNow().length}`);

  const liveScoped = scoped();
  const parentEvents = await client.invoke('session.events', { sessionId: parent.id });
  const parentRaw = rawNow();

  // ── 1. 日志是忠实的记录 ────────────────────────────────────
  const comparable = Math.min(liveScoped.length, parentRaw.length);
  const byteDiff = parentRaw.findIndex(
    (line, index) => index < comparable && JSON.stringify(liveScoped[index]) !== line,
  );
  check(
    '落盘行与推送事件逐字节相同',
    byteDiff === -1,
    byteDiff === -1 ? `${comparable} 行逐字节相同` : `第 ${byteDiff + 1} 行不一致`,
  );

  const seqOk = parentEvents.every((event, index) => index === 0 || event.seq > parentEvents[index - 1].seq);
  check('事件序号严格递增', seqOk);

  // ── 2. 回放是确定的 ────────────────────────────────────────
  const timelineA = buildTimeline(parentEvents);
  const timelineB = buildTimeline(parentEvents);
  check('同一份日志归约两次结果相同', same(timelineA, timelineB), `${timelineA.length} 项`);

  const folded = parentEvents.reduce((acc, event) => applyEvent(acc, event), []);
  check('逐条 applyEvent 与整体 buildTimeline 等价', same(folded, timelineA));

  const timelineLive = buildTimeline(liveScoped);
  check(
    '回放结果 == 实时渲染结果',
    same(timelineLive, timelineA),
    `实时 ${timelineLive.length} 项 / 回放 ${timelineA.length} 项`,
  );

  check(
    '用量汇总可重放',
    same(sumUsage(liveScoped), sumUsage(parentEvents)),
    `prompt=${sumUsage(parentEvents).promptTokens}`,
  );

  const boundaries = runBoundaries(parentEvents);
  check('识别出运行边界', boundaries.length >= 1, `边界 seq: ${boundaries.join(', ')}`);  check(
    '时间线中的每一轮都带分叉点',
    timelineA.filter((item) => item.kind === 'run').every((item) => boundaries.includes(item.atSeq)),
  );

  // ── 3. 分叉是可核验的 ──────────────────────────────────────
  const forked = await client.invoke('session.fork', { sessionId: parent.id });
  const child = forked.session;
  const childEvents = await client.invoke('session.events', { sessionId: child.id });
  const childRaw = rawLines(home, child.id);

  check('session.fork 返回新会话', typeof child?.id === 'string' && child.id !== parent.id, child?.id);
  check('新会话记录了来源', child.fork?.sessionId === parent.id, `${child.fork?.sessionId} @ ${child.fork?.atSeq}`);
  check(
    '默认从末尾分叉，边界取最后一条事件',
    forked.from.atSeq === parentEvents[parentEvents.length - 1].seq && forked.from.requestedSeq === null,
    `atSeq=${forked.from.atSeq}（requested=null）`,
  );
  check(
    '继承条数等于边界在日志中的位置',
    forked.from.copied === parentEvents.findIndex((event) => event.seq === forked.from.atSeq) + 1,
    `copied=${forked.from.copied}`,
  );

  const prefixSame =
    childRaw.length === forked.from.copied + 1 &&
    parentRaw
      .slice(0, forked.from.copied)
      .every((line, index) => line === childRaw[index]);
  check(
    '分叉继承了父会话的字节级前缀',
    prefixSame,
    `${forked.from.copied} 行逐字节相同`,
  );

  let marker = null;
  try {
    marker = JSON.parse(childRaw[forked.from.copied] ?? 'null');
  } catch {
    marker = null;
  }
  check(
    '分叉标记紧跟在继承段之后',
    marker?.type === 'session.forked' && marker?.from?.sessionId === parent.id && marker?.from?.copied === forked.from.copied,
    marker ? `#${marker.seq} ← ${marker.from.sessionId}` : '未找到标记',
  );

  check(
    '分支的时间线 == 父会话前缀的时间线',
    same(buildTimeline(childEvents), buildTimeline(parentEvents.slice(0, forked.from.copied))),
    `${buildTimeline(childEvents).length} 项`,
  );

  check(
    '分支继承了累计用量',
    same(child.usage, sumUsage(parentEvents.slice(0, forked.from.copied))),
    `prompt=${child.usage.promptTokens} completion=${child.usage.completionTokens}`,
  );

  const childSeqOk = childEvents.every((event, index) => index === 0 || event.seq > childEvents[index - 1].seq);
  check('分支日志序号严格递增', childSeqOk);

  const list = await client.invoke('session.list');
  check(
    '会话列表可见分支且带来源',
    list.some((item) => item.id === child.id && item.fork?.sessionId === parent.id),
  );

  // ── 4. 分叉点精确（逐事件）────────────────────────────────
  check('两轮运行各自形成边界', boundaries.length === 2, `边界: ${boundaries.join(', ')}`);
  const midRun = parentEvents.find(
    (event) => 'runId' in event && event.seq > boundaries[0] && event.seq < boundaries[1],
  );
  const snapped = await client.invoke('session.fork', { sessionId: parent.id, atSeq: midRun.seq });
  check(
    '落在半轮里的分叉点精确落在该事件上（不再吸附回轮次边界）',
    snapped.from.atSeq === midRun.seq && !boundaries.includes(midRun.seq),
    `请求 #${midRun.seq}（${midRun.type}）→ 采用 #${snapped.from.atSeq}`,
  );
  check('请求位置被采用时如实记录 requestedSeq', snapped.from.requestedSeq === midRun.seq, `requestedSeq=${snapped.from.requestedSeq}`);
  const snappedLast = JSON.parse(rawLines(home, snapped.session.id)[snapped.from.copied - 1] ?? 'null');
  check(
    '前缀以请求的那条事件收尾',
    snappedLast?.seq === midRun.seq,
    snappedLast ? `#${snappedLast.seq} ${snappedLast.type}` : '空',
  );

  // 新建但没跑过对话的会话，日志里只有一条 session.created。逐事件语义下它仍是
  // 一个合法切点（精确继承这 1 条），**切在它之前**才是「没有可继承的事件」。
  const fresh = await client.invoke('session.create', { workspace, title: '新会话' });
  const freshEvents = await client.invoke('session.events', { sessionId: fresh.id });
  const freshFork = await client.invoke('session.fork', { sessionId: fresh.id });
  check(
    '只有创建事件的新会话可分叉，且精确继承这 1 条',
    freshEvents.length === 1 && freshEvents[0].type === 'session.created' &&
      freshFork.from.copied === 1 && freshFork.from.atSeq === freshEvents[0].seq,
    `copied=${freshFork.from.copied} atSeq=${freshFork.from.atSeq}`,
  );

  let earlyError = '';
  try {
    await client.invoke('session.fork', { sessionId: parent.id, atSeq: 0 });
  } catch (error) {
    earlyError = error.message;
  }
  check(
    '无有效边界的位置被拒且原因可行动',
    earlyError.includes('没有可继承的事件'),
    earlyError || '未报错',
  );

  // ── 5. 分支能继续跑，且与父会话解耦 ────────────────────────
  const before = buildTimeline(await client.invoke('session.events', { sessionId: child.id })).length;
  const fromRun = live.length;
  await client.invoke('run.send', { sessionId: child.id, text: '继续，把结论补上' });
  await waitForRun(fromRun);

  const afterEvents = await client.invoke('session.events', { sessionId: child.id });
  const afterTimeline = buildTimeline(afterEvents);
  check('分支内可继续对话', afterTimeline.length > before, `${before} → ${afterTimeline.length} 项`);
  check(
    '分支的对话在前缀之上继续（前缀未被改写）',
    same(buildTimeline(afterEvents.slice(0, forked.from.copied)), buildTimeline(parentEvents.slice(0, forked.from.copied))),
  );

  await client.invoke('session.delete', { sessionId: parent.id });
  const orphan = await client.invoke('session.events', { sessionId: child.id });
  check(
    '父会话删除后分支仍可回放（历史是复制而非引用）',
    same(buildTimeline(orphan), afterTimeline),
    `${orphan.length} 条事件`,
  );

  await client.stop();

  const failed = results.filter((item) => !item.ok);
  console.log(
    `\n${failed.length === 0 ? '\u001b[32m全部通过\u001b[0m' : `\u001b[31m${failed.length} 项失败\u001b[0m`} （共 ${results.length} 项）\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('回放验证异常:', error);
  process.exit(1);
});
