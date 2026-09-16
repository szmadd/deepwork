/**
 * 图表规格 → SVG（纯函数，无 IO、无时钟、无随机）。
 *
 * ── 为什么手写 SVG ────────────────────────────────────────────────
 * 引 Chart.js / ECharts 的代价不是体积，而是**产物不再自包含**：脚本要内联进
 * 每个 HTML、离线打开要么失败要么留一个空框、而应用内的预览 iframe 是禁脚本的，
 * 于是「界面里看到的」与「双击打开看到的」成了两张不同的图。手写 SVG 与
 * `office/zip.ts` 手写 zip、`tools/make-icon.js` 手写 PNG 同源。
 *
 * ── 可复现 ────────────────────────────────────────────────────────
 * 输出里不含时间戳、不含随机 id。字体在产物里写的是**字体族列表**，
 * 布局用等宽估算（`estimateTextWidth`）而不是测量真实字形 ——
 * 后者要么依赖 canvas（浏览器里才有），要么依赖字体文件，两条路都会让
 * 「同一份数据在别的机器上生成出不同字节」。
 *
 * ── 配色分成两类，别混 ────────────────────────────────────────────
 * - **数据颜色内联**（柱/线/扇区的 `fill` / `stroke`）：产物离开样式表也能看懂，
 *   而且这套中间调配色在浅色与深色底上都成立。
 * - **结构颜色走 class**（轴、网格、刻度文字）：它们必须随主题反转，
 *   而 `@media (prefers-color-scheme: dark)` 只能通过样式表生效。
 */

import { CHART_TYPE_LABEL } from '@deepwork/protocol';
import { escapeXml } from '../office/xml';
import type { ChartSeries, ChartSpec } from './spec';

const W = 960;
const H = 560;
const PAD = { top: 24, right: 32, bottom: 64, left: 88 };
const TITLE_SIZE = 20;
const TITLE_BAND = 40;
const LEGEND_SIZE = 13;
const LEGEND_ITEM_H = 22;
const LEGEND_SWATCH = 12;
const LEGEND_GAP = 20;
const TICK_SIZE = 12;
const VALUE_SIZE = 11;

/**
 * 数据配色（12 色）。
 *
 * 选的是中间调：浅色底上不糊、深色底上不刺眼。因此它可以内联进产物，
 * 不需要随主题换一套 —— 换套意味着同一份数据在两种主题下颜色含义不同，
 * 而图例、图注、截图交叉引用时没人记得住「那个绿色的系列在深色里是哪个」。
 */
export const CHART_PALETTE = [
  '#3B82F6',
  '#F59E0B',
  '#10B981',
  '#EF4444',
  '#8B5CF6',
  '#06B6D4',
  '#EC4899',
  '#84CC16',
  '#F97316',
  '#14B8A6',
  '#6366F1',
  '#EAB308',
] as const;

export function seriesColor(index: number): string {
  return CHART_PALETTE[((index % CHART_PALETTE.length) + CHART_PALETTE.length) % CHART_PALETTE.length];
}

/** 文本宽度估算：CJK 记 1 em、其余记 0.55 em。够用来排图例与决定刻度稀疏度 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) units += /[\u2E80-\uFFFF]/.test(char) ? 1 : 0.55;
  return units * fontSize;
}

/** 数值显示：万 / 亿 分级 + 千分位。轴上写 1,234,567 会把宽度全吃掉 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${trimNumber(value / 1e8)}亿`;
  if (abs >= 1e4) return `${trimNumber(value / 1e4)}万`;
  return groupThousands(trimNumber(value));
}

/** 去掉无意义的小数尾巴（注意只在小数点存在时才剥零，否则 100 会变成 1） */
function trimNumber(value: number): string {
  const fixed = value.toFixed(2);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function groupThousands(text: string): string {
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 把步长掰成 1 / 2 / 2.5 / 5 × 10^n —— 刻度才会落在人读得顺的数上 */
function niceStep(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const exponent = Math.floor(Math.log10(rough));
  const base = rough / 10 ** exponent;
  const multiplier = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
  return multiplier * 10 ** exponent;
}

interface Scale {
  lo: number;
  hi: number;
  ticks: number[];
}

/**
 * 值域与刻度。
 *
 * `includeZero` 是柱状图的硬要求：柱子的高度就是「相对 0 的量」，
 * 起点不是 0 的柱状图会让 3 与 4 的差别看起来像 3 倍。
 */
export function buildScale(values: number[], includeZero: boolean, tickCount = 5): Scale {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) {
    if (lo === 0) {
      lo = 0;
      hi = 1;
    } else {
      const pad = Math.abs(lo) * 0.5;
      lo -= pad;
      hi += pad;
    }
  }

  const step = niceStep((hi - lo) / tickCount);
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hi / step) * step;
  const count = Math.max(1, Math.round((niceHi - niceLo) / step));
  const ticks: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    ticks.push(roundToStep(niceLo + index * step, step));
  }
  return { lo: niceLo, hi: niceHi, ticks };
}

