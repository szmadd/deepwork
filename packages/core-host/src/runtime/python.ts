/**
 * Python 运行时解析（ROADMAP §8.1）。
 *
 * 为什么要有这么一个「唯一出口」：Python 解释器在目标机上是一个**外部依赖**，
 * 装没装、装的是哪个版本、是不是随包那份，都不能靠调用点各自 `spawn('python')` 碰运气 ——
 * 那样错误会以「某个功能在本机好用、在客户机上莫名失败」的形式出现，且没有线索指向原因。
 *
 * 解析顺序与 Node 完全同构（`RUNTIME_RESOLUTION_ORDER`）：
 *   `DEEPWORK_PYTHON_BIN` > 随包 > 系统 PATH。
 * 随包优先于系统是有意的：目标机上可能装着一个残缺或版本不符的 Python，
 * 被优先选中后出的问题与环境相关，是最难复现的一类。
 *
 * 当前消费者只有一个：`tools/office-test.js` 的独立实现校验（用另一个进程、
 * 另一套实现复核我们生成的 docx/xlsx）。产品运行时今天没有 Python 依赖 ——
 * 这一项的真实动机是**面向未来**（离线场景下的 Python 技能 / 连接器 / 文档处理），
 * 所以这里建的是出口与解析纪律，不是「修复某个现有缺陷」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BUNDLED_RUNTIMES, RUNTIME_ENV_OVERRIDE, type RuntimeResolution } from '@deepwork/protocol';

/** 随包 Python 在 resources/ 下的落位名（与 electron-builder.yml 的 extraResources 一致） */
export const BUNDLED_PYTHON_DIR = 'python-runtime';

/** 显式指定随包目录的位置（测试与调试用；正常运行由布局推导） */
export const BUNDLED_PYTHON_DIR_ENV = 'DEEPWORK_BUNDLED_PYTHON_DIR';

/**
 * 「这个 Python 够不够用」的最小能力集。
 *
 * 探测时**真的 import 一次**，只看能不能启动是不够的：一个残缺的解释器
 * （比如部分 .pyd 被 AV 拦掉）照样能打印版本号，却会在真正干活时才失败。
 * 这两个模块是全仓唯一的 Python 消费方（office 独立校验）实际用到的标准库。
 */
const REQUIRED_MODULES = 'import zipfile, xml.etree.ElementTree';

function pythonExeNames(): string[] {
  return process.platform === 'win32' ? ['python.exe'] : ['bin/python3', 'bin/python'];
}

/**
 * 随包目录的**默认**候选位置，按可信度排序。
 *
 * 两种运行形态下 core-host 所在的层级不同，所以两条路径都要有：
 *  - 打包态：`resources/core-host/dist/runtime/` → `resources/python-runtime/`
 *  - 开发态：`packages/core-host/dist/runtime/`  → `<仓库>/offline-bundle/staging/python-runtime/`
 *
 * 另外 `DEEPWORK_BUNDLED_PYTHON_DIR` 指定的目录排在最前（壳层若知道确切位置，
 * 设它即可，不必依赖下面这套布局推导）。
 *
 * 注意这是一个**兜底推导**，不是唯一入口：调用方明确知道候选在哪时，
 * 应当把 `resolvePythonRuntime({ bundledDirs })` 传进去 —— 否则「我以为在用 A，
 * 实际命中了 B」这种歧义没有任何报错（本文件的第一版就有这个问题：
 * 测试想验证「没有随包时会不会如实报错」，却总被布局推导悄悄兜住）。
 */
export function defaultBundledDirs(): string[] {
  const dirs: string[] = [];
  const fromEnv = process.env[BUNDLED_PYTHON_DIR_ENV];
  if (fromEnv && fromEnv.trim()) dirs.push(fromEnv.trim());
  dirs.push(path.resolve(__dirname, '..', '..', '..', BUNDLED_PYTHON_DIR));
  dirs.push(
    path.resolve(__dirname, '..', '..', '..', '..', 'offline-bundle', 'staging', BUNDLED_PYTHON_DIR),
  );
  return dirs;
}

/** 跑一次解释器，确认它可用并取回版本号。永不抛。 */
function probe(bin: string): { ok: boolean; version?: string } {
  try {
    const result = spawnSync(
      bin,
      ['-c', `${REQUIRED_MODULES}; import sys; print(sys.version.split()[0])`],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) return { ok: false };
    return { ok: true, version: (result.stdout ?? '').trim() };
  } catch {
    return { ok: false };
  }
}

/**
 * 解析该用哪个 Python。三档都落空时返回 `null`（而不是抛异常或返回一个假路径）——
 * 「这台机器上没有可用的 Python」是一个**事实**，调用方有权据此降级（office-test 就 SKIP）。
 *
 * @param options.bundledDirs 显式给出随包候选目录。**给了就只用这些**，不再走布局推导 ——
 *   「候选从哪来」必须是调用方说了算，否则无法构造「确实没有随包」这种情形，
 *   而那种情形正是「如实报错」这条保证唯一能被证伪的地方。
 */
export function resolvePythonRuntime(
  options: { bundledDirs?: string[] } = {},
): RuntimeResolution | null {
  const explicit = process.env[RUNTIME_ENV_OVERRIDE.python];
  if (explicit && fs.existsSync(explicit)) {
    const probed = probe(explicit);
    return {
      bin: explicit,
      args: [],
      source: 'explicit-env',
      label: `${RUNTIME_ENV_OVERRIDE.python}（Python ${probed.version ?? '未能确认可用'}）`,
    };
  }

  for (const dir of options.bundledDirs ?? defaultBundledDirs()) {
    for (const name of pythonExeNames()) {
      const bin = path.join(dir, name);
      if (!fs.existsSync(bin)) continue;
      /**
       * 随包这份**只查存在性，不跑进程**：它就是我们准备要用的那一个，
       * 每次解析都付一次进程开销不值得。而「文件在却跑不起来」（被 AV 拦、
       * 被半途杀掉）正是安装体检（§8.3）要报的**阻断项** —— 那才是该发现它的地方。
       */
      return {
        bin,
        args: [],
        source: 'bundled',
        label: `随包 Python 运行时（${BUNDLED_RUNTIMES.python}）`,
      };
    }
  }

  const candidates = process.platform === 'win32' ? ['python3', 'python', 'py'] : ['python3', 'python'];
  for (const candidate of candidates) {
    const probed = probe(candidate);
    if (probed.ok) {
      return {
        bin: candidate,
        args: [],
        source: 'system-path',
        label: `系统 PATH（Python ${probed.version ?? '版本未知'}）`,
      };
    }
  }

  return null;
}

/**
 * 给子进程准备的 Python 环境变量。
 *
 * 命中随包运行时做两件事：
 *  1. 把随包目录**前置**进 PATH —— 下游（脚本自己再调 `python`、或调用 pip）
 *     才会命中同一份，而不是撞上系统那个版本不符的；
 *  2. 删掉 `PYTHONHOME` —— 它会让解释器跑去系统那份标准库里找模块，
 *     症状是「import 莫名其妙失败」。随包运行时必须与系统环境隔离。
 */
export function pythonRuntimeEnv(
  resolution: RuntimeResolution,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (resolution.source !== 'bundled') return env;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${path.dirname(resolution.bin)}${path.delimiter}${env[pathKey] ?? ''}`;
  delete env.PYTHONHOME;
  return env;
}
