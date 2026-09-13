'use strict';

/**
 * 用量面板的预置数据（截图 / 手测用）。
 *
 *   node tools/fixtures/seed-usage.js <工作区绝对路径>
 *
 * 走真实存储路径写入（SessionStore + append-only 事件日志），理由与其它 fixture 一致：
 * 画面要证明的是「数字真的从会话存储里算出来」，而不是「面板会渲染我塞的 JSON」。
 *
 * 数据刻意包含了三种情况，因为它们在界面上的长相完全不同：
 *  1. 跨 7 天、多个会话 → 柱状图与分组表都有内容；
 *  2. 一个会话中途换过模型 → 按 run 归属模型的那条规则会被显示出来；
 *  3. 一个模型**故意不配单价** → 「未定价」这条语义（不是 0）在画面上可见。
 */

const path = require('node:path');
const { SessionStore } = require('../../packages/core-host/dist/session/store');
const { configPath, writeJson, readJson } = require('../../packages/core-host/dist/paths');

const workspace = process.argv[2];
if (!workspace) {
  console.error('用法：node tools/fixtures/seed-usage.js <工作区绝对路径>');
  process.exit(1);
}

const DAY = 86_400_000;
const now = Date.now();

const PLANS = [
  {
    title: '梳理工程结构并写运行笔记',
    runs: [
      { daysAgo: 6, model: 'deepseek-flash', prompt: 5200, completion: 1400 },
      { daysAgo: 5, model: 'deepseek-flash', prompt: 3100, completion: 900 },
      { daysAgo: 3, model: 'deepseek-flash', prompt: 8800, completion: 2400 },
      { daysAgo: 0, model: 'deepseek-flash', prompt: 6400, completion: 1900 },
    ],
  },
  {
    title: '本地模型端点连通性验证',
    runs: [
      // 同一个会话里换过模型：用量必须归到各自那一次 run 的模型上
      { daysAgo: 4, model: 'qwen2.5:7b', prompt: 12_000, completion: 4000 },
      { daysAgo: 4, model: 'deepseek-flash', prompt: 2600, completion: 700 },
      { daysAgo: 2, model: 'qwen2.5:7b', prompt: 9000, completion: 3000 },
    ],
  },
  {
    title: '审批链路回归',
    runs: [{ daysAgo: 1, model: 'deepseek-flash', prompt: 6100, completion: 1800 }],
  },
];

const store = new SessionStore();
let runs = 0;

for (const plan of PLANS) {
  const session = store.create({ workspace: path.resolve(workspace), title: plan.title });
  let seq = 1;
  for (const run of plan.runs) {
    const ts = now - run.daysAgo * DAY - seq * 60_000;
    const runId = `seed-${session.id}-${seq}`;
    store.append(session.id, { type: 'run.started', seq: seq++, ts, runId, sessionId: session.id, mode: 'ptc', model: run.model });
    store.append(session.id, {
      type: 'usage',
      seq: seq++,
      ts,
      runId,
      usage: { promptTokens: run.prompt, completionTokens: run.completion, costCny: 0 },
    });
    store.append(session.id, { type: 'run.completed', seq: seq++, ts, runId, status: 'completed', durationMs: 1200 });
    runs += 1;
  }
}

// 只给官方模型配单价：本地模型留空，用量面板应把它标成「未定价」
const config = readJson(configPath(), {});
config.modelPrices = { 'deepseek-flash': { promptPer1k: 0.001, completionPer1k: 0.002 } };
writeJson(configPath(), config);

console.log(`预置完成：${PLANS.length} 个会话 / ${runs} 次调用；未定价模型 qwen2.5:7b`);
