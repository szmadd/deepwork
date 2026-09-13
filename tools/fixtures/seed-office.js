'use strict';

/**
 * 预置 Office 演示产物（.docx / .xlsx），供截图与「真实软件打开」验收使用。
 *
 * 走的是**真实生成器**（dist/office 里的 buildDocx / buildXlsx），而不是手工摆几个文件 ——
 * 否则截图证明的只是「WPS 能打开某个现成的文档」，而不是「我们生成的文档 WPS 能打开」。
 *
 * 用法：node tools/fixtures/seed-office.js [输出目录]
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildDocx, extractDocxText } = require('../../packages/core-host/dist/office/docx');
const { buildXlsx, extractXlsxText } = require('../../packages/core-host/dist/office/xlsx');

const outDir = process.argv[2] || path.join(__dirname, '..', '..', 'artifacts', 'office-demo');
fs.mkdirSync(outDir, { recursive: true });

// 一份像真实工作产物的简报：覆盖标题 / 段落（含粗体与行内码）/ 列表 / 表格 / 引用 / 代码块 / 分隔线
const REPORT = `本周经营简报（自动生成）

本周整体表现**稳中有升**，营收环比增长 12.4%，主要来自华东区的政企项目交付。
需要注意的风险是：应收账款周转天数从 41 天上升到 **53** 天。

## 一、关键指标

| 指标 | 本周 | 上周 | 环比 |
| --- | --- | --- | --- |
| 营收（万元） | 1286 | 1144 | +12.4% |
| 毛利率 | 38.2% | 36.9% | +1.3pp |
| 应收账款周转天数 | 53 | 41 | +12 |

## 二、本周完成

1. 华东区三个政企项目完成验收
2. 与两家渠道商签署年度框架协议
3. 上线新的成本核算模块

## 三、风险与待办

- 应收账款账龄结构恶化，超过 90 天的占比达 18%
- 交付人力缺口：缺 2 名中级实施顾问
- 供应链：\`芯片 A\` 的交期从 6 周延长到 9 周

> 结论：增长质量尚可，但现金流与交付能力是接下来一个月的两个关键约束。

---

下周重点：催收专项、补齐交付人力、评估供应链替代方案。

\`\`\`text
催收专项清单（按优先级）
1. 华东政企 3 单，账龄 96 天
2. 西南渠道 2 单，账龄 74 天
\`\`\`
`;

const BUDGET = [
  ['科目', '预算（万元）', '已发生（万元）', '执行率'],
  ['人力成本', 420, 168, '40%'],
  ['差旅费用', 60, 31.5, '52.5%'],
  ['市场推广', 150, 96, '64%'],
  ['研发投入', 300, 121, '40.3%'],
  ['其他', 70, 12.4, '17.7%'],
  ['合计', 1000, 428.9, '42.9%'],
];

const now = new Date();

const docx = buildDocx({ title: '本周经营简报', markdown: REPORT, now });
fs.writeFileSync(path.join(outDir, 'report.docx'), docx.bytes);

const xlsx = buildXlsx({ rows: BUDGET, sheet: '预算执行', now });
fs.writeFileSync(path.join(outDir, 'budget.xlsx'), xlsx.bytes);

// 生成完立刻用**自己的读取器**读回来：这一步既是冒烟，也是「写-读」自洽的证明。
// 但它不构成「Office 能打开」的证据 —— 那是 tools/open-with-office.js 的职责。
const docxBack = extractDocxText(docx.bytes);
const xlsxBack = extractXlsxText(xlsx.bytes);

console.log(`[seed] report.docx  ${docx.bytes.length} B · ${docx.summary}`);
console.log(`[seed]   读回 ${docxBack.blocks} 段，含表格：${docxBack.text.includes(' | ')}`);
console.log(`[seed] budget.xlsx  ${xlsx.bytes.length} B · ${xlsx.summary}`);
console.log(`[seed]   读回工作表「${xlsxBack.sheets.join('、')}」，${xlsxBack.blocks} 个单元格`);
console.log(`[seed] 产物目录 ${outDir}`);
