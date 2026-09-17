/**
 * 图表与可视化契约（FR-3.8）。
 *
 * ── 三条产品判断（写在最前面，改实现前先读）──────────────────────
 *
 * 1. **口径以「数据 → 自包含 HTML」为主，不是「面板内可视化」。**
 *    产物是一个能双击打开、能发给别人、能进版本库的文件；而「面板内渲染」只是
 *    同一份产物的一种查看方式。反过来做（数据只存在会话里、图只活在应用内）
 *    会让图表变成第二类事实：换台机器、或者把这个会话发给别人，图就没了。
 *
 * 2. **交互 = 无脚本的交互。** 需求原文是「生成可交互视图」，但这里**不生成任何
 *    脚本**：悬停提示用 SVG 原生的 `<title>`、数据表用 `<details>` 折叠、
 *    强调用 CSS `:hover`。理由是产物必须能在**禁脚本**的上下文里原样呈现 ——
 *    应用内的预览走 `sandbox=""` 的 iframe（无脚本权限），若图表依赖 JS 渲染，
 *    「界面里看到的」与「浏览器里打开的」就是两张不同的图。宁可交互朴素，
 *    也不要同一种产物有两种长相。
 *
 * 3. **零第三方依赖，且不引图表库。** 手写 SVG 生成器（与
 *    `office/zip.ts` 手写 zip、`tools/make-icon.js` 手写 PNG 同源）。
 *    引 Chart.js / ECharts 意味着：几百 KB 的脚本要内联进每个产物、
 *    离线打开要么失败要么留一个空框、预览 iframe 因为禁脚本而永远画不出来。
 *
 * ── 两条看不见的纪律 ──────────────────────────────────────────────
 *
 * - **字节可复现。** 同一份 spec 必须产出逐字节相同的 HTML：产物里**不写生成时间、
 *   不写随机 id**。写一个「生成于 2026-09-16 15:04」看着更友好，代价是同一份数据
 *   两次生成的哈希不同 —— 所有靠字节比对的断言（无变化短路、差异预览、回放）
 *   会集体失效，而且失效方式很安静。这条与 `zipWrite` 固定 DOS 时间戳同源。
 * - **字节不进事件日志。** 产物是 HTML，在事件流里只留路径、字节数与
 *   **文本视图**（数据表）。见 builtin.ts 的审批说明。
 *
 * ── 一句话说清与 Office 的关系 ────────────────────────────────────
 * `office.xlsx` 与 `chart.render` 的数据入参形状**刻意相同**（二维数组或
 * Markdown 管道表格）：模型手里常常已经有一张表，让它为「出表」和「出图」
 * 准备两套格式，多出来的那一步就是多一类出错。差别只在于产物：
 * xlsx 给下游加工，HTML 给人看。
 */

import type { RiskLevel } from './security';

/** 生成一张图表（HTML，内联 SVG 与数据表） */
export const CHART_TOOL = 'chart.render';

export const CHART_TOOLS: readonly string[] = [CHART_TOOL];

/**
 * 内置图表 MCP 服务的 serverName。
 *
 * 为什么图表能力要额外做成 MCP 服务，而不是只注册进宿主工具注册表：
 * 注册表**只在 mock 适配器下被执行**，真实内核（dsh）有它自己的一套模型可见工具，
 * 我们在注册表里注册什么它都看不见 —— 只做注册表的话，「模型能画图」这件事
 * 在开发期完全看不出来（mock 下一切正常）。内核原生支持 MCP，所以正统路径是
 * 把它做成 MCP 服务由宿主写进 `--patch`。与浏览器能力同一条路（见 browser/mcp-server.ts）。
 *
 * 名字不含点号：`mcp__<serverName>__<tool>` 会进模型可见的工具名，
 * 而模型 API 对 function name 限制为 `^[a-zA-Z0-9_-]{1,64}$`。
 */
export const CHART_MCP_SERVER_NAME = 'deepwork_chart';

