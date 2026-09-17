'use strict';

/**
 * 图表与可视化能力（FR-3.8）测试 —— 渲染、边界、工具链、MCP、内核补丁、界面接线。
 *
 *   npm run test:chart
 *
 * ── 这一层为什么必须有 ───────────────────────────────────────────
 * 「生成一张图」最容易出现的失败形态是**图看着没问题但内容不对**：
 * 柱子少了一根（缺测被当成 0 或不画）、系列名对不上列、饼图悄悄取了第一列、
 * 数值被 4 舍 5 入到读不出来。图形正确、数据错误 —— 而且没有人会去数柱子。
 * 因此断言必须落在**产物的字面内容**上（SVG 元素的数量与坐标、数据表里的数字、
 * 拒绝时的具体措辞），而不是「函数返回了一个字符串」。
 *
 * ── 三件独立于实现的事 ───────────────────────────────────────────
 *   1. **字节可复现**：同一份 spec 两次生成必须逐字节相同，否则「无变化短路」
 *      与差异预览会以「每次都有变化」的方式静默失效；
 *   2. **另一个实现的复核**：产物的 SVG 交给 **Python 的 ElementTree** 解析
 *      （本项目无关的第二实现），证明它是良构 XML；HTML 交给 html.parser
 *      确认**没有脚本、没有外链**。自己写的字符串被自己的正则认可，什么都不证明；
 *   3. **真实进程往返**：MCP 服务按 stdio 真拉起来、真握手、真落盘。
 *
 * ── 界面渲染那一条不在这里 ───────────────────────────────────────
 * 「预览里真的画出来了」由 artifacts/ui-chart.png 取证（tools/capture.sh 的
 * chart 场景）。Electron 的启动既慢又依赖本机装了什么东西，塞进 verify 会让
 * 基线在别人的机器上随机变红 —— 与 office 的「真实 WPS 打开」同一处置。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-chart-'));
const workspace = path.join(home, 'ws');
fs.mkdirSync(workspace, { recursive: true });
process.env.DEEPWORK_HOME = home;

const {
  CHART_ARGS,
  CHART_EXTENSION,
  CHART_HTML_MARKER,
  CHART_MAX_CATEGORIES,
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  CHART_MCP_SERVER_NAME,
  CHART_MCP_TOOL,
  CHART_TOOL,
  CHART_TOOLS,
  CHART_TOOL_RISK,
  CHART_TYPES,
  chartInputJsonSchema,
  chartParameterDescriptions,
} = require('../packages/protocol/dist/chart');
const {
  chartPointCount,
  chartSpecFromRows,
  clipLabel,
  numberOf,
  textOf,
} = require('../packages/core-host/dist/chart/spec');
const { buildScale, estimateTextWidth, formatNumber, seriesColor } = require('../packages/core-host/dist/chart/svg');
const { chartOutputText, planChart } = require('../packages/core-host/dist/chart/plan');
const {
  buildBuiltinMcpPatch,
  buildChartMcpPatch,
  buildRuntimePatch,
  serializeRuntimePatchYaml,
} = require('../packages/core-host/dist/mcp/patch');
const { ToolRegistry, createToolContext, ALLOW_ALL, DENY_ALL } = require('../packages/core-host/dist/tools/registry');
const { registerBuiltinTools } = require('../packages/core-host/dist/tools/builtin');
const { mapUpdateToEvent } = require('../packages/core-host/dist/adapter/harness-sidecar');

const root = path.resolve(__dirname, '..');
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function skippable(name, ok, detail) {
  results.push({ name, ok, skip: !ok });
  console.log(`  [${ok ? 'PASS' : 'SKIP'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function throwsWith(fn, keyword) {
  try {
    fn();
    return `(没有抛错)`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(keyword) ? true : message;
  }
}

const SALES = [
  ['季度', '华东', '华北'],
  ['Q1', 320, 210],
  ['Q2', 412, 268],
  ['Q3', 388, 240],
  ['Q4', 510, 302],
];

// ══════════════════════════════════════════════════════════
// 1. 契约层
// ══════════════════════════════════════════════════════════
console.log('\n── 契约层 ──');
{
  check('工具名与集合一致', CHART_TOOLS.length === 1 && CHART_TOOLS[0] === CHART_TOOL, CHART_TOOL);
  check('写文件是 confirm 档（与 office 两个写工具同档）', CHART_TOOL_RISK[CHART_TOOL] === 'confirm');
  check('三种图型齐备', CHART_TYPES.join(',') === 'bar,line,pie', CHART_TYPES.join(','));
  check('产物扩展名是 .html', CHART_EXTENSION === '.html');
  check(
    '产物标记可用于「只渲染自家产物」的判定',
    CHART_HTML_MARKER.includes('deepwork-chart'),
    CHART_HTML_MARKER,
  );
  check(
    '内置服务名不含点号（否则与模型侧工具名规则撞车）',
    !CHART_MCP_SERVER_NAME.includes('.') && /^[a-zA-Z0-9_-]+$/.test(CHART_MCP_SERVER_NAME),
    CHART_MCP_SERVER_NAME,
  );
  check('内核侧工具名是下划线形式', /^[a-z_]+$/.test(CHART_MCP_TOOL), CHART_MCP_TOOL);

  // 入参表是**单一事实来源**：宿主工具的描述与 MCP 的 JSON Schema 都从它派生。
  // 两处各写一份时不会报错，只会在模型按描述传参、schema 却拒绝的那天暴露出来。
  const descriptions = chartParameterDescriptions();
  const schema = chartInputJsonSchema();
  const schemaNames = Object.keys(schema.properties);
  check(
    '两个形状来自同一张入参表（描述与 schema 的参数名一致）',
    schemaNames.length === CHART_ARGS.length && schemaNames.every((name) => name in descriptions),
    schemaNames.join(','),
  );
  check(
    '必填项与表一致',
    JSON.stringify(schema.required) ===
      JSON.stringify(CHART_ARGS.filter((arg) => arg.required).map((arg) => arg.name)),
    String(schema.required),
  );
  check(
    'rows 的 schema 是合法 JSON Schema 联合（anyOf：字符串 或 二维数组）',
    Array.isArray(schema.properties.rows.anyOf) &&
      schema.properties.rows.anyOf.length === 2 &&
      schema.properties.rows.anyOf[0].type === 'string' &&
      schema.properties.rows.anyOf[1].type === 'array',
    JSON.stringify(schema.properties.rows),
  );
  check(
    'rows 的 schema 不含非法的 type 伪值（真实端点会拒绝整个工具表）',
    !JSON.stringify(schema).includes('string|array'),
  );
  check('规模上限都是正数', CHART_MAX_POINTS > 0 && CHART_MAX_SERIES > 0 && CHART_MAX_CATEGORIES > 0);
}

// ══════════════════════════════════════════════════════════
// 2. 规格层：表格 → 图表规格
// ══════════════════════════════════════════════════════════
console.log('\n── 规格层（首列判定 / 缺测 / 重复列名 / 拒绝）──');
{
  const spec = chartSpecFromRows({ type: 'bar', rows: SALES, title: '季度营收' });
  check('首列全是非数字 → 判定为类别轴并如实记录', spec.labelColumn === true);
  check('类别取首列文本', spec.categories.join(',') === 'Q1,Q2,Q3,Q4', spec.categories.join(','));
  check('两个数值列 → 两个系列，系列名取表头', spec.series.map((s) => s.name).join(',') === '华东,华北');
  check('数据点计数正确', chartPointCount(spec) === 8, String(chartPointCount(spec)));

  // 纯数字矩阵：没有可当标签的列时，类别按序号而不是硬凑第一列
  const numeric = chartSpecFromRows({ type: 'bar', rows: [['a', 'b'], [1, 2], [3, 4]] });
  check('首列是数字 → 不当作类别轴（否则会把第一列数据吃掉）', numeric.labelColumn === false);
  check('类别退化为序号', numeric.categories.join(',') === '1,2', numeric.categories.join(','));
  check('纯数字表里两列都是系列', numeric.series.length === 2);

  const md = chartSpecFromRows({
    type: 'line',
    rows: '| 月份 | 销量 |\n| --- | --- |\n| 1月 | 1286 |\n| 2月 | 1102 |',
  });
  check('Markdown 管道表格与二维数组等价', md.categories.join(',') === '1月,2月' && md.series[0].values[0] === 1286);

  // 缺测：不是 0，也不能静默
  const gap = chartSpecFromRows({
    type: 'line',
    rows: [['月', '销量'], ['1月', 1], ['2月', 'N/A'], ['3月', ''], ['4月', 4]],
  });
  check('非数字单元格记为缺测（不是 0）', gap.series[0].values[1] === null && gap.series[0].values[2] === null);
  check('缺测数量如实回报', gap.missing === 2 && gap.notes.some((n) => n.includes('2 个单元格')), gap.notes.join(' | '));
  check(
    '百分数不算数字（42.9% 既可能指 42.9 也可能指 0.429，不替用户选）',
    numberOf('42.9%') === null && numberOf('1,286') === 1286 && numberOf('¥320') === 320,
  );
  check('布尔不算数字', numberOf(true) === null && textOf(true) === 'TRUE');

  const dropped = chartSpecFromRows({ type: 'bar', rows: [['a', 'b', 'c'], ['x', 1, '高'], ['y', 2, '低']] });
  check('整列无数值时跳过该列并如实报告', dropped.series.length === 1 && dropped.notes.some((n) => n.includes('已跳过')));

  const dup = chartSpecFromRows({ type: 'bar', rows: [['a', 'v', 'v'], ['x', 1, 2]] });
  check(
    '重复列名加序号后缀（否则图例与数据表无法区分）',
    dup.series.map((s) => s.name).join('|') === 'v|v (2)',
    dup.series.map((s) => s.name).join('|'),
  );

  // 拒绝：每一条都必须可行动（说清收到什么、为什么不行、怎么改）
  check(
    '饼图多列 → 明确要求缩成两列或换图型',
    throwsWith(
      () => chartSpecFromRows({ type: 'pie', rows: [['a', 'b', 'c'], ['x', 1, 2]] }),
      '饼图只接受一个数值列',
    ),
  );
  check(
    '饼图负值 → 明确说不能表示负值',
    throwsWith(() => chartSpecFromRows({ type: 'pie', rows: [['a', 'b'], ['x', -1]] }), '不能表示负值'),
  );
  check(
    '饼图总和为 0 → 报「需要一个总和为正的数值列」',
    throwsWith(() => chartSpecFromRows({ type: 'pie', rows: [['a', 'b'], ['x', 0]] }), '总和为正'),
  );
  check(
    '没有任何数值列 → 报错并指出数值列的判定口径',
    throwsWith(() => chartSpecFromRows({ type: 'bar', rows: [['a', '高'], ['x', '低']] }), '没有任何一列包含可用数值'),
  );
  check(
    'rows 不可解析 → 沿用 office 的同一句措辞（两处口径必须一致）',
    throwsWith(() => chartSpecFromRows({ type: 'bar', rows: '不是表格' }), '二维数组'),
  );
  check(
    '图型非法 → 列出可选值',
    throwsWith(() => chartSpecFromRows({ type: 'donut', rows: SALES }), 'bar / line / pie'),
  );
  check(
    '只有表头没有数据 → 明确报错',
    throwsWith(() => chartSpecFromRows({ type: 'bar', rows: [['a', 'b']] }), '没有数据行'),
  );
  const manyCategories = [['n', 'v'], ...Array.from({ length: CHART_MAX_CATEGORIES + 1 }, (_, i) => [`c${i}`, i])];
  check(
    '柱状图类别超上限 → 报错而不是画出一堆 1px 柱子',
    throwsWith(() => chartSpecFromRows({ type: 'bar', rows: manyCategories }), String(CHART_MAX_CATEGORIES)),
  );
  const manySeries = [
    ['n', ...Array.from({ length: CHART_MAX_SERIES + 1 }, (_, i) => `s${i}`)],
    ['x', ...Array.from({ length: CHART_MAX_SERIES + 1 }, () => 1)],
  ];
  check(
    '系列数超上限 → 报错',
    throwsWith(() => chartSpecFromRows({ type: 'bar', rows: manySeries }), String(CHART_MAX_SERIES)),
  );
  const longTitle = 'x'.repeat(200);
  const clipped = chartSpecFromRows({ type: 'bar', rows: SALES, title: longTitle });
  check('超长标题截断并报告（不静默改内容）', clipped.title.length < 200 && clipped.notes.some((n) => n.includes('标题')));
  check('长标签截断成「…」', clipLabel('一'.repeat(60)).endsWith('…'));
}

// ══════════════════════════════════════════════════════════
// 3. 渲染层：产物的字面内容
// ══════════════════════════════════════════════════════════
console.log('\n── 渲染层（元素数量 / 坐标 / 转义 / 可复现）──');
{
  const bar = planChart({ type: 'bar', rows: SALES, title: '季度营收与成本' });
  const rects = [...bar.html.matchAll(/<rect class="ch-bar"/g)];
  check('柱状图：柱数 = 类别 × 系列', rects.length === 8, String(rects.length));
  check('每根柱子带原生 tooltip（无脚本的交互）', (bar.html.match(/<title>Q1 · 华东: 320<\/title>/g) ?? []).length === 1);
  check('柱状图值域含 0（柱高是相对 0 的量）', /class="ch-tick"[^>]*>0</.test(bar.html));
  check('带 X 轴刻度文本', bar.html.includes('>Q4<'));

  // 缺测把一条线切成两段：每段各自成线，缺口处直连是最常见的「图形对、结论错」
  const line = planChart({
    type: 'line',
    rows: [['月', '销量'], ['1月', 10], ['2月', 20], ['3月', 'N/A'], ['4月', 40], ['5月', 50]],
  });
  check('折线遇到缺测断开（两段线，而不是从缺口直连）', (line.html.match(/<polyline class="ch-line"/g) ?? []).length === 2);
  check('缺测点不画标记（标记数 = 非缺测点数）', (line.html.match(/<circle class="ch-dot"/g) ?? []).length === 4);

  // 孤立点（两侧都是缺测）只画点、不画线 —— 一个点不成线，硬连会凭空造出趋势
  const isolated = planChart({
    type: 'line',
    rows: [['月', '销量'], ['1月', 10], ['2月', 'N/A'], ['3月', 30]],
  });
  check('孤立点不画线（单点连不成趋势）', (isolated.html.match(/<polyline class="ch-line"/g) ?? []).length === 0);
  check('孤立点仍以标记点出现（不能把数据弄丢）', (isolated.html.match(/<circle class="ch-dot"/g) ?? []).length === 2);

  const pie = planChart({
    type: 'pie',
    rows: [['科目', '金额'], ['人力', 420], ['差旅', 60], ['研发', 300]],
  });
  const slices = [...pie.html.matchAll(/<path class="ch-slice"/g)];
  check('饼图：扇区数 = 类别数', slices.length === 3, String(slices.length));
  check('扇区带数值与占比的 tooltip', /人力 · 420 \(53\.8%\)/.test(pie.html));
  check('图例带占比（扇区里放不下的信息有去处）', /人力 420 \(53\.8%\)/.test(pie.html));

  const single = planChart({ type: 'pie', rows: [['科目', '金额'], ['人力', 10]] });
  check('单扇区（100%）走整圆分支（弧线路径会退化成一条直线）', single.html.includes('<circle class="ch-slice"') && !single.html.includes('<path class="ch-slice"'));

  const negative = planChart({ type: 'bar', rows: [['月', '净利'], ['1月', 10], ['2月', -8]] });
  check('负值柱向下画且画出零线', negative.html.includes('class="ch-zero"') && /height="\d/.test(negative.html));

  // 转义：标题里塞标签不能变成真标签
  const evil = planChart({ type: 'bar', rows: SALES, title: '<script>alert(1)</script> & "引号"' });
  check('标题里的标签被转义（不出现在产物里当标签）', !evil.html.includes('<script>'));
  check('转义为实体', evil.html.includes('&lt;script&gt;') && evil.html.includes('&amp;'));

  // 自包含与无脚本
  check('无任何 script 标签', !/<script/i.test(evil.html));
  check('CSP 收紧到 default-src none（产物不取任何外部资源）', /content="default-src 'none'; style-src 'unsafe-inline'"/.test(evil.html));
  check('无外链（没有 src= / href= 这类引用）', !/\s(src|href)="http/i.test(evil.html));
  check('产物带标记，供界面判定「这是自家产物」', evil.html.includes(CHART_HTML_MARKER));
  check('数据表随产物一起落盘（图表是数据的视图，不能分家）', evil.html.includes('<details class="ch-data"') && evil.html.includes('<table>'));

  // 主题：结构色必须能随系统反转，数据色内联
  check('浅色为默认、深色走媒体查询覆盖', evil.html.includes('@media (prefers-color-scheme: dark)'));
  check('数据颜色内联（离开样式表也能看懂）', /fill="#[0-9A-F]{6}"/.test(evil.html));
  check('系列配色循环取用（超过 12 个系列不越界）', seriesColor(13) === seriesColor(1));

  // 可复现：同一份 spec 两次生成必须逐字节相同
  const again = planChart({ type: 'bar', rows: SALES, title: '季度营收与成本' });
  check('同一输入两次生成逐字节相同（否则「无变化短路」会静默失效）', again.bytes.equals(bar.bytes));
  check('产物里没有生成时间', !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(bar.html));

  // 数值与刻度
  check('刻度落在人读得顺的数上（1/2/2.5/5×10^n）', JSON.stringify(buildScale([320, 412, 388, 510], true).ticks) === '[0,200,400,600]');
  check('全等值不会产生零高度区间', buildScale([5, 5], false).hi > buildScale([5, 5], false).lo);
  check('负数刻度对称', buildScale([-8, 10], true).ticks[0] <= -8);
  check('万/亿分级显示', formatNumber(1234567) === '123.46万' && formatNumber(250000000) === '2.5亿');
  check('千分位分组', formatNumber(1234) === '1,234' && formatNumber(100) === '100');
  check('CJK 标签按一个全角宽估算（图例换行才排得对）', estimateTextWidth('中文', 10) === 20);

  // 回执：观察必须跟着回执走
  const receipt = chartOutputText(
    planChart({ type: 'line', rows: [['月', 'v'], ['1月', 1], ['2月', 'N/A']] }),
    '已新建',
    'charts/a.html',
  );
  check('回执含体积/规模摘要与数据点数', /已新建 charts\/a\.html（.*数据点）/.test(receipt), receipt.split('\n')[0]);
  check('回执把缺测如实带给模型', receipt.includes('按缺测处理'), receipt.split('\n').slice(1).join(' '));
}

// ══════════════════════════════════════════════════════════
// 4. 工具层：审批链与边界
// ══════════════════════════════════════════════════════════
async function toolSection() {
  console.log('\n── 工具层（审批链 / 边界 / 短路）──');
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const names = registry.list().map((tool) => tool.name);
  check('chart.render 已注册进宿主工具表', names.includes(CHART_TOOL), CHART_TOOL);

  const calls = [];
  const makeCtx = (outcome) =>
    createToolContext({
      workspace,
      guard: { assess: () => ({ risk: 'confirm', reason: 'test', blocked: false }) },
      requestApproval: async (input) => {
        calls.push(input);
        return outcome;
      },
    });

  const args = { path: 'charts/营收.html', type: 'bar', rows: SALES, title: '季度营收' };
  const target = path.join(workspace, 'charts', '营收.html');

  // ── 拒绝：必须不落盘 ──
  const denied = await registry.execute(CHART_TOOL, args, makeCtx(DENY_ALL));
  check('拒绝写入时返回失败并说明原因', denied.ok === false && denied.output.includes('拒绝'), denied.output.slice(0, 40));
  check('拒绝后文件确实没有落盘（不只是返回失败）', !fs.existsSync(target));
  check('审批请求带工具名与目标路径', calls[0]?.tool === CHART_TOOL && calls[0]?.subject === 'charts/营收.html');

  // ── 允许：落盘 + 差异可读 ──
  const allowCtx = makeCtx(ALLOW_ALL);
  const preview = await registry.previewFor(CHART_TOOL, args, allowCtx);
  check('预检给出差异（而不是「二进制文件」四个字）', preview !== null && preview.added > 0 && !preview.binary);
  check('新建文件的差异标记 created', preview?.created === true);
  const allowed = await registry.execute(CHART_TOOL, args, allowCtx);
  check('允许后文件真的落盘', allowed.ok === true && fs.existsSync(target), allowed.output.split('\n')[0]);
  const written = fs.readFileSync(target, 'utf8');
  check('落盘内容 = 预检时展示的新内容（同一份快照）', written.includes('季度营收'));
  check(
    '差异里能直接读到数据行（产物是按行生成的，改一个数字只动一行）',
    preview.hunks.some((hunk) => hunk.lines.some((line) => line.kind === 'add' && line.text.includes('>320<'))),
  );
  check('审批理由说明差异是产物源码、数据表在折叠区', calls.some((call) => String(call.reason).includes('源码')));

  // ── 无变化短路 ──
  const before = calls.length;
  const unchanged = await registry.execute(CHART_TOOL, args, makeCtx(ALLOW_ALL));
  check(
    '重复生成同一张图 → 报「无变化」并不再弹审批',
    unchanged.ok === true && unchanged.output.includes('无变化') && calls.length === before,
    unchanged.output,
  );

  // ── 改一个数字：差异必须指向那一行 ──
  const changedRows = SALES.map((row) => (row[0] === 'Q1' ? [row[0], 3200, row[2]] : row));
  const changed = await registry.previewFor(CHART_TOOL, { ...args, rows: changedRows }, makeCtx(ALLOW_ALL));
  check(
    '改一个数字：差异既有增也有删（旧值被替换）',
    changed !== null && !changed.created && changed.added > 0 && changed.removed > 0,
    changed ? `+${changed.added} −${changed.removed}` : 'null',
  );

  // ── 边界与措辞 ──
  const mismatch = await registry.execute(CHART_TOOL, { ...args, path: '图.svg' }, makeCtx(ALLOW_ALL));
  check('扩展名不符时拒绝（名字与内容不符的文件最糟）', mismatch.ok === false && mismatch.output.includes('必须以 .html 结尾'), mismatch.output.slice(0, 50));
  const noExt = await registry.execute(CHART_TOOL, { path: 'charts/预算结构', type: 'pie', rows: [['a', 'b'], ['x', 1]] }, makeCtx(ALLOW_ALL));
  check('无扩展名时自动补上 .html', noExt.ok === true && fs.existsSync(path.join(workspace, 'charts', '预算结构.html')), noExt.output.split('\n')[0]);
  const escaped = await registry.execute(CHART_TOOL, { ...args, path: '../逃逸.html' }, makeCtx(ALLOW_ALL));
  check('越出工作区的路径被拒绝', escaped.ok === false && escaped.output.includes('越出工作区'), escaped.output.slice(0, 50));
  const badType = await registry.execute(CHART_TOOL, { ...args, type: 'donut' }, makeCtx(ALLOW_ALL));
  check('图型非法时把可行动的错误原样给模型', badType.ok === false && badType.output.includes('bar / line / pie'), badType.output.slice(0, 60));
  const noPath = await registry.execute(CHART_TOOL, { type: 'bar', rows: SALES }, makeCtx(ALLOW_ALL));
  check('缺 path 时沿用统一的「缺少必需参数」措辞', noPath.ok === false && noPath.output.includes('缺少必需参数: path'));

  // ── 无审批回调时也要能跑（与 mock 的调用形态一致）──
  const bare = await registry.execute(
    CHART_TOOL,
    { path: 'charts/无审批.html', type: 'line', rows: SALES },
    createToolContext({ workspace, guard: { assess: () => ({ risk: 'confirm', reason: 't', blocked: false }) } }),
  );
  check('没有审批回调时仍能落盘（mock 之外的调用形态）', bare.ok === true && fs.existsSync(path.join(workspace, 'charts', '无审批.html')));
}

// ══════════════════════════════════════════════════════════
// 5. MCP 层：真进程往返
// ══════════════════════════════════════════════════════════
async function mcpSection() {
  console.log('\n── MCP 服务（stdio 真实往返）──');
  const entry = path.join(root, 'packages', 'core-host', 'dist', 'cli', 'chart-mcp.js');
  if (!fs.existsSync(entry)) {
    skippable('图表 MCP 服务入口存在', false, entry);
    return;
  }
  check('图表 MCP 服务入口存在（补丁里写的就是这个路径）', true, entry);

  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, DEEPWORK_HOME: home, DEEPWORK_WORKSPACE: workspace },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => lines.push(line));
  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8');
  });

  const call = async (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const found = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((item) => item && item.id === message.id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`MCP 响应超时（id=${message.id}）；stderr 片段：${stderrText.slice(-200)}`);
  };

  try {
    const init = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chart-test', version: '0' } },
    });
    check(
      'initialize 回显协议版本并公布 tools 能力',
      init.result?.protocolVersion === '2025-06-18' && Boolean(init.result?.capabilities?.tools),
    );
    check('initialize 公布服务名', init.result?.serverInfo?.name === 'deepwork-chart', init.result?.serverInfo?.name);

    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = (list.result?.tools ?? []).map((tool) => tool.name);
    check('tools/list 只列出 chart_render（不声明没实现的能力）', listed.length === 1 && listed[0] === CHART_MCP_TOOL, listed.join(','));
    check('工具带 JSON Schema 入参', list.result?.tools?.[0]?.inputSchema?.type === 'object');

    const ping = await call({ jsonrpc: '2.0', id: 3, method: 'ping' });
    check('ping 返回空结果对象', ping.result !== undefined && !ping.error);

    const made = await call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: CHART_MCP_TOOL,
        arguments: { path: 'mcp/营收.html', type: 'bar', rows: SALES, title: 'MCP 出的图' },
      },
    });
    const madeText = made.result?.content?.[0]?.text ?? '';
    check('tools/call 真的落盘并回一句话回执', madeText.includes('已新建 mcp/营收.html'), madeText.split('\n')[0]);
    check('落盘文件带产物标记', fs.readFileSync(path.join(workspace, 'mcp', '营收.html'), 'utf8').includes(CHART_HTML_MARKER));

    const again = await call({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: CHART_MCP_TOOL,
        arguments: { path: 'mcp/营收.html', type: 'bar', rows: SALES, title: 'MCP 出的图' },
      },
    });
    check(
      'MCP 侧同样有无变化短路（不重复写、不改 mtime）',
      (again.result?.content?.[0]?.text ?? '').includes('无变化'),
      again.result?.content?.[0]?.text,
    );

    // 边界：本进程是内核拉起的独立进程，边界必须自己守
    const escape = await call({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: CHART_MCP_TOOL, arguments: { path: '../逃逸.html', type: 'bar', rows: SALES } },
    });
    check(
      '越出工作区的写入被拒绝（不假设内核会替我们守边界）',
      escape.result?.isError === true && (escape.result?.content?.[0]?.text ?? '').includes('越出工作区'),
      escape.result?.content?.[0]?.text,
    );

    const badData = await call({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: CHART_MCP_TOOL, arguments: { path: 'mcp/坏.html', type: 'pie', rows: [['a', 'b', 'c'], ['x', 1, 2]] } },
    });
    check(
      '数据不合规按 isError 内容返回（不是 JSON-RPC error，否则模型看不到原因）',
      badData.result?.isError === true && !badData.error && (badData.result?.content?.[0]?.text ?? '').includes('饼图只接受一个数值列'),
      badData.result?.content?.[0]?.text,
    );

    const unknown = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'chart_nope', arguments: {} } });
    check('未知工具是协议层错误（客户端问了一个不存在的名字）', unknown.error?.code === -32602, JSON.stringify(unknown.error));
    const notImplemented = await call({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
    check('未实现的方法明确报 -32601（不静默挂起）', notImplemented.error?.code === -32601);
  } finally {
    child.kill();
  }
}

// ══════════════════════════════════════════════════════════
// 6. 内核补丁层
// ══════════════════════════════════════════════════════════
function patchSection() {
  console.log('\n── 内核补丁（内置 MCP 服务注入）──');
  const entry = path.join(root, 'packages', 'core-host', 'dist', 'cli', 'chart-mcp.js');
  const patch = buildChartMcpPatch({
    command: process.execPath,
    entry,
    env: { DEEPWORK_HOME: home, DEEPWORK_WORKSPACE: workspace },
  });
  const item = patch.insert[0];
  check('补丁是一个 insert 条目', Array.isArray(patch.insert) && patch.insert.length === 1);
  check('条目 name 是内核依赖闭包内的 MCP 客户端包名', item.name === '@deepseek-ai/dsh-mcp-client', item.name);
  check('serverName 与契约层一致', item.config.serverName === CHART_MCP_SERVER_NAME);
  check('传输是 stdio', item.config.transport === 'stdio');
  check('args 指向 MCP 服务入口', item.config.args[0] === entry);
  check('入口文件在磁盘上真实存在（否则内核拉起必失败）', fs.existsSync(entry), entry);
  check('env 带 DEEPWORK_WORKSPACE（否则图会写到 MCP 进程的 cwd 去，且不报错）', item.config.env.DEEPWORK_WORKSPACE === workspace);

  // 内置服务共用一份构造逻辑：浏览器与图表只有 id/serverName/env 不同
  const browserish = buildBuiltinMcpPatch({
    id: 'deepwork-browser',
    serverName: 'deepwork_browser',
    command: process.execPath,
    entry,
    env: { DEEPWORK_HOME: home },
  });
  check('两种内置服务走同一份构造逻辑（形状一致）', JSON.stringify(Object.keys(browserish.insert[0])) === JSON.stringify(Object.keys(item)));

  const merged = buildRuntimePatch(
    [{ name: 'fake', command: 'node', args: [], enabled: true }],
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek', config: {} },
    { insert: [{ id: 'deepwork-browser', name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio', serverName: 'deepwork_browser', command: 'node' } }] },
    patch,
  );
  check('合并补丁含四项（连接器 + 端点覆盖 + 图表 + 浏览器）', Array.isArray(merged) && merged.length === 4, String(merged?.length));
  check(
    '图表排在浏览器之前（浏览器恒为最后一项是一条既有断言）',
    merged[merged.length - 1].insert?.[0]?.id === 'deepwork-browser' &&
      merged[merged.length - 2].insert?.[0]?.id === 'deepwork-chart',
    merged.map((item2) => ('insert' in item2 ? item2.insert[0].id : item2.id)).join(','),
  );
  check('全空仍然返回 null（内核零改动启动）', buildRuntimePatch([], null) === null);
  const yaml = serializeRuntimePatchYaml(merged);
  check(
    'YAML 里能被序列化器吃下（形状受控，不需要 js-yaml）',
    yaml.includes('serverName: "deepwork_chart"') && yaml.includes('DEEPWORK_WORKSPACE'),
    yaml.includes('deepwork_chart') ? 'ok' : 'missing',
  );

  // 风险分档：内核侧看到的工具名是 mcp__<server>__<tool>
  const riskOf = (title) =>
    mapUpdateToEvent({ sessionUpdate: 'tool_call', toolCallId: 'c1', title, kind: 'other', rawInput: {} }, 'r1')?.call
      ?.risk;
  const full = `mcp__${CHART_MCP_SERVER_NAME}__${CHART_MCP_TOOL}`;
  check('内核侧工具名与宿主风险档一致（都是 confirm）', riskOf(full) === 'confirm', `${full} → ${riskOf(full)}`);
}

// ══════════════════════════════════════════════════════════
// 7. 独立校验（Python：另一个 XML / HTML 实现）
// ══════════════════════════════════════════════════════════
function findPython() {
  const candidates = [
    process.env.DEEPWORK_PYTHON,
    'python3',
    'python',
    'py',
    // 本机托管运行时的兜底路径（与 office-test 同源：写死路径但可被环境变量覆盖）
    'C:/Users/madd/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-c', 'import xml.etree.ElementTree, html.parser, json'], { stdio: 'ignore' });
      if (probe.status === 0) return candidate;
    } catch {
      // 试下一个
    }
  }
  return null;
}

/**
 * 独立校验脚本。
 *
 * 两件事：**SVG 必须是良构 XML**（我们自己拼字符串，拼错一处就是一张空白图，
 * 而浏览器对坏 XML 的处理是「安静地不画」——正是最难发现的那种失败）；
 * **HTML 里不能有脚本与外链**（CSP 是声明，这里是事实）。
 */
