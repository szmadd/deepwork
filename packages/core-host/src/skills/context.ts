/**
 * 技能上下文构建：把「已安装且启用」的技能变成本轮运行的注入文本。
 *
 * ── 两种挂载方式 ────────────────────────────────────────────────────
 *  1. 环境注入：每轮把全部启用技能的摘要（名称/版本/描述/触发提示/SKILL.md
 *     绝对路径）带给内核。摘要不含正文 —— 正文可能几千字，全量带上会让
 *     每轮对话都背着所有技能的全文跑。语义匹配是内核侧职责：它判断任务与
 *     哪个技能相关后，自己去读那份 SKILL.md（路径已在摘要里给出）。
 *  2. 显式调用：用户输入以 `/技能名` 开头（如 `/workspace-check 看一下`），
 *     该技能的 SKILL.md 正文全文随本轮注入，并受 SKILL_BODY_LIMIT 截断。
 *
 * ── 体积纪律 ────────────────────────────────────────────────────────
 * 技能是别人写的文本，长度不可信。单个正文限 SKILL_BODY_LIMIT，整段上下文限
 * SKILL_CONTEXT_LIMIT；超限如实截断并在 attached 记录里标 truncated，
 * 而不是静默丢弃 —— 「注入了但少了一截」必须能被看见。
 *
 * 解析失败的已安装技能（例如手改坏了 SKILL.md）不阻断对话：跳过并在
 * skipped 里留名，由宿主决定是否提示。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SkillAttachment, SkillRecord } from '@deepwork/protocol';
import { parseSkillMd } from './manifest';
import type { SkillStore } from './store';

/** 单个显式调用技能的正文上限（字符） */
export const SKILL_BODY_LIMIT = 16_000;
/** 整段技能上下文的上限（字符） */
export const SKILL_CONTEXT_LIMIT = 48_000;

export interface SkillContextResult {
  /** 注入文本；没有任何启用技能时为 null */
  prompt: string | null;
  /** 实际挂载的技能（含摘要注入的） */
  attached: SkillAttachment[];
  /** 已启用但 SKILL.md 读取/解析失败而被跳过的技能名 */
  skipped: string[];
}

interface ResolvedSkill {
  record: SkillRecord;
  skillMdPath: string;
  body: string | null;
}

const EXPLICIT_RE = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)/;

export function buildSkillContext(store: SkillStore, userText: string): SkillContextResult {
  const explicitName = EXPLICIT_RE.exec(userText.trim())?.[1] ?? null;

  const resolved: ResolvedSkill[] = [];
  const skipped: string[] = [];
  for (const record of store.list()) {
    if (!record.enabled) continue;
    const skillMdPath = path.join(store.skillsDir(), record.manifest.name, 'SKILL.md');
    let body: string | null = null;
    try {
      body = parseSkillMd(fs.readFileSync(skillMdPath, 'utf8')).body.trim();
    } catch {
      // 已安装技能读不出来不该让对话发不出去；记名跳过，摘要把路径照样给出
      skipped.push(record.manifest.name);
    }
    resolved.push({ record, skillMdPath, body });
  }

  if (resolved.length === 0) return { prompt: null, attached: [], skipped };

  const attached: SkillAttachment[] = [];
  const sections: string[] = [
    '[技能上下文 —— 由 DeepWork 宿主注入]',
    '以下技能已在用户机器上启用。当你的任务与某个技能的描述或触发场景匹配时，先读取其 SKILL.md 全文再按其指引执行。',
  ];

  for (const { record, skillMdPath } of resolved) {
    const { name, version, description, triggers } = record.manifest;
    const triggerLine = triggers && triggers.length > 0 ? `\n  触发场景：${triggers.join('；')}` : '';
    sections.push(`- ${name} (v${version})：${description || '（无描述）'}${triggerLine}\n  全文路径：${skillMdPath}`);
  }

  const explicitSkill = explicitName
    ? resolved.find((item) => item.record.manifest.name === explicitName)
    : undefined;

  for (const { record, body } of resolved) {
    const isExplicit = explicitSkill?.record.manifest.name === record.manifest.name;
    let bodyChars = 0;
    let truncated = false;
    if (isExplicit) {
      const raw = body ?? '';
      truncated = raw.length > SKILL_BODY_LIMIT;
      const shown = truncated ? raw.slice(0, SKILL_BODY_LIMIT) : raw;
      bodyChars = shown.length;
      sections.push(
        '',
        `[显式调用的技能全文：${record.manifest.name}${truncated ? `（已截断至 ${SKILL_BODY_LIMIT} 字符）` : ''}]`,
        shown || '（SKILL.md 正文读取失败，仅有摘要可用）',
        `[/${record.manifest.name}]`,
      );
    }
    attached.push({
      name: record.manifest.name,
      version: record.manifest.version,
      explicit: isExplicit,
      bodyChars,
      truncated,
    });
  }

  if (explicitName && !explicitSkill) {
    // 用户敲了 /名字但没匹配到已启用技能：如实告知，而不是静默当普通文本
    sections.push('', `[注意] 用户尝试显式调用「/${explicitName}」，但该技能未安装或已停用，请按普通输入处理并告知用户。`);
  }

  let prompt = sections.join('\n');
  if (prompt.length > SKILL_CONTEXT_LIMIT) {
    prompt = `${prompt.slice(0, SKILL_CONTEXT_LIMIT)}\n[技能上下文超出总量上限，已截断]`;
  }

  return { prompt, attached, skipped };
}
