'use strict';

/**
 * 截图用的图表产物预置。
 *
 * 与 seed-office.js / seed-usage.js 同一条纪律：**走真实写入路径**。
 * 手工把一段 HTML 摆进工作区，画面证明的只是「预览弹窗会渲染我塞的 HTML」；
 * 走 planChart + 真实落盘，才能证明「生成器写出的东西，预览弹窗认得并能画出来」——
 * 两端（产物标记与界面判定）对不上的话，只有这条路能暴露。
 *
 * 用法： node tools/fixtures/seed-chart.js <工作区目录>
 */

const fs = require('node:fs');
const path = require('node:path');

const workspace = process.argv[2];
if (!workspace) {
  console.error('用法：node tools/fixtures/seed-chart.js <工作区目录>');
  process.exit(1);
}

const { planChart } = require('../../packages/core-host/dist/chart/plan');

/** 四个季度、两个大区的营收与成本 —— 柱状图能同时展示「分组」与「正负无关的绝对量」 */
const QUARTERS = [
  ['季度', '华东 · 营收', '华东 · 成本'],
  ['Q1', 1286, 812],
  ['Q2', 1502, 946],
  ['Q3', 1388, 903],
  ['Q4', 1740, 1088],
];

const target = path.join(workspace, '营收图表.html');
// 工作区根正常已存在；这里仍然补一次 mkdir —— 缺目录时 node 报的是 ENOENT 打开失败，
// 看不出「是工作区没建起来还是路径拼错了」，而截图场景里这条路径是别人传进来的
fs.mkdirSync(path.dirname(target), { recursive: true });
const plan = planChart({
  type: 'bar',
  rows: QUARTERS,
  title: '华东大区 2026 财年季度营收与成本',
  yLabel: '万元',
});

fs.writeFileSync(target, plan.bytes);
console.log(`已生成 ${target}（${plan.summary}）`);
