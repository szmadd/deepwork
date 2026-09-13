'use strict';

/**
 * 打包产物验收。
 *
 * 为什么不满足于「文件存在」：
 *  产物里有两处东西会**静默**失效 ——
 *   1. 内核是独立 node 子进程，打包后 workspace 软链消失，
 *      `require('@deepwork/protocol')` 可能解析不到；
 *   2. 内核若被塞进 asar，外部 node 根本读不了。
 *  这两种情况 electron-builder 都会报告成功，exe 双击后却是黑屏/闪退。
 *  开发者看到「打包成功」，用户看到「应用坏了」。
 *
 *  所以这里真的把内核拉起来、发一次 RPC、等它回话。
 *  文件层面的检查只作为失败时的定位辅助。
 *
 * 用法：
 *   node tools/package-verify.js                 # 检查默认产物 release/win-unpacked
 *   node tools/package-verify.js --dir <目录>
 *   node tools/package-verify.js --launch        # 额外启动打包后的应用并截图（较慢）
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const UNPACKED =
  dirFlag !== -1 && args[dirFlag + 1]
    ? path.resolve(args[dirFlag + 1])
    : path.join(ROOT, 'release', 'win-unpacked');
const LAUNCH = args.includes('--launch');

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('深边AI Work · 打包产物验收');
console.log(`产物目录：${UNPACKED}\n`);

// ── 一、产物结构 ───────────────────────────────────────────────────────────

console.log('结构');

const exePath = path.join(UNPACKED, 'DeepWork.exe');
const asarPath = path.join(UNPACKED, 'resources', 'app.asar');
const coreEntry = path.join(UNPACKED, 'resources', 'core-host', 'dist', 'index.js');
const protocolPkg = path.join(
  UNPACKED,
  'resources',
  'core-host',
  'node_modules',
  '@deepwork',
  'protocol',
  'package.json',
);
const protocolEntry = path.join(
  UNPACKED,
  'resources',
  'core-host',
  'node_modules',
  '@deepwork',
  'protocol',
  'dist',
  'index.js',
);

if (!fs.existsSync(UNPACKED)) {
  console.error(`产物目录不存在：${UNPACKED}\n请先执行 npm run dist:dir -w @deepwork/desktop`);
  process.exit(1);
}

check('可执行文件存在', fs.existsSync(exePath), path.basename(exePath));
check('渲染层已封进 app.asar', fs.existsSync(asarPath));
check('内核产物落在 asar 之外', fs.existsSync(coreEntry), 'resources/core-host/dist/index.js');
check('protocol 依赖已落位', fs.existsSync(protocolPkg) && fs.existsSync(protocolEntry));

/**
 * 反向断言：内核**不应**出现在 asar 里。
 *
 * 如果两份都在，就会留下「到底跑的是哪一份」的歧义 —— 改了一份没生效，
 * 排查起来会非常费劲。显式钉住只有一份。
 */
const asarSize = fs.existsSync(asarPath) ? fs.statSync(asarPath).size : 0;
check(
  'app.asar 体积合理（未混入内核源码与 node_modules）',
  asarSize > 0 && asarSize < 40 * 1024 * 1024,
  `${(asarSize / 1024 / 1024).toFixed(2)} MB`,
);

// ── 二、内核能否真的跑起来 ─────────────────────────────────────────────────

