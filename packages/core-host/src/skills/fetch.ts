/**
 * 技能来源的「落成本地目录」这一步（M2-C 遗留：技能市场 URL 安装源）。
 *
 * ── 为什么这一步必须存在，且必须在审计之前 ──────────────────────────
 * 安装流程的关键约束是**审计前置**：任何来源都要先变成磁盘上的一个目录，
 * 过完审计，才可能进技能目录。URL 来源的复杂度全部集中在「怎么变成本地目录」：
 * 下载、判断形态（整包还是单文件）、剥掉归档外壳，然后交给同一条安装路径。
 * 安装逻辑因此完全不必知道来源是 URL —— 它只认目录。
 *
 * ── 支持哪两种 URL ────────────────────────────────────────────────
 *  1. **zip 归档**（内网静态分发包、GitHub 的 `/archive/refs/heads/main.zip`）；
 *  2. **单个 SKILL.md** 的裸地址。
 *
 * 判断依据是**内容**（PK 头 / frontmatter）而不是 URL 后缀：带查询串的下载
 * 地址（`…/download?token=x`）没有后缀，而按后缀判断的实现会把它误判成单文件，
 * 然后拿一份 zip 的二进制去当 SKILL.md 解析 —— 报错会说「清单不合法」，
 * 而真正的问题是「形态判断错了」。
 *
 * git 仓库地址刻意不支持：它需要外部 git 二进制、凭据（私库）与更复杂的
 * 失败面。要装一个 git 上的技能，正确做法是下载它的归档（zip）——
 * 也就是上面第 1 条。
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifySkillSource, validateSkillSource, type SkillSourceDigest } from '@deepwork/protocol';
import { describeCause } from '../models/endpoint-test';
import { SKILL_MD } from './constants';
import { extractZip } from './zip';

/** 单次下载上限（字节）。技能是文本与脚本，几十 MB 已经远超合理范围 */
export const SKILL_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
/** 下载超时（毫秒） */
export const SKILL_DOWNLOAD_TIMEOUT_MS = 20_000;

export interface MaterializedSkill {
  /** 落到本地的目录（内含 SKILL.md），安装流程直接对它跑审计与拷贝 */
  dir: string;
  digest: SkillSourceDigest;
  /**
   * 清理临时目录。本地目录来源时是空操作 —— 调用方可以无条件调用它，
   * 不必自己记住「这次要不要删」。
   */
  cleanup: () => void;
}

export async function materializeSkillSource(input: {
  source: string;
  /** 临时落点（调用方给，通常是 <home>/tmp）；不存在会被创建 */
  workDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<MaterializedSkill> {
  const source = input.source.trim();
  const invalid = validateSkillSource(source);
  if (invalid) throw new Error(invalid);

  if (classifySkillSource(source) === 'local-dir') {
    const dir = path.resolve(source);
    if (!fs.existsSync(dir)) throw new Error(`来源目录不存在：${dir}`);
    return {
      dir,
      digest: { kind: 'local-dir', source, shape: 'directory', bytes: 0 },
      cleanup: () => {},
    };
  }

  const maxBytes = input.maxBytes ?? SKILL_DOWNLOAD_MAX_BYTES;
  fs.mkdirSync(input.workDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(input.workDir, 'skill-source-'));
  const cleanup = (): void => {
    fs.rmSync(work, { recursive: true, force: true });
  };

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(source, {
      redirect: 'follow',
      signal: AbortSignal.timeout(input.timeoutMs ?? SKILL_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    cleanup();
    // 网络错误的措辞与端点测试共用一份实现（describeCause）：同一件事
    // （连不上 / 域名解析不了 / 超时）在两处给出不同的中文解释，
    // 只会让用户以为是两个不同的问题
    throw new Error(`下载失败：${describeCause(error).message}`);
  }

  if (!response.ok) {
    cleanup();
    throw new Error(
      `下载失败：HTTP ${response.status}` +
        (response.status === 404 ? '（地址不存在；确认文件名与路径）' : '') +
        (response.status === 401 || response.status === 403 ? '（需要凭据；内网分发请换成可直接访问的地址）' : ''),
    );
  }

  // 先看声明的长度再读：读完整包再判大小，等于把「响应没有上限」这件事
  // 直接交给内存
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    cleanup();
    throw new Error(`下载内容 ${declared} 字节，超过上限 ${maxBytes} 字节`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    cleanup();
    throw new Error(`下载内容 ${buffer.length} 字节，超过上限 ${maxBytes} 字节`);
  }
  if (buffer.length === 0) {
    cleanup();
    throw new Error('下载到的内容为空');
  }

  try {
    if (isZip(buffer)) {
      const unpacked = path.join(work, 'unpacked');
      const result = extractZip(buffer, unpacked);
      if (result.files === 0) throw new Error('zip 里没有任何文件');
      const { dir, strippedRoot } = stripArchiveRoot(unpacked);
      if (!fs.existsSync(path.join(dir, SKILL_MD))) {
        throw new Error(`解包后没有找到 ${SKILL_MD}（技能目录根下必须有它）`);
      }
      return {
        dir,
        digest: {
          kind: 'url',
          source,
          shape: 'zip',
          bytes: buffer.length,
          ...(strippedRoot ? { strippedRoot } : {}),
        },
        cleanup,
      };
    }

    const text = buffer.toString('utf8');
    if (!/^\s*---/.test(text)) {
      throw new Error(
        '下载到的内容既不是 zip（没有 PK 文件头），也不像 SKILL.md（开头没有 --- 分隔的元数据）',
      );
    }
    fs.writeFileSync(path.join(work, SKILL_MD), buffer);
    return {
      dir: work,
      digest: { kind: 'url', source, shape: 'skill-md', bytes: buffer.length },
      cleanup,
    };
  } catch (error) {
    // 解包/形态判断失败同样要清理：留下的半个临时目录没有任何用处，
    // 而它里面是**未经审计**的外部内容
    cleanup();
    throw error;
  }
}

/** zip 的本地文件头签名（`PK\x03\x04`）；空归档是 `PK\x05\x06`，也认 */
function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/**
 * 剥掉归档的顶层「壳」目录。
 *
 * GitHub 的归档、以及多数手工打包的 zip，解出来都会多一层（`repo-main/`）。
 * 不剥的话，安装会以「根下没有 SKILL.md」失败 —— 而用户的 URL 完全正确，
 * 失败原因却指向他看不出问题的地方。
 *
 * 只在**确凿**的情况下剥：解包目录下只有一项、且它是个目录。多一项就不动，
 * 因为那时无法判断哪一层才是技能根（宁可让安装流程报「缺 SKILL.md」，
 * 也不要把技能装成一半）。
 */
function stripArchiveRoot(unpacked: string): { dir: string; strippedRoot?: string } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(unpacked, { withFileTypes: true });
  } catch {
    return { dir: unpacked };
  }
  if (entries.length !== 1 || !entries[0].isDirectory()) return { dir: unpacked };
  return { dir: path.join(unpacked, entries[0].name), strippedRoot: entries[0].name };
}
