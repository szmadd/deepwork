/**
 * OFD 原生读取（GB/T 33190-2016 版式文档）。
 *
 * ── 为什么要「原生」────────────────────────────────────────────
 * OFD 是国标版式文档格式，在电子发票、财政票据、公文、电子证照里是**法定格式**，
 * 而它恰恰是主流文档处理库支持最差的一个（PDF 有几十个成熟实现，OFD 几乎没有
 * 纯 JS 的）。常规做法是调外部转换器或装 WPS —— 前者不可依赖、后者不是软件该有的前提。
 *
 * 这里按规范直接解包：OFD 是一个 zip，内部是 XML：
 *
 *   OFD.xml                     根：<DocRoot> 指向正文入口
 *   Doc_0/Document.xml          文档：<Pages><Page BaseLoc="..."/> 逐页
 *   Doc_0/Pages/Page_0/Content.xml   页面内容：<TextObject><TextCode X Y>文字</TextCode>
 *   Doc_0/PublicRes.xml 等      公共资源（字体/图片），取文本用不到
 *
 * 取文本的规则很朴素：**把每个 TextCode 的内容按坐标排序，再拼起来**。
 * 难点全在细节上，也在细节上做了取舍（都是刻意的）：
 *
 *  - **按 Y 聚类成行，行内按 X 排序**。版式文档没有「段落」概念，
 *    只有一堆带坐标的文本块；不排序会读出一份词序错乱的公文。
 *  - **行内片段用 smartJoin 拼接**（见 text.ts）：中文片段之间不补空格，
 *    西方文字之间补 —— 否则「中华人民共和国」会被读成「中华 人民 共和国」。
 *  - **忽略 CTM 变换矩阵**。规范允许 TextObject 带变换矩阵，正确做法是做矩阵乘法；
 *    但实测绝大多数生成器不写它，而为一个罕见形态引入矩阵运算会拖慢主路径。
 *    取舍是：**只在同一页内排序**，即使有个别对象的坐标被变换过，页与页的顺序仍然正确。
 *    这个限制写进 DEVLOG 遗留，不当成已完成。
 *  - **印章 / 注释 / 签名不解析**。它们是图形或独立结构，不属于「文档内容」。
 *  - 支持**非 zip 的单文件 OFD**（裸 XML）：有些轻量生成器直接输出 XML。
 */

import { OFFICE_TEXT_LIMIT } from '@deepwork/protocol';
import { attrOf, numberAttr, openTagsOf, stripTags, textsOf, unescapeXml } from './xml';
import { smartJoin } from './text';
import { zipRead } from './zip';

/** 同一个 Y 坐标的容差（OFD 坐标单位是毫米级，一行内的高度差远小于 2.5） */
const LINE_TOLERANCE = 2.5;

export interface OfdPage {
  /** 1 起的页码 */
  index: number;
  lines: string[];
  /** 该页取到的文本块数 */
  blocks: number;
}

export interface ExtractOfdOutput {
  pages: OfdPage[];
  /** 带页码分隔的全文 */
  text: string;
  blocks: number;
}

interface Fragment {
  x: number;
  y: number;
  order: number;
  text: string;
}

