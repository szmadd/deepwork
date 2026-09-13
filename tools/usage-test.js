'use strict';

/**
 * 用量聚合测试（M2-J）—— 「跨会话用量到底怎么算出来的」。
 *
 *   npm run test:usage
 *
 * 三层各自独立断言：
 *   1. 纯函数层：分组正确性 + **分组之和 = 总数**（本文件最硬的一条等式）+ 日切注入 + 未定价语义；
 *   2. 宿主层（真实会话存储）：从 events.jsonl 现算，换模型的会话按 run 归属；
 *   3. 接线层：配置写入即清洗、RPC 处理器注册可用。
 *
 * 为什么把「分组之和 = 总数」当成核心断言：聚合代码漏掉一类样本（例如没有 run.started
 * 的 usage 事件）时，界面上的每一个数字看起来都正常，只有加起来对不上 ——
 * 而用户几乎不会去加一遍，所以这种错会一直活着。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-usage-'));
const home = path.join(root, '.deepwork');
process.env.DEEPWORK_HOME = home;

const {
  summarizeUsage,
  localDayKey,
  sanitizeModelPrices,
} = require('../packages/core-host/dist/usage/summary');
const { SessionStore } = require('../packages/core-host/dist/session/store');
const { DeepworkHost } = require('../packages/core-host/dist/host');
const { buildHandlers } = require('../packages/core-host/dist/rpc/stdio-server');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 分组之和与总数逐项相等 —— 一处不等就说明有样本没被归进某一类 */
function totalsEqual(a, b) {
  return (
    a.promptTokens === b.promptTokens &&
    a.completionTokens === b.completionTokens &&
    a.totalTokens === b.totalTokens &&
    Math.abs(a.costCny - b.costCny) < 1e-9 &&
    a.runs === b.runs
  );
}

function sumRows(rows) {
  const out = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costCny: 0, runs: 0 };
  for (const row of rows) {
    out.promptTokens += row.totals.promptTokens;
    out.completionTokens += row.totals.completionTokens;
    out.totalTokens += row.totals.totalTokens;
    out.costCny = Number((out.costCny + row.totals.costCny).toFixed(6));
    out.runs += row.totals.runs;
  }
  return out;
}

// ══════════════════════════════════════════════════════════
// 1. 纯函数层
// ══════════════════════════════════════════════════════════
console.log('\n── 聚合纯函数 ──');

// 固定日切：把「哪天」这件事从系统时区里拿出来，否则同一份数据在不同机器上分组不同，
// 测试会变成「在 CI 上偶发失败」的那种
const DAY_OF = (ts) => `day-${Math.floor(ts / 86_400_000)}`;

const PRICES = {
  'model-a': { promptPer1k: 0.001, completionPer1k: 0.002 },
  'model-b': { promptPer1k: 0.01, completionPer1k: 0.02 },
};

const SAMPLES = [
  // 会话 1：两天、两个模型（含一次换模型）
  { sessionId: 's1', runId: 'r1', model: 'model-a', ts: 1 * 86_400_000, usage: { promptTokens: 1000, completionTokens: 500, costCny: 0.002 } },
  { sessionId: 's1', runId: 'r2', model: 'model-a', ts: 1 * 86_400_000 + 3600_000, usage: { promptTokens: 2000, completionTokens: 1000, costCny: 0.004 } },
  { sessionId: 's1', runId: 'r3', model: 'model-b', ts: 2 * 86_400_000, usage: { promptTokens: 500, completionTokens: 250, costCny: 0.01 } },
  // 会话 2：另一天、一个无单价模型
  { sessionId: 's2', runId: 'r4', model: 'model-local', ts: 3 * 86_400_000, usage: { promptTokens: 10_000, completionTokens: 5000, costCny: 0 } },
  { sessionId: 's2', runId: 'r5', model: 'model-b', ts: 3 * 86_400_000 + 60_000, usage: { promptTokens: 100, completionTokens: 50, costCny: 0 } },
];

const SESSIONS = [
  { id: 's1', title: '会话一', workspace: path.join(root, 'ws-a'), updatedAt: 111 },
  { id: 's2', title: '会话二', workspace: path.join(root, 'ws-b'), updatedAt: 222 },
];