/** 消除浮点累积（0.1 连加会得到 0.30000000000000004，刻度上就是一行脏数字） */
function roundToStep(value: number, step: number): number {
  const decimals = Math.min(10, Math.max(0, -Math.floor(Math.log10(step)) + 1));
  return Number(value.toFixed(decimals));
}

function escapeOrEmpty(text: string): string {
  return escapeXml(text);
}

interface LegendItem {
  index: number;
  label: string;
  x: number;
  width: number;
}

/** 图例分行：宽度不够就换行，而不是让最后几项叠在一起 */
export function layoutLegend(labels: string[], available: number): LegendItem[][] {
  const rows: LegendItem[][] = [];
  let current: LegendItem[] = [];
  let cursor = 0;
  labels.forEach((label, index) => {
    const width = LEGEND_SWATCH + 6 + estimateTextWidth(label, LEGEND_SIZE);
    if (current.length > 0 && cursor + width > available) {
      rows.push(current);
      current = [];
      cursor = 0;
    }
    current.push({ index, label, x: cursor, width });
    cursor += width + LEGEND_GAP;
  });
  if (current.length > 0) rows.push(current);
  return rows.length > 0 ? rows : [[]];
}

/** 饼图的图例标签带占比 —— 扇区里放不下的信息得有地方去 */
function pieLegendLabels(spec: ChartSpec): string[] {
  const values = spec.series[0].values;
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return spec.categories.map((name, index) => {
    const value = values[index] ?? 0;
    const pct = total > 0 ? (value / total) * 100 : 0;
    return `${name} ${formatNumber(value)} (${pct.toFixed(1)}%)`;
  });
}

/** 轴标题 / X 轴刻度：类别多到写不下时按步长抽稀（只写有序号那一档） */
function pickCategoryStep(categories: string[], plotWidth: number): number {
  if (categories.length <= 1) return 1;
  let widest = 0;
  for (const name of categories) {
    const width = estimateTextWidth(name, TICK_SIZE);
    if (width > widest) widest = width;
  }
  const slot = widest + 14;
  return Math.max(1, Math.ceil((categories.length * slot) / plotWidth));
}

export function renderChartSvg(spec: ChartSpec): string {
  const legendLabels = spec.type === 'pie' ? pieLegendLabels(spec) : spec.series.map((s) => s.name);
  const legendRows = layoutLegend(legendLabels, W - PAD.left - PAD.right);

  const titleBand = spec.title ? PAD.top + TITLE_BAND : PAD.top + 8;
  const legendTop = titleBand;
  const plotTop = legendTop + legendRows.length * LEGEND_ITEM_H + 14;
  const plotBottom = H - PAD.bottom;
  const plotLeft = PAD.left;
  const plotRight = W - PAD.right;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const body: string[] = [];
  if (spec.title) {
    body.push(
      `<text class="ch-title" x="${PAD.left}" y="${PAD.top + TITLE_SIZE}">${escapeOrEmpty(spec.title)}</text>`,
    );
  }
  legendRows.forEach((row, rowIndex) => {
    const y = legendTop + rowIndex * LEGEND_ITEM_H + 12;
    for (const item of row) {
      const x = PAD.left + item.x;
      body.push(
        `<rect class="ch-legend-swatch" x="${x}" y="${y - LEGEND_SWATCH}" width="${LEGEND_SWATCH}" height="${LEGEND_SWATCH}" rx="3" fill="${seriesColor(item.index)}"/>`,
        `<text class="ch-legend-text" x="${x + LEGEND_SWATCH + 6}" y="${y - 1}">${escapeOrEmpty(item.label)}</text>`,
      );
    }
  });

  const axisNote = spec.yLabel && spec.type !== 'pie' ? ` · ${spec.yLabel}` : '';
  const desc = `${CHART_TYPE_LABEL[spec.type]}，${spec.series.length} 个系列 × ${spec.categories.length} 个类别${axisNote}`;

  if (spec.type === 'pie') {
    body.push(renderPie(spec, { plotLeft, plotRight, plotTop, plotBottom }));
  } else {
    body.push(
      renderCartesian(spec, {
        plotLeft,
        plotRight,
        plotTop,
        plotBottom,
        plotWidth,
        plotHeight,
      }),
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(desc)}">`,
    `<title>${escapeOrEmpty(spec.title || desc)}</title>`,
    `<desc>${escapeOrEmpty(desc)}</desc>`,
    ...body,
    '</svg>',
  ].join('\n');
}

interface PlotBox {
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  plotWidth: number;
  plotHeight: number;
}