/** 内核侧（模型可见）的工具名；公开全名是 `mcp__deepwork_chart__chart_render` */
export const CHART_MCP_TOOL = 'chart_render';

/** 产物的扩展名。与 docx / xlsx 同理：名字与内容不符的文件会误导之后所有读它的人 */
export const CHART_EXTENSION = '.html';

/**
 * 产物标记。
 *
 * 应用内的「渲染」视图**只对带这个标记的 HTML 提供** —— 「渲染」这个动作的语义是
 * 「我刚才生成的那个东西长什么样」，而不是「一个通用 HTML 浏览器」。
 * 这**不是**安全边界（工作区里的文件本来就能被模型改写），而是范围划分：
 * 把渲染视图留给自家产物，任意 HTML 一律按源码显示，要看渲染结果用系统浏览器。
 */
export const CHART_HTML_MARKER = '<!-- generated-by: deepwork-chart v1 -->';

export type ChartType = 'bar' | 'line' | 'pie';

export const CHART_TYPES: readonly ChartType[] = ['bar', 'line', 'pie'];

export const CHART_TYPE_LABEL: Record<ChartType, string> = {
  bar: '柱状图',
  line: '折线图',
  pie: '饼图',
};

export function isChartType(value: unknown): value is ChartType {
  return typeof value === 'string' && (CHART_TYPES as readonly string[]).includes(value);
}

// ── 规模上限（超过就报错，而不是悄悄截断一半数据）──────────────────

/**
 * 折线图的单个系列数据点上限。
 *
 * 折线图对点数不敏感（画布 960px 宽，点多了只是线密一些），所以给得宽。
 * 超过它说明模型该先聚合（按月/按周）而不是把 10000 个原始采样点塞进一张图。
 */
export const CHART_MAX_POINTS = 1200;
/**
 * 柱状图 / 饼图的类别上限。
 *
 * 这两个图型对类别数是**结构性**敏感的，不是审美问题：960px 宽的画布上
 * 60 根柱子已经是 16px/根，再多就没有可读的柱宽；饼图的 60 个扇区更是
 * 每个不足 6°，除了「有一块很大」之外读不出任何东西 —— 而它会「看起来成功了」。
 */
export const CHART_MAX_CATEGORIES = 60;
/** 系列数上限（超过后图例比绘图区还高） */
export const CHART_MAX_SERIES = 12;
/** 类别轴标签 / 系列名的显示长度上限（超出截断并加省略号） */
export const CHART_MAX_LABEL_CHARS = 24;
/** 标题长度上限 */
export const CHART_MAX_TITLE_CHARS = 120;
/** 单个数据表单元格的文本上限（与 xlsx 的 32767 同量级，取保守值） */
export const CHART_MAX_CELL_CHARS = 200;

/**
 * 工具风险档。
 *
 * 写文件 = confirm，与 `office.docx` / `office.xlsx` 一致：它会在用户的工作区里
 * 落一个文件，用户必须在批准前看见「将要写什么」。内核侧（MCP）那一份
 * 由 `harness-sidecar.ts` 的 `mcp__` 前缀规则给到 confirm，两处结论必须一致。
 */
export const CHART_TOOL_RISK: Record<string, RiskLevel> = {
  [CHART_TOOL]: 'confirm',
};

// ── 入参的单一事实来源 ──────────────────────────────────────────

/**
 * 入参表。
 *
 * 存量的做法是「宿主工具写一份中文描述、MCP 写一份 JSON Schema」，两处对不上时
 * 没有任何报错 —— 模型按描述传参、schema 却拒绝，报出来的错与真正的原因无关。
 * 这里把两者都从这张表派生（`chartParameterDescriptions` / `chartInputJsonSchema`），
 * 测试里有一条断言钉住「两个形状来自同一张表」。
 */
