/**
 * docx 生成（纯 Node，零依赖）与反解。
 *
 * ── 为什么手写而不是引 `docx` 包 ────────────────────────────────
 * 一个 .docx 就是 zip + 六个 XML 部件；我们要的形态（标题/段落/列表/引用/
 * 代码块/表格）用不到那个包的十分之一，却要连带引入它的传递依赖与升级节奏。
 * 先例是 `tools/make-icon.js` 手写 PNG 编码器：**最小可用且可验收**比功能齐全更重要。
 *
 * ── 验收口径（这条决定了全部实现取舍）────────────────────────────
 * 「写出来的文件能被真实 Office / WPS 打开」是**验收动作**，不是可选项。
 * 因此凡是打开时会被校验的东西一件都不能省：
 *  - `[Content_Types].xml` 必须声明每一个部件（少一个 → WPS 报「文件已损坏」）；
 *  - `_rels/.rels` 必须把 officeDocument 关系指向 word/document.xml；
 *  - `word/_rels/document.xml.rels` 必须声明 styles / numbering 关系
 *    （引用了 styles.xml 却没声明关系，Word 会直接拒绝打开，而 WPS 只是样式丢失 —— 
 *     这种「一边能开一边不能开」的差异只能靠按规范写来避免）；
 *  - 编号列表必须有 numbering.xml 且 numId 对得上，否则列表渲染成普通段落。
 *
 * ── 反解为什么也要写 ──────────────────────────────────────────
 * 两个用途：审批弹窗要展示「这份文档将要变成什么」（文本视图差异，见 builtin.ts），
 * 以及测试可以做「写→读」往返断言。反解是**容错**的（见 xml.ts 的说明），
 * 它只负责把字读出来，不负责判定规范符合性。
 */

import { escapeXml, blocksOf, textsOf } from './xml';
import { smartJoin } from './text';
import { entryText, zipWrite, zipRead, type ZipEntryInput } from './zip';

// ── 块模型 ────────────────────────────────────────────────────

export interface HeadingBlock {
  kind: 'heading';
  level: number;
  text: string;
}
export interface ParagraphBlock {
  kind: 'paragraph';
  text: string;
}
export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  level: number;
  text: string;
}
export interface QuoteBlock {
  kind: 'quote';
  text: string;
}
export interface CodeBlock {
  kind: 'code';
  lang: string;
  lines: string[];
}
export interface TableBlock {
  kind: 'table';
  rows: string[][];
}
export interface RuleBlock {
  kind: 'rule';
}

export type DocxBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | QuoteBlock
  | CodeBlock
  | TableBlock
  | RuleBlock;

// ── Markdown 子集解析 ─────────────────────────────────────────

const FENCE = /^\s*(```|~~~)\s*([A-Za-z0-9_+.#-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isRule(line: string): boolean {
  return RULE.test(line);
}

/** 表格分隔行：`| --- | :--: |` 这类 */
function isTableSeparator(line: string): boolean {
  return Boolean(line) && TABLE_SEP.test(line);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * 这一行会不会开启一个新块？
 *
 * 段落收集靠它决定在哪停 —— 少了这一层，`# 标题` 会被吸进上一段的正文里，
 * 而症状是「生成的文档少了一个标题」，看上去像是样式没生效。
 */
function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  if (line.trim() === '') return true;
  if (FENCE.test(line)) return true;
  if (HEADING.test(line)) return true;
  if (isRule(line)) return true;
  if (QUOTE.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) return true;
  return false;
}