function renderCartesian(spec: ChartSpec, box: PlotBox): string {
  const { plotLeft, plotRight, plotTop, plotBottom, plotWidth, plotHeight } = box;
  const parts: string[] = [];

  const allValues: number[] = [];
  for (const series of spec.series) {
    for (const value of series.values) if (value !== null) allValues.push(value);
  }
  // 柱状图必须含 0（柱高就是相对 0 的量）；折线图不含 0，否则噪声被压平
  const scale = buildScale(allValues, spec.type === 'bar');
  const yOf = (value: number): number =>
    plotBottom - ((value - scale.lo) / (scale.hi - scale.lo)) * plotHeight;

  // ── 网格与刻度 ───────────────────────────────────────────────
  for (const tick of scale.ticks) {
    const y = yOf(tick);
    parts.push(
      `<line class="ch-grid" x1="${plotLeft}" y1="${round2(y)}" x2="${plotRight}" y2="${round2(y)}"/>`,
      `<text class="ch-tick" x="${plotLeft - 10}" y="${round2(y + 4)}" text-anchor="end">${escapeOrEmpty(formatNumber(tick))}</text>`,
    );
  }
  // 零线单独画：柱状图有正有负时，它是「哪边是正」的唯一视觉依据
  if (scale.lo < 0 && scale.hi > 0) {
    const zero = yOf(0);
    parts.push(
      `<line class="ch-zero" x1="${plotLeft}" y1="${round2(zero)}" x2="${plotRight}" y2="${round2(zero)}"/>`,
    );
  }
  parts.push(
    `<line class="ch-axis" x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}"/>`,
    `<line class="ch-axis" x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}"/>`,
  );

  const categories = spec.categories;
  const count = categories.length;
  const step = pickCategoryStep(categories, plotWidth);

  if (spec.type === 'bar') {
    const groupWidth = plotWidth / count;
    const inner = Math.min(groupWidth * 0.18, 12);
    const barTotal = Math.max(groupWidth - inner * 2, 1);
    const barWidth = Math.max(barTotal / spec.series.length, 1);
    const baseline = yOf(0);
    const showValue = count * spec.series.length <= 24;

    spec.series.forEach((series, seriesIndex) => {
      const color = seriesColor(seriesIndex);
      series.values.forEach((value, index) => {
        if (value === null) return;
        const x = plotLeft + groupWidth * index + inner + barWidth * seriesIndex;
        const top = yOf(value);
        const y = Math.min(top, baseline);
        const height = Math.abs(baseline - top);
        const tip = `${categories[index]} · ${series.name}: ${formatNumber(value)}`;
        parts.push(
          `<rect class="ch-bar" x="${round2(x)}" y="${round2(y)}" width="${round2(barWidth)}" height="${round2(height)}" rx="2" fill="${color}"><title>${escapeOrEmpty(tip)}</title></rect>`,
        );
        if (showValue) {
          const labelY = value >= 0 ? top - 5 : top + 13;
          parts.push(
            `<text class="ch-value" x="${round2(x + barWidth / 2)}" y="${round2(labelY)}" text-anchor="middle">${escapeOrEmpty(formatNumber(value))}</text>`,
          );
        }
      });
    });
  } else {
    const showMarkers = count <= 60;
    const xOf = (index: number): number =>
      count === 1 ? (plotLeft + plotRight) / 2 : plotLeft + (plotWidth * index) / (count - 1);

    spec.series.forEach((series, seriesIndex) => {
      const color = seriesColor(seriesIndex);
      for (const run of runsOf(series)) {
        if (run.length >= 2) {
          const points = run.map((index) => `${round2(xOf(index))},${round2(yOf(series.values[index] as number))}`);
          parts.push(
            `<polyline class="ch-line" points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`,
          );
        }
      }
      if (showMarkers) {
        series.values.forEach((value, index) => {
          if (value === null) return;
          const tip = `${categories[index]} · ${series.name}: ${formatNumber(value)}`;
          parts.push(
            `<circle class="ch-dot" cx="${round2(xOf(index))}" cy="${round2(yOf(value))}" r="3.5" fill="${color}"><title>${escapeOrEmpty(tip)}</title></circle>`,
          );
        });
      }
    });
  }

  // ── X 轴刻度 ────────────────────────────────────────────────
  const slotCenter = (index: number): number =>
    spec.type === 'bar'
      ? plotLeft + (plotWidth / count) * (index + 0.5)
      : count === 1
        ? (plotLeft + plotRight) / 2
        : plotLeft + (plotWidth * index) / (count - 1);

  /*
   * X 轴刻度按步长抽稀，并**尽量补上末位**。
   *
   * 只按 `index % step === 0` 画的话，末位常常空着 —— 而末位往往是读者最关心的
   * 那个时间点（本月、最新一季）。补的条件是「离前一个标注还有半个字的余量」，
   * 不够就让位：叠在一起的两行字比少一个标注更糟。
   */
  const drawn: number[] = [];
  for (let index = 0; index < count; index += step) drawn.push(index);
  const last = count - 1;
  if (drawn[drawn.length - 1] !== last) {
    const gap = slotCenter(last) - slotCenter(drawn[drawn.length - 1]);
    const needed =
      (estimateTextWidth(categories[drawn[drawn.length - 1]], TICK_SIZE) +
        estimateTextWidth(categories[last], TICK_SIZE)) /
        2 +
      10;
    if (gap > needed) drawn.push(last);
  }
  for (const index of drawn) {
    parts.push(
      `<text class="ch-tick" x="${round2(slotCenter(index))}" y="${plotBottom + 18}" text-anchor="middle">${escapeOrEmpty(categories[index])}</text>`,
    );
  }

  if (spec.xLabel) {
    parts.push(
      `<text class="ch-axis-label" x="${round2((plotLeft + plotRight) / 2)}" y="${H - 22}" text-anchor="middle">${escapeOrEmpty(spec.xLabel)}</text>`,
    );
  }
  if (spec.yLabel) {
    const cy = (plotTop + plotBottom) / 2;
    parts.push(
      `<text class="ch-axis-label" x="24" y="${round2(cy)}" text-anchor="middle" transform="rotate(-90 24 ${round2(cy)})">${escapeOrEmpty(spec.yLabel)}</text>`,
    );
  }

  return parts.join('\n');
}

