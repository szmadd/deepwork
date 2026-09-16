#!/usr/bin/env node
/**
 * 内网 pip 源验收（ROADMAP §8.2）。
 *
 * ── 这一节的核心判据 ────────────────────────────────────────────────────
 * 「配置了源」与「请求真的打到了那个源」是两件事。前者靠读一份 config 就能断言，
 * 但它证明不了任何东西 —— 参数拼错、被用户级 pip.ini 覆盖、pip 悄悄回落到公网，
 * 这三种情况下「配置里写着内网源」全都成立。
 *
 * 所以本文件真的起一个假索引服务器，真跑一次 pip，然后**从服务端侧**看有没有请求进来。
 * 客户端的自述不算证据。
 *
 * 反向也测：没配源时**一个参数都不许加** —— 「顺手补个默认源」正是这条需求
 * 最要防的事（离线机器上静默连公网、或装上来路不明的包）。
 *
 * 用法：node tools/pip-test.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const {
  validatePipSource,
  pipSourceArgs,
  describePipSource,
} = require(path.join(ROOT, 'packages/protocol/dist/deploy.js'));
const { pipArgv, pipEnv, classifyPipFailure } = require(path.join(ROOT, 'packages/core-host/dist/runtime/pip.js'));
const { resolvePythonRuntime } = require(path.join(ROOT, 'packages/core-host/dist/runtime/python.js'));

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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-pip-'));

console.log('深边AI Work · 内网 pip 源验收');

// ── 一、地址校验 ─────────────────────────────────────────────────────────

section('pip 源校验（validatePipSource）');

function rejects(source, keyword) {
  try {
    validatePipSource(source);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    return message.includes(keyword);
  }
  return false;
}

check('合法 http 地址通过', (() => {
  try {
    validatePipSource({ indexUrl: 'http://nexus.corp/repository/pypi/simple' });
    return true;
  } catch {
    return false;
  }
})());
check('https 地址通过', (() => {
  try {
    validatePipSource({ indexUrl: 'https://mirror.corp/simple', trustedHost: 'mirror.corp' });
    return true;
  } catch {
    return false;
  }
})());
check('空地址被拒且说明原因', rejects({ indexUrl: '' }, '不能为空'));
check(
  '缺 scheme 被拒（这类地址 pip 会当成相对路径，报错发生在安装中途）',
  rejects({ indexUrl: 'nexus.corp/simple' }, 'http://'),
);
check(
  '受信主机带 scheme 被拒（pip 不接受，且失败会出现在安装中途）',
  rejects({ indexUrl: 'http://nexus.corp/simple', trustedHost: 'http://nexus.corp' }, '只填主机名'),
);
check(
  '受信主机带端口被拒',
  rejects({ indexUrl: 'http://nexus.corp/simple', trustedHost: 'nexus.corp:8081' }, '只填主机名'),
);

// ── 二、参数注入 ─────────────────────────────────────────────────────────

section('参数注入（pipSourceArgs / pipArgv）');

check('未配置源 → 空数组（一个参数都不加）', pipSourceArgs(undefined).length === 0);
check('空 indexUrl → 空数组', pipSourceArgs({ indexUrl: '' }).length === 0);
check(
  '配置 indexUrl → --index-url',
  pipSourceArgs({ indexUrl: 'http://nexus.corp/simple' }).join(' ') ===
    '--index-url http://nexus.corp/simple',
);
check(
  '配置 trustedHost → 追加 --trusted-host',
  pipSourceArgs({ indexUrl: 'http://nexus.corp/simple', trustedHost: 'nexus.corp' }).join(' ') ===
    '--index-url http://nexus.corp/simple --trusted-host nexus.corp',
);
check('地址两侧空白被裁掉', pipSourceArgs({ indexUrl: '  http://a.corp/simple  ' })[1] === 'http://a.corp/simple');

const fakePython = { bin: 'python.exe', args: [], source: 'bundled', label: '' };
{
  const argv = pipArgv(fakePython, ['install', 'requests'], { indexUrl: 'http://nexus.corp/simple' });
  check(
    'argv = -m pip <子命令> <源参数>（解释器路径由调用方单独传，不在这里重复）',
    argv.join(' ') === '-m pip install requests --index-url http://nexus.corp/simple',
    argv.join(' '),
  );
  check(
    '源参数排在子命令之后（对所有子命令都生效）',
    argv.indexOf('--index-url') > argv.indexOf('install'),
  );
  check(
    '未配置源时 argv 里没有 --index-url',
    !pipArgv(fakePython, ['install', 'requests']).includes('--index-url'),
  );
}

check(
  'describePipSource 未配置时如实说「未配置」',
  describePipSource(undefined).includes('未配置'),
  describePipSource(undefined),
);

// ── 三、子进程环境隔离 ───────────────────────────────────────────────────

section('pip 环境隔离（pipEnv）');

{
  const env = pipEnv(fakePython, { PATH: 'C:\\x' });
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  check(
    'PIP_CONFIG_FILE 指向空设备（不读目标机的 pip.ini）',
    env.PIP_CONFIG_FILE === nullDevice,
    env.PIP_CONFIG_FILE,
  );
  check('PIP_NO_INPUT=1（否则凭据缺失时 pip 会等人输入，表现为进程挂住）', env.PIP_NO_INPUT === '1');
  check('关闭版本检查（离线机器上那是一次无谓的联网尝试）', env.PIP_DISABLE_PIP_VERSION_CHECK === '1');

  const bundledEnv = pipEnv({ bin: 'D:\\app\\python.exe', args: [], source: 'bundled', label: '' }, {
    PATH: 'C:\\x',
  });
  check('随包命中时 PATH 被前置（pip 子进程里再调 python 也命同一份）', bundledEnv.PATH.startsWith('D:\\app'));

  const systemEnv = pipEnv({ bin: 'python', args: [], source: 'system-path', label: '' }, {
    PATH: 'C:\\x',
  });
  check('非随包命中时不改 PATH', systemEnv.PATH === 'C:\\x');
}

// ── 四、失败归因 ─────────────────────────────────────────────────────────

section('失败归因（classifyPipFailure）');

check(
  '「连不上」被认出来',
  classifyPipFailure('Could not fetch URL: Failed to establish a new connection: [Errno 111] Connection refused') ===
    'unreachable',
);
check(
  'DNS 解析失败被认出来',
  classifyPipFailure('Temporary failure in name resolution') === 'unreachable',
);
check(
  '证书问题被认出来（内网自签证书最常见的症状）',
  classifyPipFailure('SSLError: certificate verify failed: self signed certificate') === 'unreachable',
);
check(
  '「源通了但没这个包」被认出来',
  classifyPipFailure('ERROR: Could not find a version that satisfies the requirement foo\nNo matching distribution found for foo') ===
    'not-found',
);
check(
  '认不出来时如实返回 unknown（不猜）',
  classifyPipFailure('some brand new pip error wording') === 'unknown',
);

// ── 五、真跑：请求必须打到配置的源（本节的核心判据） ────────────────────

const PROBE_PKG = 'deepwork-probe-nonexistent-pkg';

async function realRun() {
  section('真跑验证（本地假索引 + 随包 Python）');

  const python = resolvePythonRuntime();
  if (!python) {
    skip('真跑验证', '本机没有可用的 Python');
    return;
  }
  console.log(`  （解释器：${python.label}）`);

  const logFile = path.join(scratch, 'requests.log');
  fs.writeFileSync(logFile, '');
  const serverScript = path.join(ROOT, 'tools/fixtures/pip-index-server.js');
  const server = spawn(process.execPath, [serverScript, logFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('假索引服务器 10 秒内未就绪')), 10_000);
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = /LISTENING (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    server.on('error', reject);
  });

  try {
    const indexUrl = `http://127.0.0.1:${port}/simple`;
    const dest = path.join(scratch, 'downloaded');

    // 用 download 而不是 index versions：后者是实验性命令，跨 pip 版本行为不稳；
    // download 在「找不到包」时照样会把索引请求发出去，这正是我们要观察的动作。
    const argv = pipArgv(
      python,
      ['download', '--no-deps', '--no-cache-dir', '--dest', dest, PROBE_PKG],
      { indexUrl },
    );
    const result = spawnSync(python.bin, argv, {
      encoding: 'utf8',
      timeout: 120_000,
      env: pipEnv(python),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const requests = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const stderr = result.stderr ?? '';
    const stdout = result.stdout ?? '';

    check(
      '假索引服务器收到了 pip 的请求（**服务端侧**的证据）',
      requests.length > 0,
      requests.length ? `${requests.length} 条：${requests[0]}` : '一条请求都没来',
    );
    check(
      '请求路径里带包名（说明确实在查这个索引，而不是随便连了一下）',
      requests.some((line) => line.includes(PROBE_PKG)),
      requests.join(' | ').slice(0, 200),
    );
    check(
      'pip 用的是我们给的源（命令行里带 --index-url 且值正确）',
      argv.includes('--index-url') && argv.includes(indexUrl),
      argv.join(' '),
    );
    check(
      '「源通了但没有包」与「连不上」被分开（退出码相同，只能靠归因）',
      classifyPipFailure(stderr + stdout) === 'not-found',
      `归因=${classifyPipFailure(stderr + stdout)}；stderr 片段：${stderr.trim().split('\n').slice(-2).join(' / ')}`,
    );

    /**
     * 反向：不给源时**不许**出现 --index-url。
     * 用 `--no-index` 显式断掉联网，免得这条断言真去打公网 PyPI
     * （测试不该依赖外网，更不该在离线环境里卡住）。
     */
    const noSourceArgv = pipArgv(python, [
      'download',
      '--no-index',
      '--no-deps',
      '--dest',
      dest,
      PROBE_PKG,
    ]);
    spawnSync(python.bin, noSourceArgv, {
      encoding: 'utf8',
      timeout: 60_000,
      env: pipEnv(python),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const argvText = noSourceArgv.join(' ');
    check(
      '未配置源时不注入任何源参数（不伪造默认源）',
      !argvText.includes('--index-url') && !argvText.includes('--trusted-host'),
      argvText,
    );

    const before = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length;
    check(
      '未配置源的那次没有打到我们的假索引（说明上一条的请求确实来自源参数）',
      before === requests.length,
      `之前 ${requests.length} 条，之后 ${before} 条`,
    );
  } finally {
    server.kill('SIGTERM');
  }
}

realRun()
  .catch((error) => {
    console.error('真跑验证异常：', error.message);
    failed++;
    failures.push('真跑验证执行异常');
  })
  .finally(() => {
    console.log(`\n通过 ${passed} 项，失败 ${failed} 项${skipped ? `，跳过 ${skipped} 项` : ''}`);
    if (failed > 0) {
      console.log('失败项：');
      for (const name of failures) console.log(`  - ${name}`);
    }
    process.exit(failed === 0 ? 0 : 1);
  });