export function parseMarkdownSubset(markdown: string): DocxBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocxBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      // 未闭合的围栏：不报错，把剩下的都当代码 —— 模型漏写收尾围栏是常见事
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'code', lang, lines: body });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows: string[][] = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', rows });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = item[1].replace(/\t/g, '  ').length;
      blocks.push({
        kind: 'list',
        ordered: /^\d/.test(item[2]),
        // 缩进每两级算下一层；夹到 3 层（numbering.xml 只定义了 3 层）
        level: Math.min(3, Math.floor(indent / 2) + 1),
        text: item[3],
      });
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const parts: string[] = [quote[1]];
      i += 1;
      while (i < lines.length) {
        const next = QUOTE.exec(lines[i]);
        if (!next) break;
        parts.push(next[1]);
        i += 1;
      }
      blocks.push({ kind: 'quote', text: parts.reduce((acc, part) => smartJoin(acc, part), '') });
      continue;
    }

    // 段落：一直吃到下一个块开始
    const parts: string[] = [];
    while (i < lines.length && !startsBlock(lines, i)) {
      parts.push(lines[i].trim());
      i += 1;
    }
    if (parts.length) {
      blocks.push({ kind: 'paragraph', text: parts.reduce((acc, part) => smartJoin(acc, part), '') });
      continue;
    }

    i += 1; // 空行
  }

  return blocks;
}

// ── 内联样式 ──────────────────────────────────────────────────

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** 解析行内标记：`**粗**` / `*斜*` / `` `码` `` / `[文字](链接)`，支持嵌套一层 */
export function parseInline(input: string): Run[] {
  const runs: Run[] = [];
  let text = '';
  let bold = false;
  let italic = false;
  let i = 0;

  const flush = (): void => {
    if (!text) return;
    runs.push({ text, bold: bold || undefined, italic: italic || undefined });
    text = '';
  };

  while (i < input.length) {
    const rest = input.slice(i);

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      runs.push({ text: code[1], code: true });
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      const label = link[1] || link[2];
      runs.push({ text: label, bold: bold || undefined, italic: italic || undefined });
      // 网址附在括号里：真超链接要在 rels 里登记关系，代价远超收益；
      // 而「文字与链接都看得见」才是读文档时真正需要的信息
      if (link[1] && link[1] !== link[2]) {
        runs.push({ text: `（${link[2]}）`, bold: bold || undefined, italic: italic || undefined });
      }
      i += link[0].length;
      continue;
    }

    if (rest.startsWith('**') || rest.startsWith('__')) {
      const marker = rest.slice(0, 2);
      const end = rest.indexOf(marker, 2);
      if (end > 2) {
        flush();
        for (const run of parseInline(rest.slice(2, end))) runs.push({ ...run, bold: true });
        i += end + marker.length;
        continue;
      }
    }

    if (rest[0] === '*' || rest[0] === '_') {
      const marker = rest[0];
      const end = rest.indexOf(marker, 1);
      if (end > 1) {
        flush();
        for (const run of parseInline(rest.slice(1, end))) runs.push({ ...run, italic: true });
        i += end + 1;
        continue;
      }
    }

    if (rest[0] === '\\' && rest.length > 1) {
      text += rest[1];
      i += 2;
      continue;
    }

    text += rest[0];
    i += 1;
  }

  flush();
  return runs;
}