/** TextCode 是**成对**标签，但要同时读它的 X / Y 属性与内部文本 */
function textCodeFragments(contentXml: string): Fragment[] {
  // 批注（<ofd:Annot>）先整块摘掉：它是页边注记，不属于正文。
  // 不摘的话，批注文字会按坐标混进正文行里，读出来是一份「正文里夹着批注」
  // 的怪文档 —— 对「把公文内容读出来」这个目的，那是污染而不是信息。
  const body = contentXml.replace(
    /<(?:[A-Za-z0-9_.-]+:)?Annot(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?Annot\s*>/g,
    '',
  );
  const pattern = /<(?:[A-Za-z0-9_.-]+:)?TextCode(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?TextCode\s*>/g;
  const out: Fragment[] = [];
  let order = 0;
  for (const match of body.matchAll(pattern)) {
    const block = match[0];
    const head = block.slice(0, block.indexOf('>') + 1);
    // 内部还可能嵌 CGTransform（字形变换），对「读出内容」没有意义，剥掉
    const text = unescapeXml(stripTags(match[1])).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({
      x: numberAttr(head, 'X') ?? 0,
      y: numberAttr(head, 'Y') ?? 0,
      order: order++,
      text,
    });
  }
  return out;
}

/** 把一页的片段按坐标还原成若干行 */
function fragmentsToLines(fragments: Fragment[]): string[] {
  if (!fragments.length) return [];

  // ① 先按阅读顺序排：先 Y（自上而下）后 X（自左向右）；坐标相同时保持原始顺序
  const sorted = [...fragments].sort((a, b) => a.y - b.y || a.x - b.x || a.order - b.order);

  const lines: Fragment[][] = [];
  let current: Fragment[] = [];
  let anchorY = Number.NaN;

  for (const fragment of sorted) {
    if (current.length === 0 || Math.abs(fragment.y - anchorY) <= LINE_TOLERANCE) {
      if (current.length === 0) anchorY = fragment.y;
      current.push(fragment);
      continue;
    }
    lines.push(current);
    current = [fragment];
    anchorY = fragment.y;
  }
  if (current.length) lines.push(current);

  // ② 行内再按 X 排一次，然后拼接
  return lines.map((line) =>
    [...line]
      .sort((a, b) => a.x - b.x || a.order - b.order)
      .reduce((acc, fragment) => smartJoin(acc, fragment.text), ''),
  );
}

/** 解析 zip 形式的 OFD：返回每页的 Content.xml 路径（保证按页码顺序） */
function locatePages(entries: Map<string, Buffer>): { documentPath: string; pagePaths: string[] } {
  const names = [...entries.keys()];

  const rootName =
    names.find((name) => name.toLowerCase() === 'ofd.xml') ??
    names.find((name) => /(^|\/)ofd\.xml$/i.test(name));

  let documentPath = '';
  if (rootName) {
    const rootXml = entries.get(rootName)!.toString('utf8');
    // 规范里 DocRoot 指向正文入口；它可能带 ./ 前缀，也可能用反斜杠
    const declared = textsOf(rootXml, 'DocRoot')[0]?.trim();
    if (declared) documentPath = declared.replace(/\\/g, '/').replace(/^\.\//, '');
  }
  if (!documentPath) {
    // 连入口都找不到：直接按包内 Content.xml 兜底，兜不到才报错。
    // （这段兜底早先写在「Document.xml 存在但没声明页」之后，那条路要求先有入口，
    //   于是它永远走不到 —— 一个只会在真实坏包上才暴露的死代码。）
    const fallback = names
      .filter((name) => /(^|\/)content\.xml$/i.test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (!fallback.length) {
      throw new Error('这个 OFD 里既没有正文入口（OFD.xml / Document.xml），也没有任何 Content.xml');
    }
    return { documentPath: '(按 Content.xml 兜底)', pagePaths: fallback };
  }
  if (!entries.has(documentPath)) {
    const candidates = names.filter((name) => /(^|\/)document\.xml$/i.test(name));
    documentPath = candidates.sort((a, b) => a.localeCompare(b, 'en'))[0] ?? documentPath;
  }
  if (!entries.has(documentPath)) throw new Error(`OFD 声明的正文入口 ${documentPath} 不在包内`);

  const documentXml = entries.get(documentPath)!.toString('utf8');
  const dir = documentPath.includes('/') ? documentPath.slice(0, documentPath.lastIndexOf('/')) : '';

  // 页顺序 = Document.xml 里 <Page> 的出现顺序。用 openTagsOf 而不是 blocksOf：
  // <Page BaseLoc="..."/> 常常是自闭合的。
  const declared = openTagsOf(documentXml, 'Page')
    .map((tag) => attrOf(tag, 'BaseLoc'))
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      const relative = value.replace(/\\/g, '/').replace(/^\.\//, '');
      return dir ? `${dir}/${relative}` : relative;
    })
    .filter((path) => entries.has(path));

  if (declared.length) return { documentPath, pagePaths: declared };

  // 兜底：Document.xml 没声明页（或路径对不上）时按包内 Content.xml 的路径自然序
  const fallback = names
    .filter((name) => /(^|\/)content\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!fallback.length) throw new Error('这个 OFD 里没有页面内容（找不到任何 Content.xml）');
  return { documentPath, pagePaths: fallback };
}

/**
 * 解出 OFD 的文本。
 *
 * `bytes` 既可以是 zip 包，也可以是裸 XML（单文件 OFD）。
 */
export function extractOfdText(bytes: Buffer): ExtractOfdOutput {
  const isZip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;

  let pageContents: { path: string; xml: string }[];

  if (isZip) {
    const entries = zipRead(bytes);
    const { pagePaths } = locatePages(entries);
    pageContents = pagePaths.map((path) => ({ path, xml: entries.get(path)!.toString('utf8') }));
  } else {
    // 非 zip：整份当一页处理。这类文件不符合「OFD 是 zip 包」的规范形态，
    // 但真实存在（轻量生成器），读得出内容总比直接拒绝有用。
    const xml = bytes.toString('utf8');
    if (!/<[\s\S]*TextCode/i.test(xml)) {
      throw new Error('不是 zip 包，也不含 TextCode 元素（可能不是 OFD 文档）');
    }
    pageContents = [{ path: '(embedded)', xml }];
  }

  const pages: OfdPage[] = [];
  let blocks = 0;

  pageContents.forEach((page, index) => {
    const fragments = textCodeFragments(page.xml);
    const lines = fragmentsToLines(fragments);
    blocks += fragments.length;
    pages.push({ index: index + 1, lines, blocks: fragments.length });
  });

  if (blocks === 0) {
    // 明确区分「文档没有文字」与「我们没解析出来」——
    // 扫描件 / 纯图片版式确实是 0 个文本块，那不是 bug，但不能报成成功
    throw new Error(
      '这个 OFD 里没有可提取的文字（可能是扫描件、纯图形版式，或正文在注释/印章里）',
    );
  }

  const text = pages
    .map((page) => {
      const body = page.lines.join('\n').trim();
      if (pages.length === 1) return body;
      return `〔第 ${page.index} 页〕\n${body}`;
    })
    .join('\n\n');

  return {
    pages,
    text: text.length > OFFICE_TEXT_LIMIT ? text.slice(0, OFFICE_TEXT_LIMIT) : text,
    blocks,
  };
}

/**
 * 摘要（供工具回执使用）。
 *
 * 与 `extractOfdText` 分开，是为了让回执不必依赖全文 ——
 * 页数、块数、首行这些信息在调用方只想报进度时更实用。
 */
export function summarizeOfd(result: ExtractOfdOutput): string {
  const firstLine = result.pages.find((page) => page.lines.length)?.lines[0]?.slice(0, 40) ?? '';
  const size = result.text.length > OFFICE_TEXT_LIMIT;
  return (
    `${result.pages.length} 页 / ${result.blocks} 个文本块 / ${result.text.length} 字符` +
    `${size ? `（已截断到 ${OFFICE_TEXT_LIMIT}）` : ''}${firstLine ? ` / 首行：${firstLine}` : ''}`
  );
}
