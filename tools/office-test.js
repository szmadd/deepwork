'use strict';

/**
 * Office 文档能力（M2-I）测试 —— 生成、原生读取、审批链、独立校验。
 *
 *   npm run test:office
 *
 * ── 这一层为什么必须有 ───────────────────────────────────────────
 * 生成 docx/xlsx 这类「二进制包」最容易出现的是**看起来成功了**：
 * 文件写出来了、字节数也对，只有真实 Office 打开时才知道缺了哪个部件。
 * 因此断言不能停在「函数返回了一个 Buffer」，要落到四类真实出口：
 *   1. 包结构：部件齐全、内容类型覆盖、关系目标可解析（OOXML 的硬要求）；
 *   2. 良构性：每个 XML 部件能被**另一个实现**（Python 的 ElementTree）解析；
 *   3. 往返：写出去的文档能被读回来，内容逐字对得上；
 *   4. 审批链：拒绝授权就**不落盘**，且审批里给出的差异是文档的真实内容视图。
 *
 * ── OFD 样本为什么由 Python 生成 ─────────────────────────────────
 * 读取器读的是「别人产出的包」才有意义。用自己写的 zip 打包再自己解包，
 * 只能证明两段代码自洽。fixture 由 Python 标准库 zipfile 产出
 * （tools/fixtures/make-ofd-fixture.py），并且刻意把行、片段都倒着写进 XML ——
 * 只有按坐标排序才可能得到正确结果。
 *
 * ── 真实办公软件那一条不在这里 ───────────────────────────────────
 * 「能被真实 Office/WPS 打开」由 tools/open-with-office.js 取证（截图进 artifacts/），
 * 不做成自动断言：启动外部 GUI 程序既慢又依赖本机装了什么，
 * 把它塞进 verify 会让基线在别人的机器上随机变红 —— 而那是「已知的环境性失败」的翻版。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-office-'));
const workspace = path.join(home, 'ws');
fs.mkdirSync(workspace, { recursive: true });
process.env.DEEPWORK_HOME = home;

const {
  OFFICE_DOCX_TOOL,
  OFFICE_NATIVE_EXTENSIONS,
  OFFICE_READ_TOOL,
  OFFICE_TOOLS,
  OFFICE_TOOL_RISK,
  OFFICE_XLSX_TOOL,
  officeDocKindOf,
} = require('../packages/protocol/dist/office');
const { buildDocx, extractDocxText, parseMarkdownSubset } = require('../packages/core-host/dist/office/docx');
const { buildXlsx, columnName, extractXlsxText, rowsFromMarkdownTable, sanitizeSheetName } = require('../packages/core-host/dist/office/xlsx');
const { extractOfdText } = require('../packages/core-host/dist/office/ofd');
const { readOfficeDocument, textViewOfBytes } = require('../packages/core-host/dist/office/read');
const { crc32, zipRead, zipWrite } = require('../packages/core-host/dist/office/zip');
const { ToolRegistry, createToolContext, ALLOW_ALL, DENY_ALL } = require('../packages/core-host/dist/tools/registry');
const { registerBuiltinTools } = require('../packages/core-host/dist/tools/builtin');

const root = path.resolve(__dirname, '..');
const fixtures = path.join(root, 'tools', 'fixtures');
const results = [];
/** findPython 解析出的来源说明（哪一档命中的），打出来才知道测的是随包那份还是系统那份 */
let pythonSource = null;
const FIXED = new Date('2026-09-13T12:00:00Z');

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function skippable(name, ok, detail) {
  results.push({ name, ok, skip: !ok });
  console.log(`  [${ok ? 'PASS' : 'SKIP'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 断言「以某句文案失败」——必须真的包含关键词，否则是假通过 */
function throwsWith(fn, keyword) {
  try {
    fn();
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes(keyword)) return true;
    console.log(`      （异常文案不含「${keyword}」：${message.slice(0, 120)}）`);
    return false;
  }
  console.log(`      （没有抛出异常，期望包含「${keyword}」）`);
  return false;
}

/** 第一个条目的数据起点（本地文件头 30 字节 + 名字长度 + extra 长度），用于「改一个字节」的损坏测试 */
function firstEntryDataOffset(buf) {
  return 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
}

// ══════════════════════════════════════════════════════════
// 1. 契约层
// ══════════════════════════════════════════════════════════
console.log('\n── 契约层 ──');
{
  check('三个工具名齐备', OFFICE_TOOLS.length === 3, OFFICE_TOOLS.join(' / '));
  check('工具名用点号（与 fs.list / browser.navigate 同风格）', OFFICE_TOOLS.every((name) => /^office\.[a-z]+$/.test(name)));
  check('写类两件是 confirm 档', OFFICE_TOOL_RISK[OFFICE_DOCX_TOOL] === 'confirm' && OFFICE_TOOL_RISK[OFFICE_XLSX_TOOL] === 'confirm');
  check('读类是 safe 档（只读不打扰用户）', OFFICE_TOOL_RISK[OFFICE_READ_TOOL] === 'safe');

  check('原生解析扩展名含 .ofd', OFFICE_NATIVE_EXTENSIONS.includes('.ofd'), OFFICE_NATIVE_EXTENSIONS.join(' '));
  check('扩展名判定大小写不敏感', officeDocKindOf('.OFD') === 'ofd' && officeDocKindOf('.DOcx') === 'docx');
  check('已知文本扩展名归入 text', officeDocKindOf('.md') === 'text' && officeDocKindOf('.csv') === 'text');
  check('未知扩展名返回 null（由调用方报出可用格式）', officeDocKindOf('.pdf') === null && officeDocKindOf('') === null);
}

// ══════════════════════════════════════════════════════════
// 2. 零依赖 zip 编解码
// ══════════════════════════════════════════════════════════
console.log('\n── zip 编解码 ──');
{
  const payload = Buffer.from('深边AI Work · zip 往返 · ' + 'x'.repeat(500), 'utf8');
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    { name: 'word/document.xml', data: payload },
    { name: 'res/图片.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) },
  ];

  for (const compress of [true, false]) {
    const packed = zipWrite(entries, { compress, date: FIXED });
    const back = zipRead(packed);
    const label = compress ? 'deflate' : 'store';
    check(
      `${label}：三个条目全部读回且内容逐字节一致`,
      entries.every((entry) => back.get(entry.name)?.equals(entry.data)),
      `${packed.length} B`,
    );
    check(`${label}：中文条目名（UTF-8 标志位）往返正常`, back.has('res/图片.png'));
  }

  // CRC 是唯一能发现「包被改过 / 传坏了」的机制，必须有回归哨兵。
  // 用 store 模式来构造：deflate 流里改一个字节多半先撞上解压错误，
  // 那条路径测的是 inflate，不是我们要守的校验和
  const packed = zipWrite(entries, { compress: false, date: FIXED });
  const corrupted = Buffer.from(packed);
  const dataAt = firstEntryDataOffset(corrupted) + 1;
  corrupted[dataAt] = corrupted[dataAt] ^ 0xff;
  check('数据被改动后 CRC32 校验失败并明确报出', throwsWith(() => zipRead(corrupted), 'CRC32 校验失败'));

  check('文件过小有明确报错', throwsWith(() => zipRead(Buffer.alloc(10)), '文件太小'));
  check('非 zip 输入有明确报错', throwsWith(() => zipRead(Buffer.from('这不是一个包，只是一段文字')), '不是 zip 包'));
  check('被截断的包有明确报错', throwsWith(() => zipRead(packed.subarray(0, packed.length - 60)), '截断'));

  const two = zipWrite([{ name: 'a', data: Buffer.from('1') }, { name: 'b', data: Buffer.from('2') }]);
  check('条目数超限被拦（zip bomb 第一道闸）', throwsWith(() => zipRead(two, { maxEntries: 1 }), '条目数'));
  check('单条目解压超限被拦（zip bomb 第二道闸）', throwsWith(() => zipRead(two, { maxEntryBytes: 0 }), '单条目上限'));

  check('同一时间戳 + 同一内容 → 逐字节可复现', zipWrite(entries, { date: FIXED }).equals(zipWrite(entries, { date: FIXED })));
  check(
    '不同时间戳 → 字节不同（说明可复现性不是巧合）',
    !zipWrite(entries, { date: FIXED }).equals(zipWrite(entries, { date: new Date('2020-01-01T00:00:00Z') })),
  );
  check('crc32 与已知值一致（"123456789" → 0xCBF43926）', crc32(Buffer.from('123456789')) === 0xcbf43926);
}

// ══════════════════════════════════════════════════════════
// 3. docx 生成与反解
// ══════════════════════════════════════════════════════════
const MARKDOWN = `季度经营摘要

本期**营收**环比增长 12.4%，含 \`应收周转天数\` 一项风险。

## 关键指标

| 指标 | 本期 | 上期 |
| --- | --- | --- |
| 营收 | 1286 | 1144 |
| 毛利率 | 38.2% | 36.9% |

1. 华东项目验收
2. 渠道框架签署

- 应收账龄恶化
- 缺 2 名实施顾问

> 结论：增长质量尚可。

---

\`\`\`text
催收清单：华东 3 单
\`\`\`
`;

console.log('\n── docx 生成 ──');
const docx = buildDocx({ title: '季度经营摘要（正式版）', markdown: MARKDOWN, now: FIXED });
{
  const entries = zipRead(docx.bytes);
  const names = [...entries.keys()];
  const required = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/_rels/document.xml.rels',
    'word/styles.xml',
    'word/numbering.xml',
    'docProps/core.xml',
    'docProps/app.xml',
  ];
  check('八个部件齐全', required.every((name) => entries.has(name)), names.length + ' 个条目');
  check('[Content_Types].xml 排在第一位（读取器的惯例）', names[0] === '[Content_Types].xml');

  const document = entries.get('word/document.xml').toString('utf8');
  check('document.xml 声明了 w 命名空间', document.includes('http://schemas.openxmlformats.org/wordprocessingml/2006/main'));
  check('标题用 Title 样式（并写进文档属性）', document.includes('<w:pStyle w:val="Title"/>'));
  // 正文里的 `## 关键指标` 应映射到 Heading2（`#` 才是 Heading1，这个映射单独验一下）
  check('二级标题用 Heading2 样式（与 Markdown 层级对应）', document.includes('<w:pStyle w:val="Heading2"/>'));
  check('`#` 映射到 Heading1', parseMarkdownSubset('# 一级标题').some((block) => block.kind === 'heading' && block.level === 1));
  check('无序列表引用 numId=1、有序引用 numId=2', document.includes('<w:numId w:val="1"/>') && document.includes('<w:numId w:val="2"/>'));
  check('表格带 tblGrid 与表头标记', document.includes('<w:tblGrid>') && document.includes('<w:tblHeader/>'));
  check('引用段落用 Quote 样式', document.includes('<w:pStyle w:val="Quote"/>'));
  check('代码块用 Code 样式', document.includes('<w:pStyle w:val="Code"/>'));
  check('粗体走 b 元素而不是字面量星号', document.includes('<w:b/>') && !document.includes('**营收**'));
  check('行内码用 Consolas 字体', document.includes('w:ascii="Consolas"'));
  // 中文字体在 styles.xml 的 docDefaults 里（不在 document.xml 里），别找错文件
  check('中文默认字体已指定（否则 WPS 会随机替换）', entries.get('word/styles.xml').toString('utf8').includes('w:eastAsia="等线"'));

  const styles = entries.get('word/styles.xml').toString('utf8');
  check('styles.xml 定义了 TableGrid 表格样式', styles.includes('w:styleId="TableGrid"'));
  const numbering = entries.get('word/numbering.xml').toString('utf8');
  check('numbering.xml 定义了项目符号与十进制两套编号', numbering.includes('w:numFmt w:val="bullet"') && numbering.includes('w:numFmt w:val="decimal"'));

  const core = entries.get('docProps/core.xml').toString('utf8');
  check('core.xml 写入标题与生成者', core.includes('<dc:title>季度经营摘要（正式版）</dc:title>') && core.includes('深边AI Work'));

  // 表格是「表头 + 2 行数据」= 3 行 × 3 列（分隔行不算数据）
  check('规模摘要如实统计', /标题 1/.test(docx.summary) && /表格 1（3×3）/.test(docx.summary), docx.summary);

  const back = extractDocxText(docx.bytes);
  check('反解能读回文档标题', back.text.includes('季度经营摘要（正式版）'));
  check('反解能读回标题与正文', back.text.includes('## 关键指标') === false && back.text.includes('关键指标'));
  check('反解能读回表格且行完整（曾被整块丢掉）', back.text.includes('营收 | 1286 | 1144'), JSON.stringify(back.text.split('\n').find((line) => line.includes('营收'))));
  check('反解保留列表项文本', back.text.includes('华东项目验收') && back.text.includes('缺 2 名实施顾问'));
  check('反解保留代码块内容', back.text.includes('催收清单：华东 3 单'));
  check('反解出的段数与生成统计一致', back.blocks > 10, String(back.blocks));

  check('同一时间戳生成 → 逐字节可复现', buildDocx({ title: '季度经营摘要（正式版）', markdown: MARKDOWN, now: FIXED }).bytes.equals(docx.bytes));

  // 表格解析：分隔行不能被当成数据
  const table = parseMarkdownSubset('| a | b |\n| --- | --- |\n| 1 | 2 |').find((block) => block.kind === 'table');
  check('Markdown 表格解析出 2 行（分隔行被识别掉）', table && table.rows.length === 2, JSON.stringify(table?.rows));
}

// ══════════════════════════════════════════════════════════
// 4. xlsx 生成与反解
// ══════════════════════════════════════════════════════════
console.log('\n── xlsx 生成 ──');
const rows = [
  ['科目', '预算（万元）', '已发生', '执行率'],
  ['人力成本', 420, 168, '40%'],
  ['差旅费用', 60, 31.5, '52.5%'],
  ['合计', 1000, 428.9, '42.9%'],
];
const xlsx = buildXlsx({ rows, sheet: '预算/执行', now: FIXED });
{
  const entries = zipRead(xlsx.bytes);
  const names = [...entries.keys()];
  const required = [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/worksheets/sheet1.xml',
    'xl/sharedStrings.xml',
    'xl/styles.xml',
  ];
  check('七个部件齐全', required.every((name) => entries.has(name)), names.length + ' 个条目');
  check('工作表名里的非法字符被清洗（斜杠不能出现在工作表名里）', entries.get('xl/workbook.xml').toString('utf8').includes('name="预算_执行"'), sanitizeSheetName('预算/执行'));
  check('工作表名超长会截断到 31 字符', sanitizeSheetName('x'.repeat(50)).length === 31);
  check('空工作表名回落为 Sheet1', sanitizeSheetName('') === 'Sheet1');

  const styles = entries.get('xl/styles.xml').toString('utf8');
  // Excel 自己写出来的固定形态：fills 至少两个，第 0 个 none、第 1 个 gray125。
  // 少一个 fill 时 Excel 报「发现不可读取的内容」——这条是那个坑的哨兵
  check('styles.xml 有两个 fill（none + gray125）', styles.includes('patternType="none"') && styles.includes('patternType="gray125"'));
  check('styles.xml 有两种字体（常规 + 加粗）', (styles.match(/<font>/g) ?? []).length === 2);

  const strings = entries.get('xl/sharedStrings.xml').toString('utf8');
  const unique = Number(/uniqueCount="(\d+)"/.exec(strings)[1]);
  const totalRefs = Number(/count="(\d+)"/.exec(strings)[1]);
  // 期望值由输入数据现算，而不是写死一个数字：写死的话，改了测试数据它就会跟着一起错，
  // 而它本该盯着实现（去重到底有没有发生）
  const textCells = rows.flat().filter((value) => typeof value === 'string' && value !== '');
  const expectUnique = new Set(textCells).size;
  check('共享字符串按内容去重', unique === expectUnique, `uniqueCount=${unique} 期望 ${expectUnique}`);
  check('count 是引用总数（可能大于去重数）', totalRefs === textCells.length, `count=${totalRefs} 期望 ${textCells.length}`);
  check('字符串表里能查到中文表头', strings.includes('<t xml:space="preserve">科目</t>'));

  const sheet = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
  check('表头单元格加了加粗样式 s="1"', sheet.includes('<c r="A1" s="1" t="s">'));
  // 数字必须走 <v> 且不带 t 属性：带上 t="str" 会被 Excel 当文本，求和与排序全部失效
  check('数字单元格不带 t 属性（Excel 才能参与计算）', sheet.includes('<c r="B2"><v>420</v></c>'), sheet.match(/<c r="B2"[^>]*><v>[^<]*/)?.[0]);
  check('表头冻结（pane ySplit=1）', sheet.includes('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'), sheet.match(/<pane [^>]*>/)?.[0]);
  check('列宽按内容估算并写入 cols', sheet.includes('<cols><col min="1"'));
  check('dimension 覆盖实际范围', sheet.includes(`ref="A1:D${rows.length}"`), sheet.match(/<dimension ref="[^"]+"/)?.[0]);

  check('规模摘要如实统计', xlsx.summary.includes('4 行 × 4 列'), xlsx.summary);
  check('列名转换正确（A/Z/AA/AB）', columnName(0) === 'A' && columnName(25) === 'Z' && columnName(26) === 'AA' && columnName(27) === 'AB');

  const back = extractXlsxText(xlsx.bytes);
  check('反解读回工作表名', back.sheets.length === 1 && back.sheets[0] === '预算_执行', back.sheets.join(','));
  check('反解读回单元格内容（制表符分隔）', back.text.includes('人力成本\t420\t168\t40%'), JSON.stringify(back.text.split('\n')[1]));
  check('最小列名 A1 与最大列名对应（列名转换用在真实地址上）', back.text.split('\n')[0].startsWith('科目\t预算（万元）'));

  check('同一时间戳生成 → 逐字节可复现', buildXlsx({ rows, sheet: '预算/执行', now: FIXED }).bytes.equals(xlsx.bytes));

  const fromTable = rowsFromMarkdownTable('| a | b |\n| --- | --- |\n| 1 | 2 |');
  check('Markdown 表转行号正确（分隔行被剔除）', fromTable.length === 2 && fromTable[1][1] === '2', JSON.stringify(fromTable));
  check('非二维数组的 rows 有明确报错', throwsWith(() => buildXlsx({ rows: { a: 1 } }), '二维数组'));
  check('空 rows 有明确报错', throwsWith(() => buildXlsx({ rows: [] }), '没有任何列'));
  check('超长单元格有明确报错', throwsWith(() => buildXlsx({ rows: [['x'.repeat(33_000)]] }), '超过上限'));
}

// ══════════════════════════════════════════════════════════
// 5. OFD 原生读取（对独立产出的样本）
// ══════════════════════════════════════════════════════════
console.log('\n── OFD 原生读取 ──');
{
  const expected = fs.readFileSync(path.join(fixtures, 'sample.expected.txt'), 'utf8').replace(/\n$/, '');
  const sample = fs.readFileSync(path.join(fixtures, 'sample.ofd'));

  const result = extractOfdText(sample);
  check('页数正确', result.pages.length === 2, `${result.pages.length} 页 / ${result.blocks} 块`);
  check('全文与「产出方声明的期望文本」逐字一致', result.text === expected, result.text === expected ? '' : JSON.stringify(result.text.slice(0, 80)));

  const lines = result.pages[0].lines;
  check('按 Y 坐标排序（文档里是倒着写的，不排序必然错）', lines[0].includes('深边AI Work') && lines[1].includes('第二行'), JSON.stringify(lines.slice(0, 2)));
  check('中文片段拼接不补空格', lines[2] === '片段一片段二片段三', JSON.stringify(lines[2]));
  check('英文片段拼接补一个空格', lines[3] === 'Hello World', JSON.stringify(lines[3]));
  check('XML 实体还原（& < >）', lines[4] === '特殊字符 A & B <tag>', JSON.stringify(lines[4]));
  check('数字实体 &#12289; 还原成「、」', lines[5] === '报价：￥1,234.50、含税', JSON.stringify(lines[5]));
  check('批注（Annot）不混入正文', !result.text.includes('批注') && !result.text.includes('不应出现'));

  const stored = extractOfdText(fs.readFileSync(path.join(fixtures, 'sample-stored.ofd')));
  check('store 压缩的包读出同样结果（两条解压路径都过）', stored.text === expected);

  const single = extractOfdText(fs.readFileSync(path.join(fixtures, 'sample-single.ofd')));
  check('裸 XML 的单文件 OFD 也能读（不合规范形态但真实存在）', single.pages[0].lines[0].includes('深边AI Work'), single.pages[0].lines[0]);

  // 兜底路径：没有任何入口文件，只有 Content.xml
  const bare = zipWrite([{ name: 'Doc_0/Pages/Page_0/Content.xml', data: Buffer.from('<ofd:Page xmlns:ofd="x"><ofd:TextCode X="1" Y="1">兜底路径</ofd:TextCode></ofd:Page>', 'utf8') }]);
  check('缺少入口文件时按 Content.xml 兜底', extractOfdText(bare).text.includes('兜底路径'));

  const empty = zipWrite([{ name: 'Doc_0/Document.xml', data: Buffer.from('<ofd:Document/>', 'utf8') }, { name: 'Doc_0/Pages/Page_0/Content.xml', data: Buffer.from('<ofd:Page><ofd:PathObject ID="1"/></ofd:Page>', 'utf8') }]);
  check('只有图形没有文字的 OFD 明确报错（而不是返回空串）', throwsWith(() => extractOfdText(empty), '没有可提取的文字'));
  check('既非 zip 也非 OFD 的文件明确报错', throwsWith(() => extractOfdText(Buffer.from('这是一段普通文本，不是文档')), '不是 zip 包'));
  check(
    '声明了不存在的入口时明确报错',
    throwsWith(
      () => extractOfdText(zipWrite([{ name: 'OFD.xml', data: Buffer.from('<ofd:OFD xmlns:ofd="x"><ofd:DocRoot>No/Such.xml</ofd:DocRoot></ofd:OFD>', 'utf8') }])),
      '不在包内',
    ),
  );
}

// ══════════════════════════════════════════════════════════
// 6. 工具层：审批链与边界
// ══════════════════════════════════════════════════════════
async function toolSection() {
  console.log('\n── 工具层（审批链 / 边界 / 落地形态）──');
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const names = registry.list().map((tool) => tool.name);
  check('三个 Office 工具已注册进工具表', OFFICE_TOOLS.every((name) => names.includes(name)), names.filter((name) => name.startsWith('office.')).join(','));

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

  // ── 拒绝：必须不落盘 ──
  const deniedCtx = makeCtx(DENY_ALL);
  const denied = await registry.execute(OFFICE_DOCX_TOOL, { path: '报告.docx', content: '# 标题\n\n正文\n' }, deniedCtx);
  check('拒绝写入时工具返回失败并说明原因', denied.ok === false && denied.output.includes('拒绝'), denied.output.slice(0, 40));
  check('拒绝后文件确实没有落盘（不只是返回失败）', !fs.existsSync(path.join(workspace, '报告.docx')));
  check('审批请求带工具名与目标路径', calls[0]?.tool === OFFICE_DOCX_TOOL && calls[0]?.subject === '报告.docx');

  // ── 允许：落盘 + 差异是文本视图 ──
  const allowCtx = makeCtx(ALLOW_ALL);
  const preview = await registry.previewFor(OFFICE_DOCX_TOOL, { path: '报告.docx', content: '# 标题\n\n正文\n' }, allowCtx);
  check('预检给出差异（而不是「二进制文件」四个字）', preview !== null && preview.added > 0 && !preview.binary, preview ? `+${preview.added}` : 'null');
  check('新建文件的差异标记 created', preview?.created === true);
  const allowed = await registry.execute(OFFICE_DOCX_TOOL, { path: '报告.docx', content: '# 标题\n\n正文\n' }, allowCtx);
  check('允许后文件真的落盘', allowed.ok === true && fs.existsSync(path.join(workspace, '报告.docx')), allowed.output);
  const written = fs.readFileSync(path.join(workspace, '报告.docx'));
  const previewText = preview.hunks
    .flatMap((hunk) => hunk.lines.filter((line) => line.kind === 'add').map((line) => line.text))
    .join('\n');
  check(
    '预检里展示的文本 = 实际落盘文档的内容（同一份快照，不是两次读取）',
    previewText === textViewOfBytes(written, 'docx').text,
    JSON.stringify(previewText.slice(0, 40)),
  );
  check('回执含体积与规模摘要', /已新建 报告\.docx（[\d.]+ KB，/.test(allowed.output), allowed.output);

  // ── 审批理由必须说明「差异是文本视图」──
  check('审批理由说明了差异是文档的文本视图', calls.some((call) => String(call.reason).includes('文本视图')));

  // ── 内容无变化时短路，不打扰用户 ──
  const before = calls.length;
  const again = await registry.execute(OFFICE_DOCX_TOOL, { path: '报告.docx', content: '# 标题\n\n正文\n' }, makeCtx(ALLOW_ALL));
  check('重复生成同一内容 → 报「无变化」并不再弹审批', again.ok === true && again.output.includes('无变化') && calls.length === before, again.output);

  // ── 覆盖既有文件：差异是「旧文本 → 新文本」 ──
  // 用**新的 ctx**：预检快照的生命周期是「一次工具调用内」（生产里 mock-harness 每次
  // 调用都新建 ctx，见 adapter/mock-harness.ts 的 callTool）。拿旧 ctx 去预览会命中
  // 上一次的预检结果 —— 那是测试自己写错，不是实现的问题
  const overwrite = await registry.previewFor(
    OFFICE_DOCX_TOOL,
    { path: '报告.docx', content: '# 标题\n\n正文改了\n' },
    makeCtx(ALLOW_ALL),
  );
  check('覆盖既有文档时差异含增删（旧内容 → 新内容）', overwrite !== null && !overwrite.created && overwrite.added > 0 && overwrite.removed > 0, overwrite ? `+${overwrite.added} −${overwrite.removed}` : 'null');

  // ── 扩展名与边界 ──
  const mismatch = await registry.execute(OFFICE_DOCX_TOOL, { path: '报告.txt', content: 'x' }, makeCtx(ALLOW_ALL));
  check('扩展名不符时拒绝（名字与内容不符的文件最糟）', mismatch.ok === false && mismatch.output.includes('必须以 .docx 结尾'), mismatch.output.slice(0, 60));
  const noExt = await registry.execute(OFFICE_XLSX_TOOL, { path: '预算表', rows: [['a', 1]] }, makeCtx(ALLOW_ALL));
  check('无扩展名时自动补上 .xlsx', noExt.ok === true && fs.existsSync(path.join(workspace, '预算表.xlsx')), noExt.output);
  const escaped = await registry.execute(OFFICE_DOCX_TOOL, { path: '../逃逸.docx', content: 'x' }, makeCtx(ALLOW_ALL));
  check('越出工作区的路径被拒绝', escaped.ok === false && escaped.output.includes('越出工作区'), escaped.output.slice(0, 60));
  const badRows = await registry.execute(OFFICE_XLSX_TOOL, { path: '坏.xlsx', rows: '不是表格' }, makeCtx(ALLOW_ALL));
  check('rows 传了不可解析的字符串时报错而不是写出空表', badRows.ok === false && badRows.output.includes('二维数组'), badRows.output.slice(0, 60));

  // ── office.read：原生读 OFD ──
  fs.copyFileSync(path.join(fixtures, 'sample.ofd'), path.join(workspace, '公文.ofd'));
  const readCtx = createToolContext({ workspace, guard: { assess: () => ({ risk: 'safe', reason: 'test', blocked: false }) } });
  const readOfd = await registry.execute(OFFICE_READ_TOOL, { path: '公文.ofd' }, readCtx);
  check('office.read 原生读出 OFD 文本', readOfd.ok === true && readOfd.output.includes('深边AI Work OFD 读取样例'), readOfd.output.split('\n')[0]);
  check('回执里带摘要（页数 / 文本块 / 字符数）', /2 页 \/ \d+ 个文本块/.test(readOfd.output), readOfd.output.split('\n')[0]);
  check('读取是 safe 档：没有审批回调也照常执行', readOfd.ok === true);

  const readXlsxBack = await registry.execute(OFFICE_READ_TOOL, { path: '预算表.xlsx' }, readCtx);
  check('office.read 能读回自己刚生成的 xlsx', readXlsxBack.ok === true && readXlsxBack.output.includes('1'), readXlsxBack.output.split('\n')[1]?.slice(0, 40));

  const missing = await registry.execute(OFFICE_READ_TOOL, { path: '不存在.ofd' }, readCtx);
  check('读不存在的文件时报「不存在」', missing.ok === false && missing.output.includes('不存在'), missing.output);
  const unsupported = await registry.execute(OFFICE_READ_TOOL, { path: '公文.pdf' }, readCtx);
  check('不支持的扩展名会列出可用格式', unsupported.ok === false && unsupported.output.includes('.ofd'), unsupported.output.slice(0, 80));

  // ── readOfficeDocument / textViewOfBytes 直连 ──
  const viaRead = await readOfficeDocument(path.join(workspace, '公文.ofd'), '公文.ofd');
  check('readOfficeDocument 给出 kind=ofd 与页数', viaRead.kind === 'ofd' && viaRead.pages === 2);
  const view = textViewOfBytes(written, 'docx');
  check('textViewOfBytes 对 docx 给出文本视图', view.ok === true && view.text.includes('标题'));
  const badView = textViewOfBytes(Buffer.from('不是 docx'), 'docx');
  check('文本视图失败时返回原因而不是抛异常（旧文件坏了不该阻断生成）', badView.ok === false && typeof badView.reason === 'string');
}

// ══════════════════════════════════════════════════════════
// 7. 独立校验（Python 标准库：另一个实现的 zip + XML 解析器）
// ══════════════════════════════════════════════════════════
/**
 * 找可用的 Python —— 走产品自己的统一出口（`core-host/dist/runtime/python`），
 * 而不是在测试里另写一套探测。
 *
 * 为什么非要用同一个出口：测试用一套解析规则、产品用另一套，那「测试通过」
 * 就说明不了「产品上能用」—— 两条规则只是碰巧都叫 findPython 而已。
 * 顺带，本文件此前自己维护的候选清单（含一条写死的本机路径）也可以退休了。
 *
 * 找不到时返回 null，调用方 SKIP：本机没装 Python 是**环境事实**，不是失败。
 */
function findPython() {
  const { resolvePythonRuntime } = require('../packages/core-host/dist/runtime/python');
  const resolution = resolvePythonRuntime();
  if (!resolution) return null;
  pythonSource = resolution.label;
  return resolution.bin;
}

/** 独立校验脚本：zip 完整性 + 每个 XML 部件良构 + 内容类型覆盖 + 关系目标可解析 */
const PY_CHECKER = `
import json, os, sys, zipfile
import xml.etree.ElementTree as ET

CT = '{http://schemas.openxmlformats.org/package/2006/content-types}'
report = []
for path in sys.argv[1:]:
    item = {"name": os.path.basename(path), "zip": None, "xml": [], "contentTypes": None, "rels": []}
    with zipfile.ZipFile(path) as archive:
        item["zip"] = archive.testzip()          # None 表示每个条目的 CRC 都对
        names = archive.namelist()
        for name in names:
            if name.endswith(('.xml', '.rels')):
                try:
                    ET.fromstring(archive.read(name))
                except Exception as error:
                    item["xml"].append(f"{name}: {error}")
        if '[Content_Types].xml' in names:
            root = ET.fromstring(archive.read('[Content_Types].xml'))
            defaults = {e.get('Extension').lower() for e in root.findall(CT + 'Default')}
            overrides = {e.get('PartName') for e in root.findall(CT + 'Override')}
            item["contentTypes"] = [
                n for n in names
                if n != '[Content_Types].xml' and ('/' + n) not in overrides
                and n.rsplit('.', 1)[-1].lower() not in defaults
            ]
            for name in names:
                if not name.endswith('.rels'):
                    continue
                base = os.path.dirname(os.path.dirname(name))
                for rel in ET.fromstring(archive.read(name)):
                    target = (rel.get('Target') or '').lstrip('/')
                    resolved = os.path.normpath(os.path.join(base, target)).replace('\\\\', '/')
                    if target not in names and resolved not in names:
                        item["rels"].append(f"{name} -> {target}")
    report.append(item)
print(json.dumps(report, ensure_ascii=False))
`;

function independentSection() {
  console.log('\n── 独立校验（Python：另一个 zip/XML 实现）──');
  const python = findPython();
  if (!python) {
    skippable('Python 独立校验（zip 完整性 / XML 良构 / 内容类型覆盖 / 关系目标）', false, '本机没有可用的 python');
    return;
  }
  // 把用的是哪一档解释器打出来：随包那份与系统那份跑出的结论应当一致，
  // 但这个前提值得**看得见**，而不是靠猜
  console.log(`  （解释器来源：${pythonSource}）`);

  const checker = path.join(home, 'check.py');
  fs.writeFileSync(checker, PY_CHECKER, 'utf8');

  const docxPath = path.join(home, 'check.docx');
  const xlsxPath = path.join(home, 'check.xlsx');
  fs.writeFileSync(docxPath, docx.bytes);
  fs.writeFileSync(xlsxPath, xlsx.bytes);

  const targets = [docxPath, xlsxPath, path.join(fixtures, 'sample.ofd'), path.join(fixtures, 'sample-stored.ofd')];
  const run = spawnSync(python, [checker, ...targets], { encoding: 'utf8' });
  if (run.status !== 0) {
    check('Python 独立校验脚本能跑起来', false, String(run.stderr).slice(0, 200));
    return;
  }

  const report = JSON.parse(run.stdout);
  for (const item of report) {
    check(`${item.name}：zip 每个条目的 CRC 都正确（另一个实现解出来的）`, item.zip === null, String(item.zip ?? ''));
    check(`${item.name}：每个 XML 部件都能被真正的 XML 解析器解析`, item.xml.length === 0, item.xml.join('; ').slice(0, 120));
    if (item.contentTypes !== null) {
      check(`${item.name}：内容类型覆盖了全部部件（缺一个 Office 就报「文件已损坏」）`, item.contentTypes.length === 0, item.contentTypes.join(','));
    }
    check(`${item.name}：所有关系目标都能在包内解析到`, item.rels.length === 0, item.rels.join('; '));
  }
}

// ══════════════════════════════════════════════════════════
// 8. 接线取证
// ══════════════════════════════════════════════════════════
function wiringSection() {
  console.log('\n── 接线取证 ──');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  check('package.json 注册了 test:office', pkg.scripts['test:office'] === 'npm run build && node tools/office-test.js', pkg.scripts['test:office']);
  check('verify 链里包含 office 测试', String(pkg.scripts.verify).includes('tools/office-test.js'));
  check('verify 链尾仍是真实 MCP 套件（已知失败不遮蔽后续）', String(pkg.scripts.verify).trimEnd().endsWith('node tools/real-dsh-mcp-test.js'));
  check('真实软件打开取证的脚本存在', fs.existsSync(path.join(root, 'tools', 'open-with-office.js')));
  check('OFD 样本生成脚本存在（样本必须可重建）', fs.existsSync(path.join(root, 'tools', 'fixtures', 'make-ofd-fixture.py')));
  const capture = fs.readFileSync(path.join(root, 'tools', 'capture.sh'), 'utf8');
  check('capture.sh 有 office 场景', /\boffice\)/.test(capture));

  // 生成侧不许引第三方库：运行时只依赖 Node 内置
  const sources = ['zip', 'xml', 'text', 'docx', 'xlsx', 'ofd', 'read'].map((name) =>
    fs.readFileSync(path.join(root, 'packages', 'core-host', 'src', 'office', `${name}.ts`), 'utf8'),
  );
  const externals = sources
    .flatMap((source) => [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]))
    .filter((spec) => !spec.startsWith('.') && spec !== 'node:fs/promises' && spec !== 'node:path' && spec !== 'node:zlib' && spec !== '@deepwork/protocol');
  check('实现里没有第三方依赖（只有 node: 内置与协议包）', externals.length === 0, externals.join(','));
}

async function main() {
  await toolSection();
  independentSection();
  wiringSection();

  const hard = results.filter((item) => !item.ok && !item.skip);
  const skipped = results.filter((item) => item.skip);
  console.log(`\nOffice 文档测试：${results.length - hard.length}/${results.length} 通过${skipped.length ? `（${skipped.length} 项 SKIP）` : ''}`);
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
