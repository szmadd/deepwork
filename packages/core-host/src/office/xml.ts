/**
 * XML 小工具：转义、反解、以及**容错抽取**。
 *
 * 为什么不用一个正经 XML 解析器：写侧只需要拼字符串（生成器就够），
 * 读侧面对的是**别人产出的** OOXML / OFD —— 命名空间前缀、属性顺序、
 * 自闭合写法全都可能不同。一个宽容的抽取器在这里比一个严格解析器更有用：
 * 严格解析器遇到一个不知道的命名空间就整份报错，而用户只是想把公文里的字读出来。
 *
 * 代价要讲清楚：这里**不做** XML 校验（不验 DTD、不验结构合法性），
 * 所以它只用于「取文本」，不用于「判定文件是否符合规范」——
 * 后者的判据是真实办公软件能否打开（见 tools/office-test.js 的独立校验段）。
 */

/** 生成 XML 时对文本/属性的转义（五个预定义实体，够用且不引入 DTD 依赖） */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/**
 * 反解实体。
 *
 * 数字实体（`&#12289;` / `&#x3001;`）必须支持：中文 OOXML 里标点常被写成数字实体，
 * 漏了它们，读出来就是一串 `&#12289;` 而不是「、」。
 */
export function unescapeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** 去掉所有标签，只留文本（标签之间不做空白处理，交由调用方决定） */
export function stripTags(xml: string): string {
  return xml.replace(/<[^>]*>/g, '');
}

/** 标签名允许任意命名空间前缀（ofd: / w: / 无前缀都能匹配） */
function tagPattern(localName: string): RegExp {
  return new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}\\s*>`, 'g');
}

/**
 * 抽取某个局部名元素的**内部文本**（多段）。
 *
 * 内部若还有子元素（OFD 的 TextCode 里可能嵌 CGTransform）会被剥掉，
 * 因为我们只要可见文本，字形变换参数对「读出内容」没有意义。
 */
export function textsOf(xml: string, localName: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(tagPattern(localName))) {
    out.push(unescapeXml(stripTags(match[1])));
  }
  return out;
}

/** 抽取某个局部名元素的**完整块**（含标签本身），用于需要读属性的场景 */
export function blocksOf(xml: string, localName: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(tagPattern(localName))) out.push(match[0]);
  return out;
}

/**
 * 抽取**开始标签**（含自闭合写法 `<x A="1"/>`）。
 *
 * 与 blocksOf 的分工：OFD 里的 `<Page BaseLoc="..."/>` 常常是自闭合的，
 * 只找「成对标签」会一个都匹配不到 —— 症状是「页数报 0、文本全空」，
 * 而文件其实是好的。需要读属性时用这个，需要读内容时用 blocksOf。
 */
export function openTagsOf(xml: string, localName: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}(?:\\s[^>]*)?/?>`, 'g');
  for (const match of xml.matchAll(pattern)) out.push(match[0]);
  return out;
}

/**
 * 读一个开始标签上的属性值。
 *
 * `tag` 传完整块（如 `<ofd:TextCode X="10" Y="20">`）：只在第一个 `>` 之前找，
 * 否则内容里恰好出现 `X="` 这种字样时会被误读成属性。
 */
export function attrOf(tag: string, name: string): string | null {
  const head = tag.slice(0, Math.max(tag.indexOf('>'), 0) + 1);
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const match = pattern.exec(head);
  if (!match) return null;
  return unescapeXml(match[2] ?? match[3] ?? '');
}

/** 数字属性（OFD 的坐标 X / Y 都是十进制小数） */
export function numberAttr(tag: string, name: string): number | null {
  const raw = attrOf(tag, name);
  if (raw === null) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}