async function runKernel() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-pkg-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-pkg-home-'));

  const child = spawn(process.execPath, [coreEntry], {
    cwd: workspace,
    env: { ...process.env, DEEPWORK_WORKSPACE: workspace, DEEPWORK_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const events = [];
  let settled = false;

  const result = await new Promise((resolve) => {
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: '内核 15 秒内未响应 host.status' }), 15_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (message.method === 'event' && message.params) events.push(message.params);
        if (message.id === 1) {
          clearTimeout(timer);
          finish({ ok: !message.error, result: message.result, error: message.error, events });
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.log(`    [内核 stderr] ${text.split('\n')[0]}`);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, reason: `无法启动内核：${error.message}` });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      finish({ ok: false, reason: `内核提前退出 (code=${code})` });
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'host.status', params: {} })}\n`);
  });

  // 先让它优雅退出再强杀：仅 kill 的话，Windows 上子进程可能仍握着 cwd 的句柄，
  // 紧接着删目录会 EBUSY —— 那是清理问题，不是打包问题，不该污染验收结论。
  child.stdin.end();
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of [workspace, home]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // 清理失败不算失败项：临时目录在系统 temp 下，会自行回收
    }
  }
  return result;
}

console.log('\n内核（用外部 node 直接拉起打包产物里的那一份）');

async function main() {
  const kernel = await runKernel();
  check('内核可被外部 node 启动', kernel.ok, kernel.reason || '');
  check(
    '打包后仍能解析 @deepwork/protocol（返回 host.status）',
    kernel.ok && Boolean(kernel.result?.adapter),
    kernel.result ? `adapter=${kernel.result.adapter} version=${kernel.result.version}` : kernel.reason || '',
  );
  check(
    '内核发出了 host.ready 事件',
    Array.isArray(kernel.events) && kernel.events.some((e) => e.type === 'host.ready'),
    Array.isArray(kernel.events) ? `收到 ${kernel.events.length} 个事件` : '',
  );

  // ── 三、可选：启动打包后的应用并截图 ─────────────────────────────────────

  if (LAUNCH) {
    console.log('\n应用启动（截图验收）');

    const shot = path.join(ROOT, 'artifacts', 'packaged-app.png');
    const logFile = path.join(ROOT, 'artifacts', 'packaged-app.log');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-pkg-launch-'));

    const launchEnv = {
      ...process.env,
      DEEPWORK_CAPTURE: shot,
      DEEPWORK_CAPTURE_DELAY: '6000',
      DEEPWORK_CAPTURE_PROMPT: '看一下这个工程的结构',
      DEEPWORK_WORKSPACE: workspace,
      DEEPWORK_LOG_FILE: logFile,
    };
    /**
     * 清掉 ELECTRON_RUN_AS_NODE。
     *
     * Electron 会把它解释为「以纯 Node 模式运行」：打包后的 exe 直接退出，
     * 连窗口都不建。开发机上这个变量很常见（比如用它跑内核子进程的脚本会设它），
     * 不清掉的话，验收测的是「环境里有这么个变量」，而不是应用本身能不能用。
     */
    delete launchEnv.ELECTRON_RUN_AS_NODE;

    const launchResult = await new Promise((resolve) => {
      const child = spawn(exePath, [], {
        cwd: UNPACKED,
        env: launchEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let log = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => {
        log += c;
      });
      child.stderr.on('data', (c) => {
        log += c;
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ ok: false, reason: '应用 60 秒内未完成截图' });
      }, 60_000);

      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ ok: true, code, log });
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: error.message });
      });
    });

    for (const dir of [workspace]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        // 同上：清理失败不是验收项
      }
    }

    const shotOk = fs.existsSync(shot);
    check(
      '打包后的应用能启动并完成一次截图',
      launchResult.ok && shotOk,
      launchResult.reason || `退出码 ${launchResult.code}`,
    );
    if (shotOk) {
      console.log(`    截图：${shot}`);
    } else {
      /**
       * 打包后的应用是 GUI 子系统程序，stdout 捕获不到 ——
       * 失败时唯一的线索就是它自己落的日志，必须打出来，
       * 否则「截图没产出」这个结果没有任何可行动的信息。
       */
      try {
        const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
        console.log(`    日志 ${logFile}：`);
        for (const line of lines.slice(-15)) console.log(`      ${line}`);
      } catch {
        console.log(`    无日志产出（${logFile}）—— 应用可能在建窗口之前就退出了`);
      }
    }

    const runtimeLine = (launchResult.log || '')
      .split('\n')
      .find((line) => line.includes('运行时') || line.includes('runtime'));
    if (runtimeLine) console.log(`    ${runtimeLine.trim()}`);
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────────

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('验收脚本异常', error);
  process.exit(1);
});
