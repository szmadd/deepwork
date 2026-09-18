/**
 * SKILL.md frontmatter 解析。
 *
 * 刻意不引 YAML 库：frontmatter 需要的只是 `key: value` 平铺与 `key:` 列表
 * 两种形式，一个 60 行的解析器足够；引完整 YAML 解析器反而把「frontmatter
 * 里能写什么」的边界变模糊（锚点、多文档……），而解析器的模糊边界就是
 * 恶意技能包的藏身处。解析不了的行直接报错，不给「宽容解析」留门。
 */

import type { SkillManifest } from '@deepwork/protocol';

export class SkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillManifestError';
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * semver 格式（契约层承诺的 version 形态）。
 *
 * 只校验「写法的合法性」，不做 semver 排序/范围比较 —— 升级判断仍是
 * 字符串相等性（同名不同 version = 升级）。这里拦截的是 `version: abc`
 * 这类笔误：它们能装进来，但会让「同版本已安装」判断与用户的版本预期
 * 全部失真。
 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * 解析 SKILL.md 全文：frontmatter（--- 围栏）+ 正文（返回给审计引擎）。
 * 抛 SkillManifestError 表示清单不合法（缺字段、名字含路径分隔符等）。
 */
export function parseSkillMd(raw: string): { manifest: SkillManifest; body: string } {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) {
    throw new SkillManifestError('SKILL.md 必须以 --- 开头的 frontmatter 围栏开始');
  }
  const lines = text.split(/\r?\n/);
  // 找闭合围栏（跳过第 0 行的开围栏）
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new SkillManifestError('frontmatter 围栏未闭合（缺第二个 ---）');

  const fields = new Map<string, string[]>();
  let currentKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // 列表项： "- value"
    if (/^\s*-\s+/.test(line)) {
      if (!currentKey) throw new SkillManifestError(`第 ${i + 1} 行：列表项出现在任何键之前`);
      const item = line.replace(/^\s*-\s+/, '').trim();
      fields.get(currentKey)!.push(stripQuotes(item));
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) throw new SkillManifestError(`第 ${i + 1} 行无法解析：${line.slice(0, 60)}`);
    const [, key, valueRaw] = m;
    const value = valueRaw.trim();
    currentKey = key;
    if (value) {
      fields.set(key, [stripQuotes(value)]);
    } else {
      // 空值：可能是列表前导，也可能是空字段
      fields.set(key, []);
    }
  }

  const name = (fields.get('name') ?? [])[0];
  const description = (fields.get('description') ?? [])[0] ?? '';
  const version = (fields.get('version') ?? [])[0];

  if (!name) throw new SkillManifestError('frontmatter 缺少 name');
  if (!NAME_RE.test(name)) {
    throw new SkillManifestError(`name "${name}" 不合法：仅允许小写字母/数字/连字符，且以字母或数字开头`);
  }
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new SkillManifestError(`name "${name}" 含路径分隔符，拒绝`);
  }
  if (!version) throw new SkillManifestError('frontmatter 缺少 version');
  if (!VERSION_RE.test(version)) {
    throw new SkillManifestError(
      `version "${version}" 不是合法的 semver（应为 x.y.z，可带 - prerelease 与 + build 后缀）`,
    );
  }

  return {
    manifest: {
      name,
      description,
      version,
      triggers: fields.get('triggers') ?? undefined,
      permissions: fields.get('permissions') ?? undefined,
    },
    body: lines.slice(end + 1).join('\n'),
  };
}

/** 去掉成对的引号（YAML 常见写法），不成对则原样返回 */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}