/** 连续的「非缺测」下标段：折线遇到缺测要断开，而不是从缺口上直连过去 */
function runsOf(series: ChartSeries): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  series.values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) runs.push(current);
      current = [];
      return;
    }
    current.push(index);
  });
  if (current.length > 0) runs.push(current);
  return runs;
}

function renderPie(spec: ChartSpec, box: Omit<PlotBox, 'plotWidth' | 'plotHeight'>): string {
  const { plotLeft, plotRight, plotTop, plotBottom } = box;
  const series = spec.series[0];
  const values = series.values.map((value) => value ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const cx = (plotLeft + plotRight) / 2;
  const cy = (plotTop + plotBottom) / 2;
  const radius = Math.max(20, Math.min(plotRight - plotLeft, plotBottom - plotTop) / 2 - 16);
  const parts: string[] = [];

  // 单个扇区（100%）时弧线路径会退化成一条直线，必须走整圆分支
  const nonZero = values.filter((value) => value > 0).length;
  if (nonZero === 1) {
    const index = values.findIndex((value) => value > 0);
    parts.push(
      `<circle class="ch-slice" cx="${round2(cx)}" cy="${round2(cy)}" r="${round2(radius)}" fill="${seriesColor(index)}"><title>${escapeOrEmpty(`${spec.categories[index]} · ${formatNumber(values[index])} (100.0%)`)}</title></circle>`,
    );
    return parts.join('\n');
  }

  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    const share = total > 0 ? value / total : 0;
    const sweep = share * Math.PI * 2;
    const start = angle;
    const end = angle + sweep;
    angle = end;
    if (share <= 0) return;

    const x0 = cx + radius * Math.cos(start);
    const y0 = cy + radius * Math.sin(start);
    const x1 = cx + radius * Math.cos(end);
    const y1 = cy + radius * Math.sin(end);
    const largeArc = sweep > Math.PI ? 1 : 0;
    const tip = `${spec.categories[index]} · ${formatNumber(value)} (${(share * 100).toFixed(1)}%)`;
    parts.push(
      `<path class="ch-slice" d="M ${round2(cx)} ${round2(cy)} L ${round2(x0)} ${round2(y0)} A ${round2(radius)} ${round2(radius)} 0 ${largeArc} 1 ${round2(x1)} ${round2(y1)} Z" fill="${seriesColor(index)}"><title>${escapeOrEmpty(tip)}</title></path>`,
    );

    // 扇区里放得下的才写占比：放不下的挤在边缘比不写更难看，且同样读不出来
    if (share >= 0.05) {
      const mid = (start + end) / 2;
      const lx = cx + radius * 0.68 * Math.cos(mid);
      const ly = cy + radius * 0.68 * Math.sin(mid);
      parts.push(
        `<text class="ch-slice-label" x="${round2(lx)}" y="${round2(ly + 4)}" text-anchor="middle">${(share * 100).toFixed(1)}%</text>`,
      );
    }
  });

  return parts.join('\n');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 供产物页脚与回执复用的规格描述 */
export function describeChart(spec: ChartSpec): string {
  return `${CHART_TYPE_LABEL[spec.type]} · ${spec.series.length} 系列 × ${spec.categories.length} 类别`;
}
