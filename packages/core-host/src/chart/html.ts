/**
 * 图表规格 → 自包含 HTML（纯函数，无 IO）。
 *
 * 产物只有三个组成：一段内联 SVG、一张 `details` 里的数据表、一份样式。
 * **没有脚本、没有外链、没有字体文件** —— 双击就能打开，离线、断网、
 * 拷到别的机器上都一样。
 *
 * ── 三条刻意的取舍 ────────────────────────────────────────────────
 *
 * 1. **CSP 收紧到 `default-src 'none'`。** 产物是数据视图，不需要取任何外部资源；
 *    把它写死，既挡住「图表偷偷回连某个统计服务」，也让「预览 iframe 里
 *    看到的就是浏览器里看到的」保持成立（预览通道禁脚本，这里禁一切）。
 * 2. **不写生成时间。** 看着友好，代价是同一份数据两次生成产出不同字节，
 *    所有靠字节比对的断言（无变化短路、差异预览、回放）会集体失效。
 *    与 `zipWrite` 固定 DOS 时间戳同一条纪律。
 * 3. **数据表随产物一起走。** 图表是「数据的一种视图」，把数据留在会话里、
 *    只把图导出去，等于交付了一份无法核对的东西。`<details>` 折叠而不是
 *    另开文件：少了「图与表走散」这一种失败形态。
 */

import { CHART_HTML_MARKER } from '@deepwork/protocol';
import { escapeXml } from '../office/xml';
import { clipCell, type ChartSpec } from './spec';
import { describeChart, formatNumber, seriesColor } from './svg';

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #ffffff;
  color: #111827;
  font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}
main { max-width: 1040px; margin: 0 auto; padding: 28px 24px 40px; }
h1 { font-size: 20px; margin: 0 0 6px; }
.ch-meta { color: #6B7280; margin: 0 0 14px; font-size: 12.5px; }
.ch-figure { margin: 0; padding: 6px 0 0; overflow-x: auto; }
.ch-figure svg { display: block; width: 100%; height: auto; }
.ch-title { font-size: 20px; font-weight: 600; fill: #111827; }
.ch-legend-text { font-size: 13px; fill: #374151; }
.ch-tick { font-size: 12px; fill: #6B7280; }
.ch-axis-label { font-size: 12.5px; fill: #6B7280; }
.ch-value { font-size: 11px; fill: #374151; }
.ch-grid { stroke: #E5E7EB; stroke-width: 1; }
.ch-zero { stroke: #9CA3AF; stroke-width: 1.2; }
.ch-axis { stroke: #D1D5DB; stroke-width: 1; }
.ch-slice-label { font-size: 12px; font-weight: 600; fill: #ffffff; }
.ch-bar:hover, .ch-slice:hover { opacity: 0.82; }
.ch-data { margin: 20px 0 0; border-top: 1px solid #E5E7EB; padding-top: 12px; }
.ch-data summary { cursor: pointer; color: #2563EB; font-size: 13px; }
table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 13px; }
th, td { border: 1px solid #E5E7EB; padding: 5px 9px; text-align: left; }
th { background: #F9FAFB; font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.missing { color: #9CA3AF; }
.ch-notes { margin: 16px 0 0; padding-left: 18px; color: #92400E; font-size: 12.5px; }
.ch-foot { color: #9CA3AF; font-size: 12px; margin-top: 22px; }
@media (prefers-color-scheme: dark) {
  body { background: #0F1115; color: #E5E7EB; }
  .ch-title { fill: #F9FAFB; }
  .ch-legend-text { fill: #D1D5DB; }
  .ch-tick, .ch-axis-label { fill: #9CA3AF; }
  .ch-value { fill: #D1D5DB; }
  .ch-grid { stroke: #242A33; }
  .ch-zero { stroke: #4B5563; }
  .ch-axis { stroke: #374151; }
  .ch-meta, .ch-foot { color: #8B93A1; }
  .ch-data { border-top-color: #242A33; }
  th, td { border-color: #242A33; }
  th { background: #161A21; }
  .ch-data summary { color: #60A5FA; }
  .ch-notes { color: #FCD34D; }
}
`.trim();

function dataTable(spec: ChartSpec): string {
  const head = ['类别', ...spec.series.map((series, index) => series.name)];
  const headerCells = head
    .map((label, index) =>
      index === 0
        ? `<th>${escapeXml(label)}</th>`
        : `<th><span style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:${seriesColor(index - 1)}"></span>${escapeXml(label)}</th>`,
    )
    .join('');

  const rows = spec.categories
    .map((category, rowIndex) => {
      const cells = spec.series
        .map((series) => {
          const value = series.values[rowIndex];
          return value === null
            ? '<td class="num missing">—</td>'
            : `<td class="num">${escapeXml(formatNumber(value))}</td>`;
        })
        .join('');
      return `<tr><th scope="row" style="font-weight:400">${escapeXml(clipCell(category))}</th>${cells}</tr>`;
    })
    .join('\n');

  return `<table>\n<thead><tr>${headerCells}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
}

/**
 * 生成产物。
 *
 * `svg` 由 `renderChartSvg(spec)` 传入而不是在这里再调一次：图与表必须来自
 * **同一份规格的同一个快照**（与「审批里看到的 == 落盘的那个」同一条纪律）。
 */
export function renderChartHtml(spec: ChartSpec, svg: string): string {
  const heading = spec.title || describeChart(spec);
  const meta = `${describeChart(spec)} · 单文件自包含（无脚本、无外链），离线可直接打开`;
  const notes = spec.notes.length
    ? `<ul class="ch-notes">\n${spec.notes.map((note) => `<li>${escapeXml(note)}</li>`).join('\n')}\n</ul>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
${CHART_HTML_MARKER}
<title>${escapeXml(heading)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<header>
<h1>${escapeXml(heading)}</h1>
<p class="ch-meta">${escapeXml(meta)}</p>
</header>
<figure class="ch-figure">
${svg}
</figure>
<details class="ch-data">
<summary>数据表（${spec.categories.length} 行 × ${spec.series.length} 列）</summary>
${dataTable(spec)}
</details>
${notes}
<footer class="ch-foot">把鼠标停在柱、数据点或扇区上可看到该点数值；本页不含任何脚本。</footer>
</main>
</body>
</html>
`;
}
