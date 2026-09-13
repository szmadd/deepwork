/**
 * 最小 ZIP 编解码（零第三方依赖，只用 node:zlib）。
 *
 * docx / xlsx / ofd 三种格式的本体都是 zip 包，所以这一层是它们共同的地基。
 * 不引 `yauzl` / `jszip` / `fflate` 的理由与浏览器侧同源（「装完就能跑」），
 * 这里还多一层：这三个格式要长期演进，包格式却二十年没变过，
 * 手写的 200 行比一个会换 API、会换维护者的依赖更稳。
 *
 * ── 写侧 ──────────────────────────────────────────────────────
 * 只做「本地文件头 + 中央目录 + EOCD」这一条最老实的路径：
 * 不用数据描述符（sizes 写在本地头里）、不写 extra 字段、不分包。
 * 条目名统一置 UTF-8 标志位（bit 11），即使当前全是 ASCII ——
 * 留着这个位，将来加中文文件名时不会因为「忘了设置」而变成乱码目录。
 *
 * ── 读侧 ──────────────────────────────────────────────────────
 * 从**中央目录**读元数据，不信任本地头里的 sizes：两者不一致时（有工具会写 0），
 * 按中央目录走才是能读到内容的那个选择。解压后**校验 CRC32 与长度**，
 * 校验不过就报错 —— 一个被截断的包如果被当成正常内容解析，
 * 症状会表现为「文档读出来少了半页」，那是排查成本最高的一类失败。
 *
 * 体积闸门在两侧都有：读侧限制条目数与单条目解压后大小（zip bomb），
 * 见契约层的 OFFICE_MAX_ENTRY_BYTES / OFFICE_MAX_ENTRIES。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { OFFICE_MAX_ENTRIES, OFFICE_MAX_ENTRY_BYTES } from '@deepwork/protocol';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** 标准 CRC32（zip 各条目用它校验） */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  /** 包内路径，统一用 / 分隔 */
  name: string;
  data: Buffer;
}

export interface ZipWriteOptions {
  /**
   * 是否对条目做 deflate。
   *
   * 默认开；关掉时全部走 store（体积大但可用普通解压工具直接看内容，
   * 排查「生成的文档结构对不对」时有用）。
   */
  compress?: boolean;
  /**
   * 写入 zip 头的时间戳。
   *
   * 存在的意义是**可复现**：同一份内容传同一个 Date 必须产出逐字节相同的包。
   * 测试据此断言「两次生成完全一致」，否则任何一份字节级比对都会被
   * 「这一次是 14:03:07 写的」这种无意义的差异打翻。
   */
  date?: Date;
}

/** DOS 时间/日期编码（zip 规范固定用这套，1980 年起算） */
function dosStamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 打包。
 *
 * 条目顺序原样保留 —— 调用方（docx/xlsx）会先放 `[Content_Types].xml`，
 * 那是 OOXML 约定俗成的第一位，某些严格的读取器会先找它。
 */
export function zipWrite(entries: ZipEntryInput[], options: ZipWriteOptions = {}): Buffer {
  const compress = options.compress !== false;
  const stamp = dosStamp(options.date ?? new Date());

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const crc = crc32(raw);

    let method = METHOD_STORE;
    let payload = raw;
    if (compress && raw.length > 0) {
      const deflated = deflateRawSync(raw, { level: 9 });
      // 压不小就存原文：对已压缩内容（如图片）走 deflate 只会白烧 CPU 并变大
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE;
        payload = deflated;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // 需要的版本：2.0（deflate 与目录结构）
    local.writeUInt16LE(0x0800, 6); // bit 11：条目名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // 生成程序版本
    central.writeUInt16LE(20, 6); // 需要的版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, payload);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // 本磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd]);
}

export interface ZipReadLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
}

