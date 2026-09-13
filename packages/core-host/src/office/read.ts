/**
 * 文档读取派发：按扩展名选解析器，把结果规整成「文本 + 规模信息」。
 *
 * 三种原生解析器（ofd / docx / xlsx）都是**宽容**的：外部文件千奇百怪，
 * 「读不出全部」远好于「整份拒绝」。但宽容只针对**格式细节**，
 * 不针对事实：解析不出文字时必须明确报错，不能返回空串让模型以为文档是空的。
 *
 * 另有一条与生成侧对称的职责：`textViewOfBytes` 把二进制文档转成**文本视图**，
 * 供审批弹窗做差异展示（见 builtin.ts 的说明：让用户在批准一份二进制写入之前
 * 真的看到内容，而不是只看到「二进制文件」四个字）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  OFFICE_MAX_BYTES,
  OFFICE_TEXT_LIMIT,
  officeDocKindOf,
  officeNativeExtensionList,
  type OfficeDocKind,
  type OfficeNativeKind,
  type OfficeReadResult,
} from '@deepwork/protocol';
import { extractDocxText } from './docx';
import { extractOfdText, summarizeOfd } from './ofd';
import { extractXlsxText } from './xlsx';

export interface OfficeReadOutcome extends OfficeReadResult {
  /** 一句话摘要（回执用）：类型 / 页数 / 块数 / 字符数 */
  summary: string;
}

/** 人类可读的体积 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 二进制判定。
 *
 * 与工作区预览用的判据保持一致（出现 NUL 字节即视为二进制）：
 * 两处不一致会导致「预览说这是二进制、工具却把乱码喂给模型」这种分裂行为。
 */
function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8000);
  return probe.includes(0);
}

function kindOfPath(abs: string): { kind: OfficeDocKind; ext: string } {
  const ext = path.extname(abs);
  const kind = officeDocKindOf(ext);
  if (!kind) {
    throw new Error(
      `不支持的文档类型「${ext || '(无扩展名)'}」。原生解析支持 ${officeNativeExtensionList()}；` +
        '纯文本可按扩展名读取（.txt/.md/.csv/.tsv/.json/.log/.xml/.yaml/.yml）',
    );
  }
  return { kind, ext: ext.toLowerCase() };
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= OFFICE_TEXT_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, OFFICE_TEXT_LIMIT), truncated: true };
}

/**
 * 二进制文档 → 文本视图。
 *
 * 失败时返回原因而不是抛异常：预览层拿不到视图只该降级成「看不到内容」，
 * 不该让整个工具调用失败 —— 生成新文档时旧文件根本不存在，那是正常路径。
 */
export function textViewOfBytes(
  bytes: Buffer,
  kind: OfficeNativeKind,
): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    if (kind === 'ofd') return { ok: true, text: extractOfdText(bytes).text };
    if (kind === 'docx') return { ok: true, text: extractDocxText(bytes).text };
    return { ok: true, text: extractXlsxText(bytes).text };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 读取并解析工作区里的一个文档 */
export async function readOfficeDocument(abs: string, rel: string): Promise<OfficeReadOutcome> {
  const { kind } = kindOfPath(abs);

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`${rel} 不存在`);
    throw new Error(`无法访问 ${rel}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isDirectory()) throw new Error(`${rel} 是目录，不是文档`);
  if (stat.size > OFFICE_MAX_BYTES) {
    throw new Error(`${rel} 体积 ${formatBytes(stat.size)}，超过解析上限 ${formatBytes(OFFICE_MAX_BYTES)}`);
  }

  const buffer = await fs.readFile(abs);

  if (kind === 'text') {
    if (looksBinary(buffer)) {
      throw new Error(`${rel} 看起来是二进制文件，不能按文本读取`);
    }
    const { text, truncated } = clip(buffer.toString('utf8'));
    return {
      path: rel,
      kind,
      text,
      truncated,
      blocks: text ? text.split('\n').length : 0,
      summary: `文本 / ${formatBytes(stat.size)} / ${text.split('\n').length} 行${truncated ? '（已截断）' : ''}`,
    };
  }

  if (kind === 'ofd') {
    const result = extractOfdText(buffer);
    const { text, truncated } = clip(result.text);
    return {
      path: rel,
      kind,
      text,
      truncated,
      pages: result.pages.length,
      blocks: result.blocks,
      summary: summarizeOfd(result),
    };
  }

  if (kind === 'docx') {
    const result = extractDocxText(buffer);
    const { text, truncated } = clip(result.text);
    return {
      path: rel,
      kind,
      text,
      truncated,
      pages: result.pages,
      blocks: result.blocks,
      summary:
        `Word 文档 / ${result.blocks} 段` +
        `${result.pages ? ` / ${result.pages} 处显式分页` : ''} / ${formatBytes(stat.size)}` +
        `${truncated ? '（已截断）' : ''}`,
    };
  }

  const result = extractXlsxText(buffer);
  const { text, truncated } = clip(result.text);
  return {
    path: rel,
    kind,
    text,
    truncated,
    blocks: result.blocks,
    summary:
      `Excel 工作簿 / 工作表 ${result.sheets.join('、') || '(未命名)'} / ${result.blocks} 个单元格 / ` +
      `${formatBytes(stat.size)}${truncated ? '（已截断）' : ''}`,
  };
}
