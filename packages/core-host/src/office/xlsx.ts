/**
 * xlsx 生成（纯 Node，零依赖）与反解。
 *
 * 与 docx 同样的取舍：不引库，按规范手写最小可用形态。
 * 但 xlsx 比 docx 多两个**必须照顾**的坑，它们都属于「写出来的文件 Excel 打不开
 * 或者打开报错，而错误信息完全不指向真正的原因」那一类：
 *
 *  1. `styles.xml` 里 `<fills>` **必须至少两个**，且第 0 个是 `none`、第 1 个是
 *     `gray125`。这是 Excel 自己写出来的固定形态，规范文字里看不出来；
 *     少一个 fill 时 Excel 会报「发现不可读取的内容」，而文件其实是好的。
 *  2. 工作表名不能含 `: \ / ? * [ ]`，且 ≤ 31 字符。名称非法时 Excel 直接拒绝打开
 *     （不是重命名、不是忽略）。因此这里**主动清洗**而不是把非法名写进去。
 *
 * 规模上限走契约层常量：超限就报错，不静默截断 —— 一个「只有前 200 行」的表格
 * 看起来是成功的，用户要过很久才会发现少了数据。
 */

import { OFFICE_MAX_CELL_CHARS, OFFICE_MAX_COLS, OFFICE_MAX_ROWS } from '@deepwork/protocol';
import { escapeXml, attrOf, blocksOf, openTagsOf, textsOf } from './xml';
import { entryText, zipRead, zipWrite, type ZipEntryInput } from './zip';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const SS_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DP_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CORE_NS = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const DCTERMS_NS = 'http://purl.org/dc/terms/';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const APP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
const CORE_REL_TYPE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';

const PRODUCER = '深边AI Work';

export type CellValue = string | number | boolean | null | undefined;

export interface BuildXlsxInput {
  rows: CellValue[][];
  /** 工作表名（非法字符会被清洗） */
  sheet?: string;
  /** 首行是否为表头（加粗 + 冻结首行），默认 true */
  header?: boolean;
  now?: Date;
}

export interface BuildXlsxOutput {
  bytes: Buffer;
  /** 实际写入的数据行数（不含表头以外的空行） */
  dataRows: number;
  columns: number;
  summary: string;
}

/** 工作表名清洗：Excel 的硬规则，不是审美问题 */
export function sanitizeSheetName(name: string | undefined, fallback = 'Sheet1'): string {
  const cleaned = (name ?? '').replace(/[:\\/?*[\]]/g, '_').trim();
  const trimmed = cleaned.slice(0, 31);
  return trimmed || fallback;
}

/** 列下标 → 列名（0 → A，25 → Z，26 → AA） */
export function columnName(index: number): string {
  let value = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
}

/**
 * 把单元格规整成三种形态之一。
 *
 * 数字保持数字（Excel 里才能参与计算），布尔转 `b`，其余一律进共享字符串表。
 * 空值返回 null，调用方据此跳过这个 `<c>` —— 写一个空字符串单元格会让
 * 「这一格有内容但看不见」的错觉出现在读取端。
 */
function normalizeCell(value: CellValue): { kind: 'number'; value: number } | { kind: 'bool'; value: 0 | 1 } | { kind: 'text'; value: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { kind: 'text', value: String(value) };
    return { kind: 'number', value };
  }
  if (typeof value === 'boolean') return { kind: 'bool', value: value ? 1 : 0 };
  const text = String(value);
  if (text === '') return null;
  if (text.length > OFFICE_MAX_CELL_CHARS) {
    throw new Error(`单元格内容 ${text.length} 字符，超过上限 ${OFFICE_MAX_CELL_CHARS}（Excel 自身也是 32767）`);
  }
  return { kind: 'text', value: text };
}