export interface ChartArgSpec {
  name: string;
  /**
   * JSON Schema 的 type；`'string|array'` 是**内部伪类型**（表示「字符串或数组」二选一），
   * 生成 schema 时由 `chartInputJsonSchema` 翻译成合法的 anyOf —— 它本身不是合法
   * JSON Schema，直接发出去会被真实端点拒绝（2026-09-17 实测：DeepSeek function
   * calling 报 `Invalid schema for function 'mcp__deepwork_chart__chart_render'`，
   * 整个 turn 失败）。替身端点不校验 schema，这个形状只有真端点能验出来。
   */
  jsonType: string;
  required: boolean;
  /** 一句中文说明，同时作为宿主工具的 parameters 文案 */
  description: string;
}

export const CHART_ARGS: readonly ChartArgSpec[] = [
  {
    name: 'path',
    jsonType: 'string',
    required: true,
    description: 'string，相对工作区的路径（.html 结尾；无扩展名会自动补上，其他扩展名会被拒绝）',
  },
  {
    name: 'type',
    jsonType: 'string',
    required: true,
    description: `string，图表类型：${CHART_TYPES.join(' / ')}（分别对应${CHART_TYPES.map((t) => CHART_TYPE_LABEL[t]).join('、')}）`,
  },
  {
    name: 'rows',
    jsonType: 'string|array',
    required: true,
    description:
      '二维数组（数组的数组，单元格可为字符串/数字/布尔），或一段 Markdown 管道表格字符串；' +
      '首行默认是表头，首列若全是非数字则自动作为类别轴',
  },
  { name: 'title', jsonType: 'string', required: false, description: 'string，可选，图表标题' },
  {
    name: 'header',
    jsonType: 'boolean',
    required: false,
    description: 'boolean，可选，首行是否为表头（表头即系列名），默认 true',
  },
  { name: 'xLabel', jsonType: 'string', required: false, description: 'string，可选，X 轴标题' },
  { name: 'yLabel', jsonType: 'string', required: false, description: 'string，可选，Y 轴标题' },
];

/** 宿主工具注册表的 parameters 形状（参数名 → 中文说明） */
export function chartParameterDescriptions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of CHART_ARGS) out[arg.name] = arg.description;
  return out;
}

/** MCP 的 inputSchema（JSON Schema 最小子集） */
export function chartInputJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of CHART_ARGS) {
    let spec: Record<string, unknown>;
    if (arg.jsonType === 'string|array') {
      // rows：Markdown 管道表格字符串 或 二维数组，二选一 → 合法的 anyOf 联合。
      // 二维数组的单元格类型用 anyOf 平铺而不是 type 数组：两种写法都是合法
      // JSON Schema，但端点侧的严格校验器对嵌套形状的容忍度以实测为准，
      // 平铺是最没有歧义的形态。
      spec = {
        anyOf: [
          { type: 'string' },
          {
            type: 'array',
            items: {
              type: 'array',
              items: {
                anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
              },
            },
          },
        ],
        description: arg.description,
      };
    } else {
      spec = { type: arg.jsonType, description: arg.description };
    }
    properties[arg.name] = spec;
    if (arg.required) required.push(arg.name);
  }
  return { type: 'object', properties, required };
}

/** 工具给人的一句话说明（宿主工具与 MCP 共用同一句，避免两处措辞分叉） */
export function chartToolDescription(): string {
  return (
    '在工作区生成一张图表（自包含 HTML：内联 SVG + 数据表，双击即可用浏览器打开，无需联网）。' +
    `支持${CHART_TYPES.map((t) => CHART_TYPE_LABEL[t]).join(' / ')}；` +
    '数据传二维数组或一段 Markdown 管道表格，首行是表头；首列若全是非数字则自动作为类别轴'
  );
}

/** 生成结果（宿主工具回执与 MCP 文本共用的摘要字段） */
export interface ChartWriteResult {
  /** 相对工作区的路径，/ 分隔 */
  path: string;
  type: ChartType;
  bytes: number;
  created: boolean;
  /** 类别数 × 系列数 */
  categories: number;
  series: number;
  /** 一句话摘要，例如「柱状图 / 3 系列 × 12 类别 / 18.4 KB」 */
  summary: string;
}
