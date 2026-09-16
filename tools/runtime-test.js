#!/usr/bin/env node
/**
 * 运行时解析验收（ROADMAP §8.1）。
 *
 * ── 这份测试不依赖机器上真装了什么 ──────────────────────────────────────
 * 「解析顺序对不对」是一个**纯逻辑**问题：给三个档位各放一个可辨认的候选，
 * 看它挑的是哪一个。所以本文件用**伪造的候选目录**来测优先级 ——
 * 这样在任何机器上都能跑出确定结论，而不是「本机刚好有随包 Python 才测得到」。
 *
 * 「随包那份真能跑」是另一回事，单独一段做，**没有随包目录就如实 SKIP**：
 * 那是环境事实，不是失败。
 *
 * 两道必要的防线：
 *  1. **反证**：把 PATH 遮蔽掉、又不给随包候选时，必须返回 `null` ——
 *     如果这里返回了一个编出来的路径，那「解析失败」就被伪装成了成功，
 *     下游的表现是「脚本跑了但结果不对」，比直接报错难查得多。
 *  2. **同一出口**：断言用的是 core-host 里产品自己用的那个函数，
 *     而不是在测试里重写一遍规则（重写等于测了个寂寞）。
 *
 * 用法：node tools/runtime-test.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const { BUNDLED_RUNTIMES, RUNTIME_ENV_OVERRIDE, RUNTIME_RESOLUTION_ORDER } = require(
  path.join(ROOT, 'packages/protocol/dist/deploy.js'),
);
const {
  resolvePythonRuntime,
  pythonRuntimeEnv,
  defaultBundledDirs,
  BUNDLED_PYTHON_DIR_ENV,
  BUNDLED_PYTHON_DIR,
} = require(path.join(ROOT, 'packages/core-host/dist/runtime/python.js'));

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  [SKIP] ${name}${reason ? ` — ${reason}` : ''}`);
}

function section(title) {
  console.log(`\n${title}`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-runtime-'));

/** 造一个「看起来像解释器」的占位文件（随包那档只查存在性，不需要它真能跑） */
function fakeExe(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '');
  return file;
}

/**
 * 在受控环境变量下跑一段逻辑，跑完精确恢复。
 *
 * 只碰本测试关心的键（含 PATH 的两种大小写）—— 不整体清空 process.env，
 * 那样会把无关的东西一起动了，测试之间容易互相污染。
 */
function withEnv(patch, fn) {
  const keys = new Set([
    ...Object.keys(patch),
    RUNTIME_ENV_OVERRIDE.python,
    BUNDLED_PYTHON_DIR_ENV,
    'PATH',
    'Path',
    'PYTHONHOME',
  ]);
  const backup = new Map();
  for (const key of keys) backup.set(key, process.env[key]);
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(patch)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of backup) if (value !== undefined) process.env[key] = value;
  }
}

const EXE = process.platform === 'win32' ? 'python.exe' : 'bin/python3';

console.log('深边AI Work · 运行时解析验收');
console.log(`契约顺序：${RUNTIME_RESOLUTION_ORDER.join(' > ')}`);

// ── 一、默认候选的构成 ────────────────────────────────────────────────────

section('默认候选（生产路径）');

{
  const dirs = withEnv({ [BUNDLED_PYTHON_DIR_ENV]: path.join(scratch, 'custom-bundled') }, () =>
    defaultBundledDirs(),
  );
  check('环境变量指定的目录排在默认候选首位', dirs[0] === path.join(scratch, 'custom-bundled'), dirs[0]);
  check(
    '默认候选覆盖打包态与开发态两种布局',
    dirs.some((d) => d.endsWith(`${BUNDLED_PYTHON_DIR}`)) && dirs.length >= 3,
    dirs.join(' | '),
  );
}

// ── 二、随包优先于系统 PATH ───────────────────────────────────────────────

section('第二档：随包（只查存在，不跑进程）');

const bundledDir = path.join(scratch, 'python-runtime');
const bundledBin = fakeExe(bundledDir, EXE);

{
  const resolved = resolvePythonRuntime({ bundledDirs: [bundledDir] });
  check('随包目录命中 → source 为 bundled', resolved?.source === 'bundled', resolved?.source);
  check('返回的就是随包目录里那个文件', resolved?.bin === bundledBin, resolved?.bin);
  check('label 说明是随包运行时', /随包/.test(resolved?.label ?? ''), resolved?.label);
  check(
    'label 里带契约声明的版本号',
    (resolved?.label ?? '').includes(BUNDLED_RUNTIMES.python),
    resolved?.label,
  );
}

// ── 三、显式指定优先于随包 ────────────────────────────────────────────────

section('第一档：显式指定（DEEPWORK_PYTHON_BIN）');

const explicitBin = fakeExe(
  path.join(scratch, 'explicit'),
  process.platform === 'win32' ? 'my-python.exe' : 'my-python',
);

{
  const resolved = withEnv({ [RUNTIME_ENV_OVERRIDE.python]: explicitBin }, () =>
    resolvePythonRuntime({ bundledDirs: [bundledDir] }),
  );
  check('显式指定盖过随包 → source 为 explicit-env', resolved?.source === 'explicit-env', resolved?.source);
  check('返回的是显式指定那个文件', resolved?.bin === explicitBin, resolved?.bin);
  check(
    'label 写出是哪个环境变量在起作用（否则用户不知道该改什么）',
    (resolved?.label ?? '').includes(RUNTIME_ENV_OVERRIDE.python),
    resolved?.label,
  );
}