/** 文本 → w:t / w:br / w:tab（换行与制表符是元素，不是字符） */
function inlineTextXml(value: string): string {
  return value
    .split(/(\n|\t)/)
    .map((part) => {
      if (part === '\n') return '<w:br/>';
      if (part === '\t') return '<w:tab/>';
      if (!part) return '';
      return `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
    })
    .join('');
}

function runsToXml(runs: Run[], forceBold = false): string {
  return runs
    .map((run) => {
      const props: string[] = [];
      if (run.bold || forceBold) props.push('<w:b/><w:bCs/>');
      if (run.italic) props.push('<w:i/><w:iCs/>');
      if (run.code) {
        props.push(
          '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>',
          '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>',
        );
      }
      const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
      return `<w:r>${rPr}${inlineTextXml(run.text)}</w:r>`;
    })
    .join('');
}

// ── 块 → XML ─────────────────────────────────────────────────

function paragraphXml(inner: string, pPr = ''): string {
  const props = pPr ? `<w:pPr>${pPr}</w:pPr>` : '';
  if (!props && !inner) return '<w:p/>';
  return `<w:p>${props}${inner}</w:p>`;
}

function blockToXml(block: DocxBlock): string {
  switch (block.kind) {
    case 'heading':
      return paragraphXml(
        runsToXml(parseInline(block.text)),
        `<w:pStyle w:val="Heading${Math.min(6, Math.max(1, block.level))}"/>`,
      );
    case 'paragraph':
      return paragraphXml(runsToXml(parseInline(block.text)));
    case 'list':
      return paragraphXml(
        runsToXml(parseInline(block.text)),
        `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${block.level - 1}"/>` +
          `<w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr>`,
      );
    case 'quote':
      return paragraphXml(runsToXml(parseInline(block.text)), '<w:pStyle w:val="Quote"/>');
    case 'code': {
      // 代码块整体是一个段落，行间用 w:br 分隔 —— 这样它在文档里不会被
      // 「段落间距」打散成一堆小块，选中复制时也是一整段
      const runs: Run[] = [];
      block.lines.forEach((line, index) => {
        if (index > 0) runs.push({ text: '\n', code: true });
        runs.push({ text: line, code: true });
      });
      return paragraphXml(runs.length ? runsToXml(runs) : '', '<w:pStyle w:val="Code"/>');
    }
    case 'table': {
      const cols = Math.max(...block.rows.map((row) => row.length));
      const width = Math.max(600, Math.floor(9000 / Math.max(1, cols)));
      const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('');
      const rows = block.rows
        .map((row, rowIndex) => {
          const cells = Array.from({ length: cols }, (_, colIndex) => {
            const cell = row[colIndex] ?? '';
            const inner = runsToXml(parseInline(cell), rowIndex === 0);
            return (
              `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>` +
              `${paragraphXml(inner)}</w:tc>`
            );
          }).join('');
          // 首行标记为表头：跨页时重复，且样式里有 firstRow 加粗
          const trPr = rowIndex === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
          return `<w:tr>${trPr}${cells}</w:tr>`;
        })
        .join('');
      return (
        '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>' +
        '<w:tblLook w:val="04A0"/></w:tblPr>' +
        `<w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`
      );
    }
    case 'rule':
      return paragraphXml('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>');
  }
}

/** 规模摘要，供审批理由与工具回执使用 */
export function summarizeBlocks(blocks: DocxBlock[]): string {
  const count = (kind: DocxBlock['kind']): number => blocks.filter((block) => block.kind === kind).length;
  const parts: string[] = [];
  const heading = count('heading');
  const paragraph = count('paragraph');
  const list = count('list');
  const quote = count('quote');
  const code = count('code');
  const table = count('table');
  if (heading) parts.push(`标题 ${heading}`);
  if (paragraph) parts.push(`段落 ${paragraph}`);
  if (list) parts.push(`列表 ${list}`);
  if (quote) parts.push(`引用 ${quote}`);
  if (code) parts.push(`代码块 ${code}`);
  if (table) {
    const sizes = blocks.filter((block) => block.kind === 'table') as TableBlock[];
    parts.push(`表格 ${table}（${sizes.map((item) => `${item.rows.length}×${Math.max(...item.rows.map((row) => row.length))}`).join(' ')}）`);
  }
  return parts.length ? parts.join(' / ') : '空文档';
}

// ── 部件 ─────────────────────────────────────────────────────

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DP_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CORE_NS = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
/** 注意与 CORE_NS 不同：核心属性的**关系类型**多一段 /relationships，拼错 WPS 会忽略标题 */
const CORE_REL_TYPE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const DCTERMS_NS = 'http://purl.org/dc/terms/';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const APP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';

export const OFFICE_PRODUCER = '深边AI Work';

