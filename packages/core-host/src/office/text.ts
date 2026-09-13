/**
 * 文本拼接规则（docx 生成与 OFD 解析共用）。
 *
 * 为什么值得单独一个文件：**中文文档里的换行不是空格。**
 *
 * 版式文档（OFD）会把同一行的文字切成很多片段（按字距、按字体切换），
 * 我们按坐标把它们还原成一行时必须决定「片段之间插不插空格」。
 * 英文习惯是插空格，中文插了就是错的 —— 「中华人民共和国」被拼成
 * 「中华 人民 共和国」正是这个原因。反过来，把英文单词直接粘起来
 * 会得到 `Hellofromthe` 这样的词。
 *
 * 判据因此是**按字符类型**判断，而不是按「有没有换行」判断。
 */

/** 是否为需要「不插空格」的东亚字符（CJK 汉字、假名、全角标点） */
export function isCJK(char: string): boolean {
  if (!char) return false;
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // 部首扩展 ~ CJK 统一表意文字
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意文字
    (code >= 0xfe30 && code <= 0xfe4f) || // 兼容形式（竖排标点）
    (code >= 0xff00 && code <= 0xffef) || // 全角字符
    (code >= 0x3000 && code <= 0x303f) // CJK 标点（、。「」等）
  );
}

/**
 * 拼接两个文本片段。
 *
 * 只有「两侧都不是东亚字符」时才补一个空格：`src` + `main.ts` → `src main.ts`
 * 看起来多一个空格，但那是英文的正确读法；而 `中华` + `人民` → `中华人民共和国`
 * 绝不能变成带空格的形态。
 */
export function smartJoin(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const left = a[a.length - 1];
  const right = b[0];
  if (isCJK(left) || isCJK(right)) return a + b;
  if (/\s/.test(left) || /\s/.test(right)) return a + b;
  return `${a} ${b}`;
}

/** 把「多个片段」按同一规则串起来 */
export function smartConcat(parts: string[]): string {
  return parts.reduce((acc, part) => smartJoin(acc, part), '');
}

/** 压缩连续空白（保留换行）；用于从版式文档里取出的文本做规整 */
export function collapseSpaces(value: string): string {
  return value.replace(/[^\S\n]+/g, ' ').trim();
}
