/**
 * 安装前环境体检（ROADMAP §8.3）。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────────
 * 离线部署最坏的失败形态是「装完了，双击没反应，没有任何线索」——
 * 用户能给出的信息只有「打不开」，而可能的原因有七八个（磁盘满了、
 * 目标目录没写权限、随包运行时被 AV 吃掉一半、系统架构不对……）。
 * 体检把这件事从「事后猜」变成「事前逐项说清楚」。
 *
 * ── 两条设计纪律 ────────────────────────────────────────────────────────
 * 1. **每项都要给出可行动的建议**（`remedy`）。只说「检查失败」等于把问题
 *    原样丢回给用户，那不叫体检。
 * 2. **分级按实际后果，不按「看起来严不严重」**：随包 Node 缺失是阻断
 *    （内核根本起不来），随包 Python 缺失只是警告（产品今天没有 Python 依赖，
 *    缺了只影响未来能力）。把后者也标成阻断，会让用户在没坏的时候不敢装。
 *
 * 这一层刻意**不依赖 Electron**：它必须能被 `tools/preflight-test.js` 直接调用，
 * 否则「先进 verify 再进安装包」这条顺序就做不到（见 ROADMAP §8.3 的关键决策）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BUNDLED_RUNTIMES,
  type PipSource,
  type PreflightCheck,
  type PreflightReport,
} from '@deepwork/protocol';

/**
 * 报告的结构（`PreflightCheck` / `PreflightReport` / `PreflightLevel`）
 * 定义在契约层 `@deepwork/protocol` 的 `deploy.ts` —— 界面要跨进程拿到它，
 * 类型就得在两边都看得见的地方；写在实现文件里会让渲染层只能自己声明一份
 * 长得像的结构，而那种复制迟早会与这里分叉。
 */

export interface PreflightInput {
  /**
   * 随包运行时所在的 resources 目录（打包态）或仓库 offline-bundle/staging（开发态）。
   * 不给就按 core-host 自己的位置推导。
   */
  resourcesDir?: string;
  /** 应用会写入的位置（安装目录或用户数据目录）；不给就不检查写权限 */
  writeDir?: string;
  /** 磁盘剩余空间下限，默认 2 GiB */
  minFreeBytes?: number;
  /** 已配置的 pip 源；未配置会给一条警告（Python 包装不了） */
  pipSource?: PipSource;
  /** 覆盖平台与架构（测试用来构造「架构不符」这类本机造不出的场景） */
  platform?: NodeJS.Platform;
  arch?: string;
}

const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 随包运行时目录的默认候选（与 runtime/python.ts 同一套推导思路：
 * 打包态与开发态的层级不同，两条都要有）。
 */
export function defaultResourcesDirs(): string[] {
  return [
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..', '..', 'offline-bundle', 'staging'),
  ];
}

/** 挑第一个真的放着随包运行时的目录；都没有就返回第一个候选（好让报告指出该去哪找） */
function pickResourcesDir(explicit?: string): string {
  if (explicit) return explicit;
  const candidates = defaultResourcesDirs();
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node-runtime')) || fs.existsSync(path.join(dir, 'dsh-runtime'))) {
      return dir;
    }
  }
  return candidates[0];
}

const EXE = (platform: NodeJS.Platform, name: string): string =>
  platform === 'win32' ? `${name}.exe` : name;

/** 跑一次可执行文件确认它「不只能被看到，还能被跑起来」——AV 拦截就是这个形态 */
function canRun(bin: string, args: string[]): { ok: boolean; output: string } {
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) {
      return { ok: false, output: (result.stderr || result.stdout || '非零退出').trim().split('\n')[0] };
    }
    return { ok: true, output: (result.stdout ?? '').trim() };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** 剩余磁盘空间（字节）；查不到时返回 null（不猜一个数出来） */
