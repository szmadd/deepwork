/**
 * 图表计划：入参 → 将要落盘的字节 + 文本视图（纯函数，无 IO）。
 *
 * ── 为什么需要一个「计划」而不是直接生成 ────────────────────────────
 * 写类工具的纪律是「预检 → 无变化短路 → 带差异审批 → 落盘」，且**预检与执行
 * 共享同一份快照**。图表与 Office 一样是二进制之外的一类产物：审批里要展示的是
 * 它的**文本视图**（数据表），而写下去的必须是同一份计划生成的那批字节。
 * 把生成塞进 handler 里、审批时另算一遍，就会出现「批准的是 A、写下去的是 B」——
 * 那是审批链路最不能接受的失效形态。
 *
 * ── 审批差异展示的是「产物的源码」，不是另算一份文本视图 ────────────
 * Office 那边的产物是二进制（docx / xlsx），拿不出文本差异，只能抽包内文字当视图。
 * 图表没有这个约束：**产物本身就是文本**，而且是我们按行生成的 ——
 * 一个数据行一行、一个刻度一行、一根柱子一行。于是直接对源码做行级差异，
 * 改一个数字就只动那一行，读到的是「这张图到底变在哪」。另做一份文本视图
 * 反而多一个概念、多一处会与产物分叉的实现。
 *
 * 数据表随产物一起落盘（`<details>` 里），因此审批后随时能核对「图与数对不对得上」。
 */

import type { ChartWriteResult } from '@deepwork/protocol';
import { formatBytes } from '../office/read';
import { renderChartHtml } from './html';
import { chartPointCount, chartSpecFromRows, type ChartSpec } from './spec';
import { describeChart, renderChartSvg } from './svg';

export interface ChartPlan {
  spec: ChartSpec;
  html: string;
  bytes: Buffer;
  /** 一句话规模摘要，回执与审批理由共用 */
  summary: string;
}

/**
 * 生成计划。任何不合法的入参都在这里抛**可行动**的错误
 * （说清收到什么、为什么不行、怎么改），由调用方转成工具失败文本。
 */
export function planChart(args: Record<string, unknown>): ChartPlan {
  const spec = chartSpecFromRows({
    type: args.type,
    rows: args.rows,
    title: args.title,
    header: args.header,
    xLabel: args.xLabel,
    yLabel: args.yLabel,
  });

  // 图与表来自同一份 spec 的同一个快照：不在别处再调一次渲染
  const svg = renderChartSvg(spec);
  const html = renderChartHtml(spec, svg);
  const bytes = Buffer.from(html, 'utf8');

  return {
    spec,
    html,
    bytes,
    summary: `${describeChart(spec)} / ${formatBytes(bytes.length)}`,
  };
}

/** 落盘后的结构化结果（供协议层与测试引用，字段与 ChartWriteResult 对齐） */
export function chartResultOf(plan: ChartPlan, path: string, created: boolean): ChartWriteResult {
  return {
    path,
    type: plan.spec.type,
    bytes: plan.bytes.length,
    created,
    categories: plan.spec.categories.length,
    series: plan.spec.series.length,
    summary: plan.summary,
  };
}

/**
 * 回执文本。
 *
 * 观察（notes）必须跟着回执一起给模型：跳过的列、按缺测处理的单元格、
 * 被截断的标题 —— 这些如果不出现，模型会以为自己画的图与它想的一样。
 */
export function chartOutputText(plan: ChartPlan, verb: string, path: string): string {
  const lines = [`${verb} ${path}（${plan.summary}，共 ${chartPointCount(plan.spec)} 个数据点）`];
  for (const note of plan.spec.notes) lines.push(`- ${note}`);
  return lines.join('\n');
}