/** 显示宽度：CJK 占两格，据此估算列宽 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += (code >= 0x1100 && code <= 0xffe6) ? 2 : 1;
  }
  return width;
}

function contentTypesXml(): string {
  return (
    `${XML_HEAD}<Types xmlns="${CT_NS}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>'
  );
}

function rootRelsXml(): string {
  return (
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${DP_REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="${CORE_REL_TYPE}" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${DP_REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
    '</Relationships>'
  );
}

function workbookXml(sheetName: string): string {
  return (
    `${XML_HEAD}<workbook xmlns="${SS_NS}" xmlns:r="${R_NS}">` +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

function workbookRelsXml(): string {
  return (
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${DP_REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${DP_REL_NS}/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rId3" Type="${DP_REL_NS}/styles" Target="styles.xml"/>` +
    '</Relationships>'
  );
}

/** 见文件头注释第 1 条：两个 fill 是 Excel 的硬形态要求 */
function stylesXml(): string {
  return (
    `${XML_HEAD}<styleSheet xmlns="${SS_NS}">` +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="2">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

function sharedStringsXml(strings: string[], totalRefs: number): string {
  return (
    `${XML_HEAD}<sst xmlns="${SS_NS}" count="${totalRefs}" uniqueCount="${strings.length}">` +
    strings.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join('') +
    '</sst>'
  );
}

function coreXml(title: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `${XML_HEAD}<cp:coreProperties xmlns:cp="${CORE_NS}" xmlns:dc="${DC_NS}" ` +
    `xmlns:dcterms="${DCTERMS_NS}" xmlns:xsi="${XSI_NS}">` +
    `<dc:title>${escapeXml(title)}</dc:title><dc:creator>${PRODUCER}</dc:creator>` +
    `<cp:lastModifiedBy>${PRODUCER}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

function appXml(sheetName: string): string {
  return (
    `${XML_HEAD}<Properties xmlns="${APP_NS}">` +
    `<Application>${escapeXml(PRODUCER)}</Application><DocSecurity>0</DocSecurity>` +
    '<ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes" size="2" baseType="variant">' +
    '<vt:variant><vt:lpstr>工作表</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>' +
    '</vt:vector></HeadingPairs><TitlesOfParts>' +
    `<vt:vector xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes" size="1" baseType="lpstr"><vt:lpstr>${escapeXml(sheetName)}</vt:lpstr></vt:vector>` +
    '</TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate>' +
    '<SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>' +
    '<AppVersion>16.0000</AppVersion></Properties>'
  );
}

export function buildXlsx(input: BuildXlsxInput): BuildXlsxOutput {
  const rows = input.rows;
  if (!Array.isArray(rows)) throw new Error('rows 必须是二维数组');
  if (rows.length > OFFICE_MAX_ROWS) {
    throw new Error(`行数 ${rows.length} 超过上限 ${OFFICE_MAX_ROWS}，请拆分或改用 csv`);
  }

  const columns = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  if (columns === 0) throw new Error('rows 里没有任何列，无法生成工作表');
  if (columns > OFFICE_MAX_COLS) {
    throw new Error(`列数 ${columns} 超过上限 ${OFFICE_MAX_COLS}`);
  }

  const header = input.header !== false;
  const sheetName = sanitizeSheetName(input.sheet);

  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const internText = (value: string): number => {
    const existing = sharedIndex.get(value);
    if (existing !== undefined) return existing;
    const index = shared.length;
    shared.push(value);
    sharedIndex.set(value, index);
    return index;
  };

  let sharedRefs = 0;
  const rowXml: string[] = [];
  /** 每列的显示宽度上界，用来算 <cols> */
  const widths = new Array<number>(columns).fill(0);

  rows.forEach((row, rowIndex) => {
    const cells: string[] = [];
    const values = Array.isArray(row) ? row : [];
    for (let colIndex = 0; colIndex < columns; colIndex += 1) {
      const normalized = normalizeCell(values[colIndex]);
      if (!normalized) continue;
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      const style = header && rowIndex === 0 ? ' s="1"' : '';
      if (normalized.kind === 'text') {
        const index = internText(normalized.value);
        sharedRefs += 1;
        cells.push(`<c r="${ref}"${style} t="s"><v>${index}</v></c>`);
        widths[colIndex] = Math.max(widths[colIndex], displayWidth(normalized.value));
      } else if (normalized.kind === 'bool') {
        cells.push(`<c r="${ref}"${style} t="b"><v>${normalized.value}</v></c>`);
        widths[colIndex] = Math.max(widths[colIndex], 5);
      } else {
        cells.push(`<c r="${ref}"${style}><v>${normalized.value}</v></c>`);
        widths[colIndex] = Math.max(widths[colIndex], String(normalized.value).length);
      }
    }
    if (cells.length) rowXml.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`);
  });

  const cols = widths
    .map((width, index) => {
      const size = Math.min(60, Math.max(8, width + 2));
      return `<col min="${index + 1}" max="${index + 1}" width="${size}" customWidth="1"/>`;
    })
    .join('');

  const dimension = `A1:${columnName(columns - 1)}${Math.max(1, rows.length)}`;
  const views = header
    ? '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

  const sheetXml =
    `${XML_HEAD}<worksheet xmlns="${SS_NS}" xmlns:r="${R_NS}">` +
    `<dimension ref="${dimension}"/>` +
    views +
    `<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols>` +
    `<sheetData>${rowXml.join('')}</sheetData>` +
    '</worksheet>';

  const now = input.now ?? new Date();
  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRelsXml(), 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(sheetName), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelsXml(), 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStringsXml(shared, sharedRefs), 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml(), 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(coreXml(sheetName, now), 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(appXml(sheetName), 'utf8') },
  ];

  const dataRows = rowXml.length;
  return {
    bytes: zipWrite(entries, { date: input.now }),
    dataRows,
    columns,
    summary: `${dataRows} 行 × ${columns} 列${header ? '（首行表头，已冻结）' : ''}`,
  };
}

/**
 * 从 Markdown 管道表格解析行。
 *
 * 支持它是为了「模型手里已经有一张 markdown 表格」这个高频场景 ——
 * 否则模型得先把表格拆成 JSON 数组再传，多一步就多一类出错。
 */
export function rowsFromMarkdownTable(text: string): CellValue[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.includes('|'));
  const rows: CellValue[][] = [];
  for (const line of lines) {
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // 分隔行
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    rows.push(cells);
  }
  return rows;
}

export interface ExtractXlsxOutput {
  text: string;
  blocks: number;
  sheets: string[];
}

/** 反解：共享字符串表 + 工作表单元格 → 制表符分隔的文本 */
export function extractXlsxText(bytes: Buffer): ExtractXlsxOutput {
  const entries = zipRead(bytes);
  const sharedXml = entryText(entries, 'xl/sharedStrings.xml') ?? '';
  // 一个 <si> 可以由多个 <r><t> 组成，必须按 si 先分组再连接，
  // 否则「中文」被拆成两个 run 时会变成两个不同的字符串，编号全部错位
  const shared = blocksOf(sharedXml, 'si').map((si) => textsOf(si, 't').join(''));

  // 工作表元素是自闭合的（<sheet name=".." sheetId="1" r:id="rId1"/>），
  // 用「成对标签」抽取会一个都匹配不到，工作表名就成了空数组 ——
  // 这个字段本身只是回执信息，但它错了会让人怀疑解析整体不对
  const sheetNames = openTagsOf(entryText(entries, 'xl/workbook.xml') ?? '', 'sheet')
    .map((tag) => attrOf(tag, 'name'))
    .filter((name): name is string => Boolean(name));

  const sheetPath =
    [...entries.keys()].find((name) => /^xl\/worksheets\/sheet1\.xml$/i.test(name)) ??
    [...entries.keys()].find((name) => /^xl\/worksheets\/.+\.xml$/i.test(name));
  if (!sheetPath) throw new Error('这个 xlsx 里没有工作表（可能不是 Excel 工作簿）');
  const sheetXml = entries.get(sheetPath)!.toString('utf8');

  const lines: string[] = [];
  let blocks = 0;

  for (const row of blocksOf(sheetXml, 'row')) {
    const cells: string[] = [];
    let hasValue = false;
    for (const cell of blocksOf(row, 'c')) {
      const type = attrOf(cell, 't');
      let value = '';
      if (type === 's') {
        const index = Number.parseInt(textsOf(cell, 'v').join(''), 10);
        value = Number.isFinite(index) ? shared[index] ?? '' : '';
      } else if (type === 'inlineStr') {
        value = textsOf(cell, 't').join('');
      } else if (type === 'b') {
        value = textsOf(cell, 'v').join('') === '1' ? 'TRUE' : 'FALSE';
      } else {
        value = textsOf(cell, 'v').join('');
      }
      if (value !== '') {
        hasValue = true;
        blocks += 1;
      }
      cells.push(value);
    }
    if (hasValue) lines.push(cells.join('\t').replace(/\t+$/, ''));
  }

  return { text: lines.join('\n'), blocks, sheets: sheetNames };
}