/**
 * 解包。返回「包内路径 → 内容」的映射。
 *
 * 抛出的异常都写成可行动的一句话：这类包来自外部（用户上传的 OFD、别人发的 docx），
 * 「解析失败」四个字没法让人判断是文件坏了还是格式不支持。
 */
export function zipRead(buf: Buffer, limits: ZipReadLimits = {}): Map<string, Buffer> {
  const maxEntries = limits.maxEntries ?? OFFICE_MAX_ENTRIES;
  const maxEntryBytes = limits.maxEntryBytes ?? OFFICE_MAX_ENTRY_BYTES;

  if (buf.length < 22) throw new Error('文件太小，不是有效的 zip 包');
  if (buf.readUInt32LE(0) !== SIG_LOCAL && buf.readUInt32LE(0) !== SIG_CENTRAL) {
    // 有些 OFD 以「裸 XML」形式存在，交给调用方判断；这里只说清事实
    throw new Error('不是 zip 包（缺少 PK 头）');
  }

  // EOCD 在文件末尾，但可能有注释（最多 64KB），所以从后往前找签名
  let eocd = -1;
  const searchFrom = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= searchFrom; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('找不到 zip 的中央目录结尾记录（文件可能被截断）');

  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('这个 zip 使用了 ZIP64 扩展，当前版本不支持（单个包超过 4GB 或条目数超 65535）');
  }
  if (total > maxEntries) {
    throw new Error(`包内条目数 ${total} 超过上限 ${maxEntries}`);
  }
  if (cdOffset + cdSize > buf.length) throw new Error('中央目录越出文件末尾（文件可能被截断）');

  const out = new Map<string, Buffer>();
  let cursor = cdOffset;

  for (let i = 0; i < total; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error(`中央目录第 ${i + 1} 条记录损坏`);
    }
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const rawSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf
      .subarray(cursor + 46, cursor + 46 + nameLen)
      .toString('utf8')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (rawSize > maxEntryBytes) {
      throw new Error(`条目 ${name} 解压后 ${rawSize} 字节，超过单条目上限 ${maxEntryBytes}`);
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`条目 ${name} 的本地文件头损坏`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) throw new Error(`条目 ${name} 的数据越出文件末尾`);

    const payload = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === METHOD_STORE) {
      data = Buffer.from(payload);
    } else if (method === METHOD_DEFLATE) {
      data = inflateRawSync(payload);
    } else {
      throw new Error(`条目 ${name} 使用了不支持的压缩方法 ${method}（只支持 store 与 deflate）`);
    }

    if (data.length !== rawSize) {
      throw new Error(`条目 ${name} 解压后长度 ${data.length} 与包头声明的 ${rawSize} 不一致`);
    }
    const actual = crc32(data);
    if (actual !== crc) {
      throw new Error(`条目 ${name} 的 CRC32 校验失败（包已损坏或被修改）`);
    }

    out.set(name, data);
  }

  return out;
}

/** 从映射里取一个文本条目（UTF-8），不存在返回 null */
export function entryText(entries: Map<string, Buffer>, name: string): string | null {
  const buf = entries.get(name);
  return buf ? buf.toString('utf8') : null;
}

/**
 * 按「末尾片段」找条目。
 *
 * OFD 里活动目录名（`Doc_0/`）由生成方决定，规范允许它不是 `Doc_0`；
 * 而我们要找的是 `Document.xml` / `Pages/Page_0/Content.xml` 这类**结构位置**。
 * 用后缀匹配比硬编码路径稳，同时保留「按首次出现顺序」的确定性 ——
 * 顺序不确定会让同一份文档每次导出得到不同结果，那是不可复现的来源之一。
 */
export function entriesEndingWith(entries: Map<string, Buffer>, suffix: string): string[] {
  const hits: string[] = [];
  for (const name of entries.keys()) {
    if (name === suffix || name.endsWith(`/${suffix}`)) hits.push(name);
  }
  return hits.sort((a, b) => a.localeCompare(b, 'en'));
}