const PY_CHECKER = `
import json, os, re, sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

class Collector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags = []
        self.scripts = 0
        self.external = []
    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        if tag == 'script':
            self.scripts += 1
        for key, value in attrs:
            if key in ('src', 'href') and value:
                self.external.append(value)

report = []
for path in sys.argv[1:]:
    html = open(path, encoding='utf-8').read()
    item = {"name": os.path.basename(path), "svg": None, "svgElements": 0, "svgError": None,
            "scripts": None, "external": [], "tables": 0, "details": 0}
    match = re.search(r'<svg[\\s\\S]*?</svg>', html)
    if match:
        try:
            root = ET.fromstring(match.group(0))
            item["svg"] = root.tag.split('}')[-1]
            item["svgElements"] = len(list(root.iter()))
        except Exception as error:
            item["svgError"] = str(error)
    parser = Collector()
    parser.feed(html)
    item["scripts"] = parser.scripts
    item["external"] = parser.external
    item["tables"] = parser.tags.count('table')
    item["details"] = parser.tags.count('details')
    report.append(item)
print(json.dumps(report, ensure_ascii=False))
`;

function independentSection() {
  console.log('\n── 独立校验（Python：另一个 XML / HTML 实现）──');
  const python = findPython();
  if (!python) {
    skippable('Python 独立校验（SVG 良构 / 无脚本 / 无外链）', false, '本机没有可用的 python');
    return;
  }

  const outDir = path.join(home, 'independent');
  fs.mkdirSync(outDir, { recursive: true });
  const cases = [
    ['bar.html', planChart({ type: 'bar', rows: SALES, title: '季度营收与成本' })],
    ['line.html', planChart({ type: 'line', rows: [['月', 'A', 'B'], ['1月', 1286, 940], ['2月', 'N/A', 880], ['3月', 1420, 1010]] })],
    ['pie.html', planChart({ type: 'pie', rows: [['科目', '金额'], ['人力', 420], ['差旅', 60], ['研发', 300]] })],
    ['single.html', planChart({ type: 'pie', rows: [['科目', '金额'], ['人力', 10]] })],
    ['negative.html', planChart({ type: 'bar', rows: [['月', '净利'], ['1月', 10], ['2月', -8]], yLabel: '万元' })],
    ['evil.html', planChart({ type: 'bar', rows: SALES, title: '<script>alert(1)</script> & "引号"' })],
  ];
  // 每个数据点至少要有一个 SVG 元素承载它 —— 空白图是「安静地不画」那种最难发现的失败。
  // 用数据点数当**下界**而不是钉死元素总数：总数随坐标轴、图例、刻度浮动，钉死只会变成
  // 一处一改实现就要改的脆弱断言。
  const marks = cases.map(([, plan]) => plan.spec.categories.length * plan.spec.series.length);
  const files = cases.map(([name, plan]) => {
    const target = path.join(outDir, name);
    fs.writeFileSync(target, plan.bytes);
    return target;
  });

  const run = spawnSync(python, ['-c', PY_CHECKER, ...files], { encoding: 'utf8' });
  if (run.status !== 0) {
    check('Python 独立校验可执行', false, (run.stderr || '').slice(0, 160));
    return;
  }

  const report = JSON.parse(run.stdout);
  check('六份产物都解析出了 SVG 根元素', report.every((item) => item.svg === 'svg'), report.map((i) => i.svg).join(','));
  check(
    'SVG 是良构 XML（坏 XML 在浏览器里是「安静地不画」）',
    report.every((item) => item.svgError === null),
    report.map((i) => i.svgError).filter(Boolean).join(' | ') || 'ok',
  );
  check(
    'SVG 元素数不低于数据点数（每个数据点至少有一个元素承载 —— 空图是最难发现的失败）',
    report.every((item, index) => item.svgElements >= marks[index] && item.svgElements > 0),
    report.map((item, index) => `${item.svgElements}≥${marks[index]}`).join(' '),
  );
  check('没有任何脚本（另一个实现的结论，不是我们自己的正则）', report.every((item) => item.scripts === 0), report.map((i) => i.scripts).join(','));
  check('没有任何外链引用', report.every((item) => item.external.length === 0), report.map((item) => item.external.join(',')).join(' | ') || 'ok');
  check('每份产物都带数据表与折叠区', report.every((item) => item.tables >= 1 && item.details >= 1));
}