function freeDiskBytes(target: string): number | null {
  try {
    const stats = fs.statfsSync(target);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** 系统是否装了可被 CDP 驱动的浏览器（browser 面板的前提） */
function findSystemBrowser(platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') return null;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${bytes} B`;
}

/**
 * 跑一次体检。
 *
 * 同步实现是有意的：它会被安装器与「首次启动」这类**阻塞式**流程调用，
 * 返回 Promise 只会让调用点多一层等待，而每一项本身都是毫秒级。
 */
export function runPreflight(input: PreflightInput = {}): PreflightReport {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const resourcesDir = pickResourcesDir(input.resourcesDir);
  const minFree = input.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const checks: PreflightCheck[] = [];

  // ── 阻断级 ────────────────────────────────────────────────────────────

  checks.push({
    id: 'os-arch',
    level: 'block',
    title: '操作系统架构',
    ok: arch === 'x64',
    detail: `当前为 ${platform} / ${arch}，随包运行时只提供 x64 版本`,
    remedy: '请在 64 位 Windows（x64）上安装；ARM 设备暂不支持。',
  });

  checks.push({
    id: 'bundled-node',
    level: 'block',
    title: `随包 Node 运行时（${BUNDLED_RUNTIMES.node}）`,
    ok: false, // 下面据实改写
    detail: '',
    remedy: '重新运行安装包修复安装；若杀毒软件报过警，请把安装目录加入白名单后重装。',
  });
  {
    const check = checks[checks.length - 1];
    const bin = path.join(resourcesDir, 'node-runtime', EXE(platform, 'node'));
    if (!fs.existsSync(bin)) {
      check.detail = `未找到 ${path.relative(resourcesDir, bin)}`;
    } else {
      const run = canRun(bin, ['-v']);
      check.ok = run.ok;
      check.detail = run.ok
        ? `${bin} → ${run.output}`
        : `文件在但跑不起来（${run.output}）—— 典型的杀毒软件拦截或安装不完整`;
    }
  }

  if (input.writeDir) {
    checks.push({
      id: 'write-permission',
      level: 'block',
      title: '写入权限',
      ok: false,
      detail: '',
      remedy: '换一个你有写权限的目录安装，或以管理员身份运行安装程序。',
    });
    const check = checks[checks.length - 1];
    const probe = path.join(input.writeDir, `.deepwork-preflight-${process.pid}.tmp`);
    try {
      fs.mkdirSync(input.writeDir, { recursive: true });
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      check.ok = true;
      check.detail = `${input.writeDir} 可写`;
    } catch (error) {
      check.detail = `不可写：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const freeTarget = input.writeDir ?? resourcesDir;
  {
    const free = freeDiskBytes(freeTarget);
    checks.push({
      id: 'disk-space',
      level: 'block',
      title: '磁盘剩余空间',
      ok: free === null ? true : free >= minFree,
      detail:
        free === null
          ? `无法读取 ${freeTarget} 所在卷的剩余空间（不作判断）`
          : `${freeTarget} 所在卷剩余 ${formatBytes(free)}，要求 ≥ ${formatBytes(minFree)}`,
      remedy: `清理磁盘，至少留出 ${formatBytes(minFree)} 空间后重试。`,
    });
  }

  // ── 警告级 ────────────────────────────────────────────────────────────

  checks.push({
    id: 'bundled-python',
    level: 'warn',
    title: `随包 Python 运行时（${BUNDLED_RUNTIMES.python}）`,
    ok: false,
    detail: '',
    remedy: '重新运行安装包修复安装。缺失只影响 Python 相关能力（离线技能 / 文档处理），不影响对话与内核。',
  });
  {
    const check = checks[checks.length - 1];
    const bin = path.join(resourcesDir, 'python-runtime', EXE(platform, 'python'));
    if (!fs.existsSync(bin)) {
      check.detail = `未找到 ${path.relative(resourcesDir, bin)}`;
    } else {
      const run = canRun(bin, ['-c', 'import zipfile, xml.etree.ElementTree; print("ok")']);
      check.ok = run.ok;
      check.detail = run.ok ? `${bin} 可用` : `文件在但跑不起来（${run.output}）`;
    }
  }

  checks.push({
    id: 'bundled-dsh',
    level: 'warn',
    title: `真实内核依赖（DeepSeek Harness ${BUNDLED_RUNTIMES.dsh}）`,
    ok: false,
    detail: '',
    remedy:
      '重新运行安装包修复安装；或设置 DEEPWORK_HARNESS_CMD 指向一个外部的 dsh 入口。'
      + '缺失时只能使用 mock 内核（无真实模型能力）。',
  });
  {
    const check = checks[checks.length - 1];
    const entry = path.join(resourcesDir, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    check.ok = fs.existsSync(entry);
    check.detail = check.ok ? path.relative(resourcesDir, entry) : `未找到 ${path.relative(resourcesDir, entry)}`;
  }

  {
    const browser = findSystemBrowser(platform);
    checks.push({
      id: 'system-browser',
      level: 'warn',
      title: '系统浏览器（浏览器自动化面板的前提）',
      ok: Boolean(browser),
      detail: browser ?? '未在本机常见位置找到 Edge / Chrome',
      remedy: '安装 Microsoft Edge 或 Google Chrome 后，浏览器面板才可用；其余功能不受影响。',
    });
  }

  {
    const configured = Boolean(input.pipSource && input.pipSource.indexUrl);
    checks.push({
      id: 'pip-source',
      level: 'warn',
      title: '内网 pip 源',
      ok: configured,
      detail: configured
        ? `${input.pipSource?.indexUrl}${input.pipSource?.trustedHost ? `（受信主机 ${input.pipSource.trustedHost}）` : ''}`
        : '未配置',
      remedy:
        '在设置 → 高级里填写内网 pip 源（如 http://nexus.corp/repository/pypi/simple）。'
        + '不配也能用，但离线环境下任何需要安装 Python 包的能力都会失败。',
    });
  }

  const blocked = checks.filter((c) => !c.ok && c.level === 'block').length;
  const warned = checks.filter((c) => !c.ok && c.level === 'warn').length;
  return { ok: blocked === 0, checks, blocked, warned };
}

/** 一行摘要，供日志与界面顶栏使用 */
export function summarizePreflight(report: PreflightReport): string {
  if (report.blocked > 0) return `体检未通过：${report.blocked} 项阻断`;
  if (report.warned > 0) return `体检通过（${report.warned} 项警告）`;
  return '体检通过';
}