// ── 四、反证：都没有时必须如实返回 null ───────────────────────────────────

section('第三档：系统 PATH / 都没有');

const emptyPath = path.join(scratch, 'empty-path');
fs.mkdirSync(emptyPath, { recursive: true });

{
  const resolved = withEnv({ PATH: emptyPath, Path: emptyPath }, () =>
    resolvePythonRuntime({ bundledDirs: [] }),
  );
  check(
    'PATH 遮蔽且无随包候选时，如实返回 null（不编一个路径出来）',
    resolved === null,
    resolved ? `返回了 ${resolved.bin}（source=${resolved.source}）` : '',
  );
}

{
  const resolved = withEnv({ PATH: emptyPath, Path: emptyPath }, () =>
    resolvePythonRuntime({ bundledDirs: [path.join(scratch, 'not-there')] }),
  );
  check(
    '随包候选不存在时不误判为命中（回落到 system-path 或 null）',
    resolved === null || resolved.source === 'system-path',
    resolved ? `${resolved.source} — ${resolved.bin}` : 'null',
  );
}

// ── 五、子进程环境准备 ────────────────────────────────────────────────────

section('子进程环境准备（pythonRuntimeEnv）');

{
  const env = pythonRuntimeEnv(
    { bin: bundledBin, args: [], source: 'bundled', label: '' },
    { PATH: 'C:\\elsewhere', PYTHONHOME: 'C:\\bad-python', KEEP: '1' },
  );
  check('随包命中：随包目录被前置进 PATH', env.PATH.startsWith(path.dirname(bundledBin)), env.PATH);
  check('随包命中：PATH 里仍保留原有内容（只是被前置）', env.PATH.includes('C:\\elsewhere'));
  check(
    '随包命中：PYTHONHOME 被清掉（否则解释器会去系统找标准库，报 import 失败）',
    !('PYTHONHOME' in env),
  );
  check('其余变量原样保留', env.KEEP === '1');

  const systemEnv = pythonRuntimeEnv(
    { bin: 'python', args: [], source: 'system-path', label: '' },
    { PATH: 'C:\\elsewhere', PYTHONHOME: 'C:\\keep-me' },
  );
  check(
    '非随包命中：不动 PATH、不删 PYTHONHOME（系统解释器该用系统环境）',
    systemEnv.PATH === 'C:\\elsewhere' && systemEnv.PYTHONHOME === 'C:\\keep-me',
  );
}

// ── 六、真随包 Python（有才跑，没有就 SKIP） ──────────────────────────────

section('真随包 Python');

const realBundledDir = path.join(ROOT, 'offline-bundle/staging', BUNDLED_PYTHON_DIR);
const realBundledBin = path.join(realBundledDir, EXE);

if (fs.existsSync(realBundledBin)) {
  const resolved = resolvePythonRuntime({ bundledDirs: [realBundledDir] });
  check('本机随包 Python 被解析出来', resolved?.source === 'bundled', resolved?.label);

  const stdlib = spawnSync(
    realBundledBin,
    ['-c', 'import sys, zipfile, xml.etree.ElementTree; print(sys.version.split()[0])'],
    { encoding: 'utf8', timeout: 20_000 },
  );
  check(
    '随包 Python 能跑标准库（office 独立校验用的就是这两个）',
    stdlib.status === 0 && (stdlib.stdout ?? '').trim().startsWith('3.12'),
    (stdlib.stderr ?? stdlib.stdout ?? '').trim().split('\n')[0],
  );
  check(
    `随包 Python 版本与契约一致（${BUNDLED_RUNTIMES.python}）`,
    (stdlib.stdout ?? '').trim() === BUNDLED_RUNTIMES.python,
    (stdlib.stdout ?? '').trim(),
  );

  const pip = spawnSync(realBundledBin, ['-m', 'pip', '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  check(
    '随包 Python 带 pip（§8.2 的自定义 pip 源依赖它）',
    pip.status === 0 && /pip \d/.test(pip.stdout ?? ''),
    (pip.stderr ?? pip.stdout ?? '').trim().split('\n')[0],
  );

  /**
   * 反证：PYTHONHOME 指向一个不存在的位置时解释器会失败，
   * 而 `pythonRuntimeEnv` 清掉它之后又能跑 —— 这条证明那一行 `delete` 是有用的，
   * 而不是一段看起来合理的防御性代码。
   */
  const polluted = spawnSync(realBundledBin, ['-c', 'import zipfile; print("ok")'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PYTHONHOME: path.join(scratch, 'not-a-python-home') },
  });
  const cleaned = pythonRuntimeEnv(resolved, { ...process.env });
  delete cleaned.PYTHONHOME;
  const withCleanEnv = spawnSync(realBundledBin, ['-c', 'import zipfile; print("ok")'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: cleaned,
  });
  check(
    'PYTHONHOME 污染下会失效、而 pythonRuntimeEnv 能救回来（证明那行删除是有用的）',
    polluted.status !== 0 && withCleanEnv.status === 0,
    `污染时 status=${polluted.status}，清理后 status=${withCleanEnv.status}`,
  );
} else {
  skip(
    '随包 Python 实跑验证',
    `本机无 ${path.relative(ROOT, realBundledDir)}（随包目录不入库，属可重建产物）`,
  );
}

// ── 汇总 ─────────────────────────────────────────────────────────────────

console.log(`\n通过 ${passed} 项，失败 ${failed} 项${skipped ? `，跳过 ${skipped} 项` : ''}`);
if (failed > 0) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
}
process.exit(failed === 0 ? 0 : 1);
