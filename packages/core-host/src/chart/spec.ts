/**
 * 表格 → 图表规格（纯函数，无 IO）。
 *
 * 这一层回答的问题是「模型给的这张表，到底要画成什么」。它是整个图表能力里
 * 唯一会**拒绝**输入的地方，因此每条拒绝都必须可行动：说清收到的是什么、
 * 为什么不行、该怎么改。
 *
 * ── 两条判断值得单独说明 ────────────────────────────────────────
 *
 * 1. **首列是不是类别轴，靠数据判定并如实回报，不靠额外参数。**
 *    加一个 `firstColumnIsLabel` 开关看着更严谨，代价是模型多一个必填决策点，
 *    而它手里那张表的形态本来就已经说明了答案（首列全是文字 ⇒ 它是标签）。
 *    判定结果写进规格（`labelColumn`），回执与数据表里都会体现 ——
 *    判定错了用户看得见，而不是「图悄悄地画歪了」。
 *
 * 2. **非数字单元格按「缺测」处理并计数，不按 0。**
 *    把 `--` / `N/A` / 空单元格当成 0，图上会多出一根真实的零值柱子；
 *    那是最难发现的一类错 —— 图形正常、数据错误。缺测在折线图里断开、
 *    在柱状图里不画，数量如实报在 notes 里。
 */

import {
  CHART_MAX_CATEGORIES,
  CHART_MAX_CELL_CHARS,
  CHART_MAX_LABEL_CHARS,
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  CHART_MAX_TITLE_CHARS,
  CHART_TYPES,
  CHART_TYPE_LABEL,
  isChartType,
  type ChartType,
} from '@deepwork/protocol';
import type { CellValue } from '../office/xlsx';
import { normalizeRows } from '../tools/args';

export interface ChartSeries {
  name: string;
  /** 与 categories 一一对应；null = 缺测 */
  values: Array<number | null>;
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  categories: string[];
  series: ChartSeries[];
  xLabel?: string;
  yLabel?: string;
  /** 首列被判定为类别轴（该列没有数字） */
  labelColumn: boolean;
  /** 被判为缺测的单元格总数 */
  missing: number;
  /** 如实回报的观察：跳过的列、缺测数量、被截断的标题…… */
  notes: string[];
}

export interface ChartSpecInput {
  type: unknown;
  rows: unknown;
  title?: unknown;
  header?: unknown;
  xLabel?: unknown;
  yLabel?: unknown;
}