function headingsXml(): string {
  const sizes = [
    { id: 1, size: 36, outline: 0 },
    { id: 2, size: 32, outline: 1 },
    { id: 3, size: 28, outline: 2 },
    { id: 4, size: 24, outline: 3 },
    { id: 5, size: 22, outline: 4 },
    { id: 6, size: 22, outline: 5 },
  ];
  return sizes
    .map(
      (item) =>
        `<w:style w:type="paragraph" w:styleId="Heading${item.id}"><w:name w:val="heading ${item.id}"/>` +
        `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:keepNext/><w:spacing w:before="${360 - item.id * 20}" w:after="120"/>` +
        `<w:outlineLvl w:val="${item.outline}"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="${item.size}"/><w:szCs w:val="${item.size}"/></w:rPr></w:style>`,
    )
    .join('');
}

function stylesXml(): string {
  return (
    `${XML_HEAD}<w:styles xmlns:w="${W_NS}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    // eastAsia 指定中文字体：不写的话 WPS 会用一个随机的替代字体，
    // 中文文档看上去「和预期不一样」，而根源只是缺这一行
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="等线" w:cs="Calibri"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
    '<w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>' +
    headingsXml() +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="CCCCCC"/></w:pBdr>' +
    '<w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>' +
    '<w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/>' +
    '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="240"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>' +
    '<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
    '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:qFormat/>' +
    '<w:tblPr><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr>' +
    '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr></w:tblStylePr></w:style>' +
    '</w:styles>'
  );
}

function numberingXml(): string {
  const bullet = (ilvl: number, char: string, left: number) =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
    `<w:lvlText w:val="${char}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`;
  const ordered = (ilvl: number, left: number) =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
    `<w:lvlText w:val="%${ilvl + 1}."/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`;

  return (
    `${XML_HEAD}<w:numbering xmlns:w="${W_NS}">` +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    bullet(0, '●', 720) +
    bullet(1, '○', 1440) +
    bullet(2, '▪', 2160) +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>' +
    ordered(0, 720) +
    ordered(1, 1440) +
    ordered(2, 2160) +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
  );
}

function contentTypesXml(): string {
  return (
    `${XML_HEAD}<Types xmlns="${CT_NS}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>'
  );
}

function rootRelsXml(): string {
  return (
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${DP_REL_NS}/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="${CORE_REL_TYPE}" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${DP_REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
    '</Relationships>'
  );
}

function documentRelsXml(): string {
  return (
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${DP_REL_NS}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${DP_REL_NS}/numbering" Target="numbering.xml"/>` +
    '</Relationships>'
  );
}

function coreXml(title: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `${XML_HEAD}<cp:coreProperties xmlns:cp="${CORE_NS}" xmlns:dc="${DC_NS}" ` +
    `xmlns:dcterms="${DCTERMS_NS}" xmlns:xsi="${XSI_NS}">` +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dc:creator>${OFFICE_PRODUCER}</dc:creator>` +
    `<cp:lastModifiedBy>${OFFICE_PRODUCER}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

function appXml(): string {
  return (
    `${XML_HEAD}<Properties xmlns="${APP_NS}">` +
    `<Application>${escapeXml(OFFICE_PRODUCER)}</Application><DocSecurity>0</DocSecurity>` +
    '<ScaleCrop>false</ScaleCrop><Company></Company><LinksUpToDate>false</LinksUpToDate>' +
    '<SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>' +
    '<AppVersion>16.0000</AppVersion></Properties>'
  );
}

// ── 对外接口 ─────────────────────────────────────────────────

export interface BuildDocxInput {
  /** 文档标题；给了就作为 Title 段落放在最前，并写进 docProps */
  title?: string;
  markdown: string;
  /** 生成时间。传入固定值可得到逐字节相同的产物（测试用） */
  now?: Date;
}

export interface BuildDocxOutput {
  bytes: Buffer;
  blocks: DocxBlock[];
  summary: string;
}

export function buildDocx(input: BuildDocxInput): BuildDocxOutput {
  const blocks = parseMarkdownSubset(input.markdown);
  const body: string[] = [];

  if (input.title) {
    body.push(paragraphXml(runsToXml([{ text: input.title }]), '<w:pStyle w:val="Title"/>'));
  }
  for (const block of blocks) body.push(blockToXml(block));

  // 最小可用的节属性：A4、默认页边距。没有 sectPr 的文档 Word 也能开，
  // 但打印时页面尺寸会取决于读取器默认值，明确写出来更稳
  body.push(
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
      'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>',
  );

  const documentXml =
    `${XML_HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body.join('')}</w:body></w:document>`;

  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRelsXml(), 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRelsXml(), 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml(), 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(numberingXml(), 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(coreXml(input.title ?? '文档', input.now ?? new Date()), 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(appXml(), 'utf8') },
  ];

  return {
    bytes: zipWrite(entries, { date: input.now }),
    blocks,
    summary: summarizeBlocks(blocks),
  };
}

/** 段落文本：同一段里的多个 `w:t` 是断开的 run，必须直接相连（中间不能补空格） */
function paragraphText(xml: string): string {
  return textsOf(xml, 't').join('').replace(/\s+$/, '');
}

export interface ExtractDocxOutput {
  text: string;
  blocks: number;
  pages?: number;
}

/**
 * 从 docx 字节反解文本。
 *
 * 容错策略：正文按出现顺序单趟扫描，段落与表格一起收 —— 关键在于**表格要整块吃掉**，
 * 否则单元格里的 `<w:p>` 会被当成正文段落，读出来是一堆碎片行（见函数内的说明）。
 */
export function extractDocxText(bytes: Buffer): ExtractDocxOutput {
  const entries = zipRead(bytes);
  let documentXml = entryText(entries, 'word/document.xml');
  if (!documentXml) {
    const candidates = [...entries.keys()].filter((name) => /(^|\/)document\.xml$/i.test(name));
    if (!candidates.length) throw new Error('这个 docx 里没有 word/document.xml（可能不是 Word 文档）');
    documentXml = entries.get(candidates[0])!.toString('utf8');
  }

  // 换行与制表符在 OOXML 里是元素
  const normalized = documentXml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<w:cr\s*\/>/g, '\n');

  /**
   * 单趟扫描：段落与表格按出现顺序一起收。
   *
   * 早先的写法是「先把表格整块换成占位符、抽完段落再替换回去」，那条路有个安静的坑：
   * 占位符落在 `<w:p>` 之外，抽段落时被整块丢掉 —— 症状是「生成的文档明明有表格，
   * 读回来却没有」。而如果测试只断言「关键段落都在」，这条会漏过去。
   *
   * 正则的两个分支是有序的：扫描到 `<w:tbl` 时第一个分支吃掉整张表，
   * 于是表内单元格里的 `<w:p>` 不会被当成正文段落（这正是要用占位符的原因，
   * 现在由分支顺序直接保证）。
   */
  const BODY_RE =
    /<(?:[A-Za-z0-9_.-]+:)?tbl(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?tbl\s*>|<(?:[A-Za-z0-9_.-]+:)?p(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?p\s*>/g;

  const lines: string[] = [];
  for (const match of normalized.matchAll(BODY_RE)) {
    const block = match[0];
    if (/^<(?:\w+:)?tbl/.test(block)) {
      const rows = blocksOf(block, 'tr').map((row) =>
        blocksOf(row, 'tc')
          .map((cell) => blocksOf(cell, 'p').map((p) => paragraphText(p)).filter(Boolean).join(' '))
          .join(' | '),
      );
      const table = rows.join('\n').trim();
      if (table) lines.push(table);
      continue;
    }
    const text = paragraphText(block);
    if (text.trim()) lines.push(text);
  }

  // 显式分页符数量 → 页数（没有就不给这个字段：猜出来的页数比没有更糟）
  const breaks = (normalized.match(/<w:br w:type="page"\s*\/>/g) ?? []).length;
  const pageBreaks = (normalized.match(/<w:lastRenderedPageBreak\s*\/>/g) ?? []).length;

  return {
    text: lines.join('\n'),
    blocks: lines.length,
    pages: breaks + pageBreaks > 0 ? breaks + pageBreaks + 1 : undefined,
  };
}