{
  const summary = summarizeUsage({ sessions: SESSIONS, samples: SAMPLES, prices: PRICES, now: 999, dayOf: DAY_OF });

  check(
    '总数与手算一致（prompt/completion/调用数）',
    summary.totals.promptTokens === 13_600 &&
      summary.totals.completionTokens === 6_800 &&
      summary.totals.totalTokens === 20_400 &&
      summary.totals.runs === 5,
    JSON.stringify(summary.totals),
  );

  // 这条等式是核心：三种分组各自都要能还原出总数
  check('按日分组的合计 = 总数', totalsEqual(sumRows(summary.byDay), summary.totals));
  check('按模型分组的合计 = 总数', totalsEqual(sumRows(summary.byModel), summary.totals));
  check('按会话分组的合计 = 总数', totalsEqual(sumRows(summary.bySession), summary.totals));

  check('按日升序（图表从左到右就是时间方向）', summary.byDay.map((d) => d.date).join('|') === 'day-1|day-2|day-3', summary.byDay.map((d) => d.date).join('|'));
  check('按模型 token 降序', summary.byModel.map((m) => m.model).join('|') === 'model-local|model-a|model-b', summary.byModel.map((m) => m.model).join('|'));
  check('按会话 token 降序', summary.bySession.map((s) => s.sessionId).join('|') === 's2|s1', summary.bySession.map((s) => s.sessionId).join('|'));

  // 估算：model-a 两天各一次 + model-b 三次
  // model-a: (1000/1000)*0.001 + (500/1000)*0.002 = 0.002；(2000,1000) → 0.002+0.002 = 0.004
  const costA = 0.002 + 0.004;
  const costB = (500 / 1000) * 0.01 + (250 / 1000) * 0.02 + (100 / 1000) * 0.01 + (50 / 1000) * 0.02;
  check(
    '有单价模型的估算金额正确',
    Math.abs(summary.byModel.find((m) => m.model === 'model-a').estimatedCostCny - costA) < 1e-9 &&
      Math.abs(summary.byModel.find((m) => m.model === 'model-b').estimatedCostCny - costB) < 1e-9,
    `a=${summary.byModel.find((m) => m.model === 'model-a').estimatedCostCny} b=${summary.byModel.find((m) => m.model === 'model-b').estimatedCostCny}`,
  );

  check('无单价模型被列出且估算为 null（不是 0）', summary.unpricedModels.join('|') === 'model-local' && summary.estimatedCostCny === null);
  check('用到无单价模型的会话，其估算同样是 null', summary.bySession.find((s) => s.sessionId === 's2').estimatedCostCny === null);
  check('未受影响的会话估算仍然是数字', typeof summary.bySession.find((s) => s.sessionId === 's1').estimatedCostCny === 'number');
  check('会话元数据带上标题与工作区', summary.bySession.find((s) => s.sessionId === 's1').title === '会话一');
  check('汇总时刻来自注入的 now', summary.generatedAt === 999);
}

{
  // 全部模型都有单价时，全局估算必须能算出来（否则「有价却算不出」会被误读成功能坏了）
  const priced = SAMPLES.filter((s) => s.model !== 'model-local');
  const summary = summarizeUsage({ sessions: SESSIONS, samples: priced, prices: PRICES, now: 1, dayOf: DAY_OF });
  check('全部有单价时全局估算为数字', typeof summary.estimatedCostCny === 'number' && summary.estimatedCostCny > 0);
}

{
  const empty = summarizeUsage({ sessions: [], samples: [], prices: {}, now: 5, dayOf: DAY_OF });
  check(
    '无样本时全 0 且分组为空',
    empty.totals.runs === 0 && empty.totals.totalTokens === 0 && empty.byDay.length === 0 && empty.byModel.length === 0 && empty.bySession.length === 0,
  );
  check('无样本时估算为 0（此时 0 是正确答案，不是「不知道」）', empty.estimatedCostCny === 0);
}

{
  // 日切默认实现是本地时区：同一天的 00:01 与 23:59 必须落在同一个键上
  const base = new Date(2026, 8, 13, 0, 1, 0).getTime();
  const late = new Date(2026, 8, 13, 23, 59, 0).getTime();
  check('默认日切按本地时区同一天归组', localDayKey(base) === localDayKey(late) && localDayKey(base) === '2026-09-13', localDayKey(base));
}

