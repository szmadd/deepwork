/**
 * 最小 zip 解包器（无第三方依赖）。
 *
 * ── 为什么不引依赖 ─────────────────────────────────────────────────
 * 本项目已经有过一次同类选择（运行时补丁的 YAML 发射器手写而不引 js-yaml），
 * 理由在这里同样成立：只需要读一种受控子集（zip 的 STORE 与 DEFLATE 两种
 * 压缩方式、无加密、无 zip64），而压缩/解压的算法本身由 Node 内置的
 * `zlib.inflateRawSync` 提供 —— 我们写的只是**容器格式的解析**，
 * 大约一百行，且可以逐条审计。引一个包则要多维护一份依赖，
 * 而 zip 库恰恰是历史上出过路径穿越与 zip bomb 问题的地方。
 *
 * ── 这里做的安全约束（每一条都对应一种真实的攻击）───────────────
 *  1. **路径穿越**：条目名里带 `..` 或绝对路径，解包时会写到目标目录之外。
 *     一律拒绝（不是清洗 —— 一个名字非法的条目说明这个包本身不可信）。
 *  2. **符号链接**：zip 可以声明一个指向任意位置的软链，后续条目再往它写，
 *     就绕过了上面的路径检查。发现软链直接拒绝整个包。
 *  3. **zip bomb**：压缩率可以极高（几十 KB 解出几十 GB）。条目数、
 *     单条目解压大小、总解压大小都有硬上限，且是**先看声明大小再解**。
 *  4. **zip64**：大文件用的扩展格式，解析逻辑完全不同。遇到就明确报错，
 *     不尝试用 32 位逻辑去读它 —— 那会得到错误的偏移，写出损坏的文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

export interface ZipExtractResult {
  files: number;
  bytes: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

export function extractZip(buffer: Buffer, destDir: string, limits: ZipLimits = ZIP_LIMITS): ZipExtractResult {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录结尾记录）');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralOffset === ZIP64_MARKER) {
    throw new Error('这个 zip 用了 zip64 扩展格式（超过 4GB 或条目数超过 65535），暂不支持');
  }
  if (entryCount > limits.maxEntries) {
    throw new Error(`zip 条目数 ${entryCount} 超过上限 ${limits.maxEntries}`);
  }

  fs.mkdirSync(destDir, { recursive: true });
  let files = 0;
  let totalBytes = 0;
  let offset = centralOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new Error(`zip 中央目录第 ${i + 1} 条记录损坏`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

    // 软链：unix 模式下 (externalAttrs >> 16) 的高 4 位是文件类型，0xA 即软链
    const unixMode = externalAttrs >>> 16;
    if (unixMode !== 0 && (unixMode & 0xf000) === 0xa000) {
      throw new Error(`zip 里有符号链接条目（${name}），出于安全考虑拒绝整个包`);
    }

    if (!name.endsWith('/')) {
      if (uncompressedSize > limits.maxEntryBytes) {
        throw new Error(`zip 里的 ${name} 解压后 ${uncompressedSize} 字节，超过单文件上限 ${limits.maxEntryBytes}`);
      }
      totalBytes += uncompressedSize;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(`zip 解压总量超过上限 ${limits.maxTotalBytes} 字节`);
      }
      writeEntry(buffer, destDir, { name, method, compressedSize, localOffset });
      files += 1;
    } else {
      // 目录条目：显式建目录（有些包不为目录单独发条目，那种情况由 writeEntry 里的
      // mkdirSync 兜住）。顶层目录的判断不在这里做 —— 解包完成后扫一遍盘更可靠，
      // 也把「条目顺序任意」这件事交给文件系统而不是收集顺序。
      fs.mkdirSync(safeJoin(destDir, name.replace(/\/+$/, '')), { recursive: true });
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return { files, bytes: totalBytes };
}

function writeEntry(
  buffer: Buffer,
  destDir: string,
  entry: { name: string; method: number; compressedSize: number; localOffset: number },
): void {
  const { name, method, compressedSize, localOffset } = entry;
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new Error(`zip 里的 ${name} 本地头损坏`);
  }
  // 本地头的名称/扩展区长度可能与中央目录不同（这是允许的），必须重读
  const nameLen = buffer.readUInt16LE(localOffset + 26);
  const extraLen = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  if (dataStart + compressedSize > buffer.length) {
    throw new Error(`zip 里的 ${name} 数据区越界（文件被截断？）`);
  }
  const raw = buffer.subarray(dataStart, dataStart + compressedSize);

  let content: Buffer;
  if (method === 0) content = Buffer.from(raw);
  else if (method === 8) content = zlib.inflateRawSync(raw);
  else throw new Error(`zip 里的 ${name} 用了不支持的压缩方式 ${method}（只支持 store 与 deflate）`);

  const target = safeJoin(destDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** 找中央目录结尾记录：从尾部往前扫（注释区最长 65535 字节） */
function findEocd(buffer: Buffer): number {
  if (buffer.length < 22) return -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 条目名 → 目标绝对路径，穿过任何不合法的名字就抛错。
 *
 * 不做「清洗」（把 `..` 换成 `_` 之类）：一个名字非法的条目说明这个包
 * 本身不可信，清洗后照常解包等于把「有人构造了这种包」这件事咽下去。
 */
function safeJoin(destDir: string, name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) throw new Error(`zip 里有绝对路径条目：${name}`);
  if (/^[a-zA-Z]:/.test(normalized)) throw new Error(`zip 里有带盘符的条目：${name}`);
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error(`zip 里有向上越界的条目：${name}`);
  if (parts.length === 0) throw new Error(`zip 里有空条目名`);
  const target = path.resolve(destDir, ...parts);
  const base = path.resolve(destDir);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`zip 条目解析后落在目标目录之外：${name}`);
  }
  return target;
}
