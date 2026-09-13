/**
 * 子进程输出的字符解码。
 *
 * ── 为什么必须自己解 ──
 *
 * Windows 中文环境下，同一条管道里会**混着两种编码**：
 *  - cmd 的内建命令与错误信息（`echo`、`dir`、"'xxx' 不是内部或外部命令"）按 OEM 代码页输出（简体中文下是 GBK）；
 *  - node / python / git 等现代程序自己按 UTF-8 写管道。
 *
 * 强行指定任何一种都会让另一半变乱码。所以这里用「先按 UTF-8 流式解，出现替换字符就退回 GBK」的启发式：
 * GBK 的双字节序列极少能构成合法 UTF-8（首字节 0x81–0xFE 后面通常接不上合法的续字节），
 * 而真正的 UTF-8 文本不会凭空出现 U+FFFD，因此这个判据在实践中相当稳。
 *
 * 它是启发式，不是定理 —— 所以留了 DEEPWORK_TERMINAL_ENCODING 显式覆盖的口子。
 * 把这种「已知不完美」写清楚，好过让它以偶发乱码的形式被当成玄学问题。
 */

import { TextDecoder } from 'node:util';

export type DecodeMode = 'auto' | 'utf8' | 'gbk';

function resolveMode(): DecodeMode {
  const raw = (process.env.DEEPWORK_TERMINAL_ENCODING ?? 'auto').toLowerCase();
  if (raw === 'utf8' || raw === 'utf-8') return 'utf8';
  if (raw === 'gbk' || raw === 'cp936') return 'gbk';
  return 'auto';
}

export class OutputDecoder {
  private mode = resolveMode();
  private utf8 = new TextDecoder('utf-8');
  private gbk: TextDecoder | null = null;
  /** 最近一次实际采用的编码，界面据此提示「本机终端编码」 */
  lastUsed: 'utf-8' | 'gbk' = 'utf-8';

  constructor() {
    if (this.mode !== 'utf8') {
      try {
        this.gbk = new TextDecoder('gbk');
      } catch {
        // 运行时未带完整 ICU，退化为 UTF-8 —— 不假装支持
        this.gbk = null;
        if (this.mode === 'gbk') this.mode = 'utf8';
      }
    }
  }

  decode(chunk: Buffer): string {
    if (this.mode === 'utf8' || this.gbk === null) {
      this.lastUsed = 'utf-8';
      return this.utf8.decode(chunk, { stream: true });
    }
    if (this.mode === 'gbk') {
      this.lastUsed = 'gbk';
      return this.gbk.decode(chunk, { stream: true });
    }

    const asUtf8 = this.utf8.decode(chunk, { stream: true });
    if (!asUtf8.includes('\uFFFD')) {
      this.lastUsed = 'utf-8';
      return asUtf8;
    }
    // 退回 GBK，并重置 UTF-8 解码器的流式状态：它已被一段非法序列污染，
    // 留着会让下一段合法 UTF-8 被当作续接而错位。
    this.utf8 = new TextDecoder('utf-8');
    this.lastUsed = 'gbk';
    return this.gbk.decode(chunk, { stream: true });
  }

  /** 冲刷流式解码器里可能残留的半个多字节序列 */
  flush(): string {
    const tail = this.lastUsed === 'gbk' && this.gbk ? this.gbk.decode() : this.utf8.decode();
    return tail.includes('\uFFFD') ? '' : tail;
  }
}