// ══════════════════════════════════════════════════════════
// 8. 界面接线与依赖纪律（读源码，不跑 Electron）
// ══════════════════════════════════════════════════════════
function wiringSection() {
  console.log('\n── 界面接线与依赖纪律 ──');
  const app = fs.readFileSync(path.join(root, 'apps', 'desktop', 'src', 'App.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'apps', 'desktop', 'src', 'styles.css'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'apps', 'desktop', 'electron', 'main.js'), 'utf8');

  check('预览弹窗引用了产物标记（只对自家产物提供渲染视图）', app.includes('CHART_HTML_MARKER'));
  check('渲染走 sandbox 空值的 iframe（禁脚本 / 禁表单 / 禁跳转）', /sandbox=""\s+srcDoc=/.test(app));
  check('预览保留源码视图（渲染之外还能看它到底写了什么）', app.includes('preview-text'));
  check('渲染容器有样式（否则 iframe 高度塌成 0，看起来像「没渲染出来」）', css.includes('.chart-frame'));
  check('图表不需要新增壳层 RPC（复用既有只读预览通道 fs.preview）', main.includes("'fs.preview'"));

  const files = fs
    .readdirSync(path.join(root, 'packages', 'core-host', 'src', 'chart'))
    .filter((name) => name.endsWith('.ts'));
  const sources = files.map((name) =>
    fs.readFileSync(path.join(root, 'packages', 'core-host', 'src', 'chart', name), 'utf8'),
  );
  const externals = sources
    .flatMap((source) => [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]))
    .filter(
      (spec) =>
        !spec.startsWith('.') &&
        !spec.startsWith('node:') &&
        spec !== '@deepwork/protocol',
    );
  check('图表实现里没有第三方依赖（只有 node: 内置与协议包）', externals.length === 0, externals.join(','));

  const protocol = fs
    .readdirSync(path.join(root, 'packages', 'protocol', 'src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => fs.readFileSync(path.join(root, 'packages', 'protocol', 'src', name), 'utf8'))
    .join('\n');
  check('产物里不写时间戳的纪律写在契约注释里（后来者才知道不能加）', protocol.includes('不写生成时间') || protocol.includes('字节可复现'));
}

async function main() {
  await toolSection();
  await mcpSection();
  patchSection();
  independentSection();
  wiringSection();

  const hard = results.filter((item) => !item.ok && !item.skip);
  const skipped = results.filter((item) => item.skip);
  console.log(
    `\n图表能力测试：${results.length - hard.length}/${results.length} 通过${skipped.length ? `（${skipped.length} 项 SKIP）` : ''}`,
  );
  if (hard.length > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error);
    process.exit(1);
  })
  .finally(() => {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      // 临时目录清不掉不影响结果
    }
  });