{
  const cleaned = sanitizeModelPrices({
    good: { promptPer1k: 1, completionPer1k: 2 },
    nan: { promptPer1k: 'x', completionPer1k: 2 },
    negative: { promptPer1k: -1, completionPer1k: 2 },
    partial: { promptPer1k: 3 },
    notObject: 7,
    '': { promptPer1k: 1, completionPer1k: 1 },
  });
  check(
    '单价清洗：坏值丢弃、合法项保留',
    Object.keys(cleaned).join('|') === 'good' && cleaned.good.promptPer1k === 1,
    Object.keys(cleaned).join('|'),
  );
  // `Number(null)` 是 0 —— 「顺手转成数字」会把一份坏配置变成「单价 0」，
  // 也就是把「不知道」显示成「免费」。这条断言专门守这个洞。
  const nulled = sanitizeModelPrices({ x: { promptPer1k: null, completionPer1k: 1 } });
  check('null 单价不被当成 0', Object.keys(nulled).length === 0);
}

// ══════════════════════════════════════════════════════════
// 2. 宿主层（真实会话存储）
// ══════════════════════════════════════════════════════════
async function hostLayer() {
  console.log('\n── 宿主聚合（真实 events.jsonl）──');

  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const host = new DeepworkHost();
  const store = new SessionStore();
  const day = 86_400_000;

  const first = host.createSession({ workspace, title: '换过模型的会话' });
  const second = host.createSession({ workspace, title: '本地模型的会话' });

  // 直接写日志（不经内核）：聚合读的就是这份 append-only 日志，
  // 用真实形状的 run.started + usage 事件才能证明确实按 run 的模型归属
  const append = (sessionId, events) => {
    let seq = 1;
    for (const event of events) {
      store.append(sessionId, { seq: seq++, ts: 0, ...event });
    }
  };

  const t0 = Date.now() - 2 * day;
  append(first.id, [
    { type: 'run.started', runId: 'r1', sessionId: first.id, mode: 'ptc', model: 'model-a' },
    { type: 'usage', runId: 'r1', usage: { promptTokens: 1000, completionTokens: 200, costCny: 0 } },
    { type: 'run.started', runId: 'r2', sessionId: first.id, mode: 'ptc', model: 'model-b' },
    { type: 'usage', runId: 'r2', usage: { promptTokens: 3000, completionTokens: 400, costCny: 0 } },
  ]);
  append(second.id, [
    { type: 'run.started', runId: 'r3', sessionId: second.id, mode: 'ptc', model: 'model-local' },
    { type: 'usage', runId: 'r3', usage: { promptTokens: 7000, completionTokens: 100, costCny: 0 } },
  ]);

  await host.setConfig({ modelPrices: { 'model-a': { promptPer1k: 1, completionPer1k: 1 } } });

  const summary = host.usageSummary();

  check('总数来自日志（4000 + 3400 + 7100）', summary.totals.promptTokens === 11_000 && summary.totals.completionTokens === 700 && summary.totals.runs === 3, JSON.stringify(summary.totals));
  check(
    '换模型的会话按 run 归属模型（不是按会话当前模型）',
    summary.byModel.find((m) => m.model === 'model-a')?.totals.promptTokens === 1000 &&
      summary.byModel.find((m) => m.model === 'model-b')?.totals.promptTokens === 3000,
    summary.byModel.map((m) => `${m.model}:${m.totals.promptTokens}`).join(' '),
  );
  check('分组之和 = 总数（宿主层同样成立）', totalsEqual(sumRows(summary.byDay), summary.totals) && totalsEqual(sumRows(summary.byModel), summary.totals));
  check('会话标题来自 meta', summary.bySession.find((s) => s.sessionId === first.id).title === '换过模型的会话');
  check('未定价模型如实列出', summary.unpricedModels.includes('model-b') && summary.unpricedModels.includes('model-local'));

  // 单价表经 config.set 落盘时被清洗（坏值不进 config.json）
  await host.setConfig({ modelPrices: { bad: { promptPer1k: Number.NaN, completionPer1k: 1 } } });
  check('坏单价不落盘', Object.keys(host.getConfig().modelPrices).length === 0);

  // ════════════════════════════════════════════════════════
  // 3. 接线层
  // ════════════════════════════════════════════════════════
  console.log('\n── RPC 接线 ──');
  const handlers = buildHandlers(host);
  check('usage.summary 已注册', typeof handlers['usage.summary'] === 'function');
  const viaRpc = await handlers['usage.summary']({});
  check('RPC 返回值与宿主一致', viaRpc.totals.runs === summary.totals.runs && viaRpc.totals.promptTokens === summary.totals.promptTokens);

  await host.stop();
}

hostLayer()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n用量聚合测试：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length > 0) {
      for (const item of failed) console.log(`  FAIL: ${item.name}`);
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('测试执行异常：', error);
    process.exit(1);
  });
