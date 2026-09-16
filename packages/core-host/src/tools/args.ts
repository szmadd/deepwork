/**
 * 工具入参的小工具集 —— `fs.*` / `office.*` / `chart.render` 共用一份。
 *
 * 为什么必须共用：这些校验的**错误措辞**就是模型的重试依据。
 * 「缺少必需参数: path」这句话如果在一个工具里是 `缺少必需参数: path`、
 * 在另一个工具里是 `path 不能为空`，模型面对第二种时不知道该不该改字段名。
 * 同一个概念只有一份措辞，是「报错要可行动」这条纪律的一半。
 *
 * 另一半是形状：`office.xlsx` 与 `chart.render` 接受**同一种** rows
 * （二维数组或 Markdown 管道表格），一旦两处各有一份解析，就会出现
 * 「同一段文本在一个工具里能解析、在另一个里报解析失败」的分裂行为。
 */

import path from 'node:path';
import { rowsFromMarkdownTable, type CellValue } from '../office/xlsx';

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`缺少必需参数: ${key}`);
  }
  return value;
}

/** 单元格取值：对象/数组用 JSON 落地，总比丢掉内容好 */
export function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function normalizeRows(input: unknown): CellValue[][] {
  if (typeof input === 'string') {
    const parsed = rowsFromMarkdownTable(input);
    if (parsed.length === 0) {
      // 「传了一段文字但解析不出表格」与「传了个对象」是两种错误，得分别说 ——
      // 笼统报一句「rows 不合法」，模型不知道是该改格式还是该补内容
      throw new Error(
        'rows 是一段解析不出表格的文本（Markdown 管道表格至少要有一行含「|」的表头），也可以直接传二维数组',
      );
    }
    return parsed;
  }
  if (!Array.isArray(input)) {
    throw new Error('rows 需要是二维数组（数组的数组），或一段 Markdown 管道表格');
  }
  return input.map((row) => (Array.isArray(row) ? row.map(toCellValue) : [toCellValue(row)]));
}

/**
 * 扩展名对齐。
 *
 * 无扩展名 → 补上（模型常写 `报告` 而不是 `报告.docx`，补全符合意图）；
 * 但**给了别的扩展名就报错**（`office.docx` 写 `报告.txt` 会得到一个
 * 「名字说它是文本、内容其实是 Word 包」的文件，那是最糟糕的产物）。
 */
export function ensureExtension(abs: string, tool: string, expected: string): string {
  const ext = path.extname(abs);
  if (!ext) return `${abs}${expected}`;
  if (ext.toLowerCase() === expected) return abs;
  throw new Error(
    `${tool} 的 path 必须以 ${expected} 结尾（收到的是「${ext}」）—— 名字与内容不符的文件会误导之后所有读它的人`,
  );
}