/** 单元格 → 文本（布尔按字面量，不转成 1/0：那是替用户猜语义） */
export function textOf(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * 单元格 → 数字。
 *
 * 只认真正的数字与「看起来就是数字」的字符串：去掉千分位与首尾货币符号后
 * 仍能被 `Number` 接受才算数。**百分号不算**——「42.9%」既可以理解成 42.9
 * 也可以理解成 0.429，替用户选一个是错的；这一列会整列被判为不可用并如实报出，
 * 由人改成小数再来。
 *
 * 布尔**不算数字**（与 textOf 的取舍一致）：一列 TRUE/FALSE 画成 0/1 的柱子
 * 看起来完全正常，但那是我们编出来的语义。
 */
export function numberOf(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/[,\uFF0C\s]/g, '').replace(/^[¥$￥]/, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 标签/表头的显示长度截断（超长不截会让坐标轴互相压在一起） */
export function clipLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > CHART_MAX_LABEL_CHARS ? `${flat.slice(0, CHART_MAX_LABEL_CHARS)}…` : flat;
}

/** 数据表与文本视图里的单元格文本 */
export function clipCell(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ').trim();
  return flat.length > CHART_MAX_CELL_CHARS ? `${flat.slice(0, CHART_MAX_CELL_CHARS)}…` : flat;
}

export function chartSpecFromRows(input: ChartSpecInput): ChartSpec {
  if (!isChartType(input.type)) {
    throw new Error(
      `type 必须是 ${CHART_TYPES.join(' / ')} 之一（收到「${input.type === undefined ? '(缺失)' : String(input.type)}」）`,
    );
  }
  const type = input.type;
  const notes: string[] = [];

  const table = normalizeRows(input.rows);
  if (table.length === 0) throw new Error('rows 是空的，至少要有一行表头与一行数据');

  const header = input.header !== false;
  const headerRow = header ? table[0] : null;
  const dataRows = header ? table.slice(1) : table;

  if (dataRows.length === 0) {
    throw new Error(header ? 'rows 只有表头，没有数据行' : 'rows 里没有数据行');
  }
  if (dataRows.length > CHART_MAX_POINTS) {
    throw new Error(
      `数据行 ${dataRows.length} 行，超过上限 ${CHART_MAX_POINTS}；请先聚合（按月/按周），或改用表格工具`,
    );
  }
  if (type !== 'line' && dataRows.length > CHART_MAX_CATEGORIES) {
    throw new Error(
      `${CHART_TYPE_LABEL[type]}的类别最多 ${CHART_MAX_CATEGORIES} 个，收到 ${dataRows.length} 个；` +
        '请先聚合成更少的类别，或改用折线图',
    );
  }
  if (!header) {
    notes.push('未提供表头（header=false）：系列按「系列 1…N」编号');
  }

  // 手写循环而不是 Math.max(...rows)：后者在行数上万时会把参数展开成爆栈
  let width = 0;
  for (const row of table) if (row.length > width) width = row.length;
  if (width === 0) throw new Error('rows 的每一行都是空的');

  const labelColumn = dataRows.every((row) => numberOf(row[0]) === null);
  const numericColumns: number[] = [];
  for (let column = labelColumn ? 1 : 0; column < width; column += 1) numericColumns.push(column);

  if (numericColumns.length === 0) {
    throw new Error(
      '没有可画的数值列：首列被判定为类别轴（整列都不是数字），而后面没有别的列。' +
        '请补一列数字，或去掉那一列标签',
    );
  }
  if (numericColumns.length > CHART_MAX_SERIES) {
    throw new Error(
      `数值列 ${numericColumns.length} 列，超过系列上限 ${CHART_MAX_SERIES}；请分次出图，或先做汇总`,
    );
  }

  const categories = dataRows.map((row, index) => {
    if (!labelColumn) return String(index + 1);
    const text = textOf(row[0]).trim();
    return text === '' ? `#${index + 1}` : clipLabel(text);
  });

  const usedNames = new Map<string, number>();
  const series: ChartSeries[] = [];
  let missing = 0;
  // 短行只统计一次：放进按列的循环里会让同一个短行被每个系列各算一遍
  const shortRows = dataRows.filter((row) => row.length < width).length;

  for (const column of numericColumns) {
    const headerText = headerRow ? textOf(headerRow[column]).trim() : '';
    const base = clipLabel(headerText) || `系列 ${series.length + 1}`;
    const seen = usedNames.get(base) ?? 0;
    usedNames.set(base, seen + 1);
    const name = seen === 0 ? base : `${base} (${seen + 1})`;
    if (seen > 0) notes.push(`列名「${base}」重复，第二个起加了序号后缀`);

    const values: Array<number | null> = [];
    let numericCount = 0;
    for (const row of dataRows) {
      const value = numberOf(row[column] ?? null);
      if (value === null) {
        values.push(null);
        continue;
      }
      numericCount += 1;
      values.push(value);
    }

    if (numericCount === 0) {
      notes.push(`「${name}」列没有可用的数值（整列都是文本或空），已跳过`);
      continue;
    }
    const missingHere = dataRows.length - numericCount;
    if (missingHere > 0) missing += missingHere;
    series.push({ name, values });
  }

  if (series.length === 0) {
    throw new Error(
      '没有任何一列包含可用数值。数值列只认数字与写成数字的文本（「42.9%」「N/A」这类不算）；' +
        '请把这些单元格改成纯数字后重试',
    );
  }

  if (missing > 0) notes.push(`${missing} 个单元格不是数字，按缺测处理（折线断开、柱状图不画）`);
  if (shortRows > 0) notes.push(`有 ${shortRows} 行比表头短，缺失的单元格按缺测处理`);

  if (type === 'pie') {
    if (series.length > 1) {
      throw new Error(
        `饼图只接受一个数值列，收到 ${series.length} 个（${series.map((s) => `「${s.name}」`).join('、')}）。` +
          '请把 rows 缩到两列（类别 + 数值）后重试，或改用柱状图',
      );
    }
    const only = series[0];
    let negative: number | null = null;
    for (const value of only.values) {
      if (value !== null && value < 0) {
        negative = value;
        break;
      }
    }
    if (negative !== null) {
      throw new Error(
        `饼图不能表示负值（列「${only.name}」里有 ${negative}）；请改用柱状图或折线图`,
      );
    }
    const total = only.values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    if (total <= 0) {
      throw new Error(`饼图需要一个总和为正的数值列（列「${only.name}」的总和是 ${total}）`);
    }
  }

  const rawTitle = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
  let title = rawTitle;
  if (rawTitle.length > CHART_MAX_TITLE_CHARS) {
    title = `${rawTitle.slice(0, CHART_MAX_TITLE_CHARS)}…`;
    notes.push(`标题超过 ${CHART_MAX_TITLE_CHARS} 字，已截断显示`);
  }

  const axisLabel = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat === '' ? undefined : clipLabel(flat);
  };

  return {
    type,
    title,
    categories,
    series,
    xLabel: axisLabel(input.xLabel),
    yLabel: axisLabel(input.yLabel),
    labelColumn,
    missing,
    notes,
  };
}

/** 数据点总数（回执与测试的参照物） */
export function chartPointCount(spec: ChartSpec): number {
  return spec.categories.length * spec.series.length;
}
