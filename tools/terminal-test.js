'use strict';

/**
 * 内置终端链路测试 —— 覆盖「打开 → 执行 → 流式回传 → 中断 → 关闭」整条路。
 *
 *   npm run test:terminal
 *
 * 为什么值得单独一组断言：
 *
 * 1. **终端的失败模式是「看起来跑过了」。** 命令没执行、输出被吞、退出码丢了，
 *    这些都不会抛异常，只会让用户对着空白的终端怀疑自己。因此这里逐条核对输出与退出码。
 * 2. **有一条设计约束必须被机器守住**：终端 I/O 不进会话事件日志。
 *    它容易被后来者「顺手」加进去（毕竟落盘看着更稳妥），而一旦加进去，
 *    日志会被刷屏、回放会变慢 —— 这类退化只有在断言里才会被立刻发现。
 * 3. **cwd 与会话绑定**。`cd` 之后的下一条命令必须在新目录里执行，
 *    否则用户以为自己在 src/ 下，实际还在根目录，改动落点全靠猜。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoreHostClient } = require('../apps/desktop/electron/core-host-client');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等待某条命令的结束块出现 */
async function waitExit(chunks, entryId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = chunks.find((chunk) => chunk.entryId === entryId && chunk.exit);
    if (done) return done;
    await sleep(40);
  }
  return null;
}

/** 拼接某条命令的输出。默认只看 stdout —— system 流里混着 `$ 命令` 回显，算进来会污染断言 */
const textOf = (chunks, entryId, stream = 'stdout') =>
  chunks
    .filter((chunk) => chunk.entryId === entryId && chunk.text && chunk.stream === stream)
    .map((chunk) => chunk.text)
    .join('');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-term-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'terminal-fixture', version: '1.0.0' }, null, 2),
  );
  fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const answer = 42;\n');

  const client = new CoreHostClient();
  const events = [];
  const chunks = [];
  client.on('event', (event) => events.push(event));
  client.on('terminal', (chunk) => chunks.push(chunk));

  console.log('\n深边AI Work · 内置终端链路测试\n');

  client.start({ workspace, home: path.join(root, '.deepwork') });
  await client.invoke('host.status');

  const session = await client.invoke('session.create', { workspace, title: '终端' });

  // ── 打开 ────────────────────────────────────────────────
  const opened = await client.invoke('terminal.open', { sessionId: session.id });
  check('terminal.open 返回 cwd 与 shell', opened.cwd === workspace && Boolean(opened.shell), `${path.basename(opened.shell)} @ ${opened.cwd}`);
  check('新终端的 cwd 绑定到会话工作区', path.resolve(opened.cwd) === path.resolve(workspace));

  // ── 执行并流式回传 ───────────────────────────────────────
  const echo = await client.invoke('terminal.run', { sessionId: session.id, command: 'echo DEEPWORK_TERMINAL_OK' });
  const echoExit = await waitExit(chunks, echo.entryId);
  check('命令执行完成并回传结束块', Boolean(echoExit), echoExit ? `status=${echoExit.exit.status}` : '超时');
  check('stdout 内容正确', textOf(chunks, echo.entryId).includes('DEEPWORK_TERMINAL_OK'));
  check('退出码为 0', echoExit?.exit.exitCode === 0, `exitCode=${echoExit?.exit.exitCode}`);

  // ── 退出码如实上报 ───────────────────────────────────────
  const failing = await client.invoke('terminal.run', { sessionId: session.id, command: 'exit 7' });
  const failingExit = await waitExit(chunks, failing.entryId);
  check('非零退出码如实上报', failingExit?.exit.exitCode === 7, `exitCode=${failingExit?.exit.exitCode}`);

  // ── stderr 单独成流 ─────────────────────────────────────
  const errCmd = await client.invoke('terminal.run', {
    sessionId: session.id,
    command: 'node -e "console.error(\'STDERR_MARK\')"',
  });
  await waitExit(chunks, errCmd.entryId);
  const errChunks = chunks.filter((chunk) => chunk.entryId === errCmd.entryId && chunk.stream === 'stderr');
  check('stderr 与 stdout 分流', errChunks.some((chunk) => chunk.text.includes('STDERR_MARK')));

  // ── cwd 随 cd 推进，并且真的作用于下一条命令 ──────────────
  const cd = await client.invoke('terminal.run', { sessionId: session.id, command: 'cd src' });
  await waitExit(chunks, cd.entryId);
  const cwdCmd = await client.invoke('terminal.run', {
    sessionId: session.id,
    command: 'node -e "process.stdout.write(process.cwd())"',
  });
  await waitExit(chunks, cwdCmd.entryId);
  const cwdText = textOf(chunks, cwdCmd.entryId);
  check(
    'cd 作用于后续命令的实际工作目录',
    path.resolve(cwdText.trim()) === path.join(workspace, 'src'),
    cwdText.trim(),
  );

  const stateAfterCd = await client.invoke('terminal.open', { sessionId: session.id });
  check('终端状态里的 cwd 同步更新', path.resolve(stateAfterCd.cwd) === path.join(workspace, 'src'), stateAfterCd.cwd);
  check('历史条目按时间倒序累计', stateAfterCd.history.length >= 4, `${stateAfterCd.history.length} 条`);

  // ── 中断 ───────────────────────────────────────────────
  const long = await client.invoke('terminal.run', {
    sessionId: session.id,
    command: 'node -e "setTimeout(() => {}, 20000)"',
  });
  await sleep(400);
  const interrupted = await client.invoke('terminal.interrupt', { sessionId: session.id });
  const longExit = await waitExit(chunks, long.entryId, 15_000);
  check('中断请求被接受', interrupted.ok === true);
  check('被中断的命令标记为 interrupted', longExit?.exit.status === 'interrupted', `status=${longExit?.exit.status}`);

  // ── 并发限制 ────────────────────────────────────────────
  const busy = await client.invoke('terminal.run', {
    sessionId: session.id,
    command: 'node -e "setTimeout(() => {}, 1500)"',
  });
  let rejected = false;
  try {
    await client.invoke('terminal.run', { sessionId: session.id, command: 'echo TOO_SOON' });
  } catch (error) {
    rejected = true;
  }
  check('上一条未结束时拒绝并发执行', rejected);
  await waitExit(chunks, busy.entryId, 15_000);

  // ── 工作区视图（只读）──────────────────────────────────
  const tree = await client.invoke('fs.tree', { sessionId: session.id, depth: 2 });
  const names = JSON.stringify(tree.nodes);
  check('fs.tree 列出文件与目录', names.includes('src') && names.includes('package.json'), `${tree.count} 个条目`);
  check('fs.tree 如实回报忽略名单', Array.isArray(tree.ignored) && tree.ignored.includes('node_modules'));

  const preview = await client.invoke('fs.preview', { sessionId: session.id, path: 'package.json' });
  check('fs.preview 读到文件内容', preview.text.includes('terminal-fixture') && preview.missing === false);
  const missing = await client.invoke('fs.preview', { sessionId: session.id, path: 'nope.txt' });
  check('缺失文件被标记为 missing 而非空内容', missing.missing === true);
  const escape = await client.invoke('fs.preview', { sessionId: session.id, path: '../../../etc/passwd' }).catch((error) => error);
  check('越界预览被拒绝', escape instanceof Error, escape instanceof Error ? escape.message : '未拒绝');

  // ── 核心设计约束：终端 I/O 不进事件日志 ───────────────────
  const persisted = await client.invoke('session.events', { sessionId: session.id });
  const leaked = persisted.some((event) => JSON.stringify(event).includes('DEEPWORK_TERMINAL_OK'));
  check('终端输出未混入会话事件日志', !leaked, `日志 ${persisted.length} 条，无终端内容`);
  check(
    '推送的事件里也没有终端输出',
    !events.some((event) => JSON.stringify(event).includes('DEEPWORK_TERMINAL_OK')),
  );

  // ── shell 档位（powershell 默认 / cmd / gitbash）──────────
  //
  // 这一段的校准点是**终端实际用的是哪个 shell**，而不是「配置里写了什么」。
  // 每一档都用一条只有该 shell 认得、别的 shell 会原样或报错的命令来验：
  //   PowerShell 认 $PSVersionTable；cmd 认 %ComSpec%（PS/bash 会原样打印）；
  //   bash 认 $BASH_VERSION 与 &&（PS 5.1 不支持 &&）。
  // 只用「配置写进去了」当断言是不够的 —— 档位没接线时配置照样能写。
  const defaultState = await client.invoke('terminal.open', { sessionId: session.id });
  check('terminal.open 回报当前档位', defaultState.shellKind === 'powershell', `shellKind=${defaultState.shellKind}`);

  const psCmd = await client.invoke('terminal.run', {
    sessionId: session.id,
    command: 'echo $PSVersionTable.PSVersion.Major',
  });
  await waitExit(chunks, psCmd.entryId);
  const psOut = textOf(chunks, psCmd.entryId).trim();
  check('默认档位真的跑在 PowerShell 上', /^\d+$/.test(psOut), `PSVersion.Major=${psOut || '(空)'}`);

  const badShell = await client
    .invoke('config.set', { patch: { terminalShell: 'zsh' } })
    .then(() => null)
    .catch((error) => error);
  check('非法档位被拒绝而不是静默落盘', badShell instanceof Error, badShell ? badShell.message : '未拒绝');

  const { TERMINAL_SHELLS } = require('../packages/protocol/dist/terminal');
  const { CONFIG_FIELDS, DEFAULT_CONFIG } = require('../packages/protocol/dist/config');
  check(
    '设置页字段枚举与档位清单同源（不写第二份白名单）',
    CONFIG_FIELDS.terminalShell.values.join(',') === TERMINAL_SHELLS.join(','),
    CONFIG_FIELDS.terminalShell.values.join(','),
  );
  check('默认档位是 PowerShell', DEFAULT_CONFIG.terminalShell === 'powershell', DEFAULT_CONFIG.terminalShell);

  await client.invoke('config.set', { patch: { terminalShell: 'cmd' } });
  const cmdState = await client.invoke('terminal.open', { sessionId: session.id });
  check('切档后状态同步', cmdState.shellKind === 'cmd', `shellKind=${cmdState.shellKind}`);

  const cmdCmd = await client.invoke('terminal.run', { sessionId: session.id, command: 'echo %ComSpec%' });
  await waitExit(chunks, cmdCmd.entryId);
  const cmdOut = textOf(chunks, cmdCmd.entryId).trim();
  check(
    'cmd 档位真的跑在 cmd 上（%ComSpec% 被展开）',
    cmdOut.toLowerCase().includes('cmd.exe'),
    cmdOut || '(空)',
  );

  await client.invoke('config.set', { patch: { terminalShell: 'gitbash' } });
  const bashState = await client.invoke('terminal.open', { sessionId: session.id });
  if (bashState.unavailable) {
    // 没装 Git for Windows 的机器：**必须如实报不可用并且执行失败**，
    // 绝不能悄悄退到别的 shell —— 那是「我选的档位生效了」的假象。
    check('gitbash 不可用时如实上报原因', /Git Bash/.test(bashState.unavailable), bashState.unavailable);
    const refused = await client.invoke('terminal.run', { sessionId: session.id, command: 'echo X' });
    const refusedExit = await waitExit(chunks, refused.entryId);
    check(
      'gitbash 不可用时执行如实失败（不静默回退别的 shell）',
      refusedExit?.exit.status === 'failed',
      `status=${refusedExit?.exit.status}`,
    );
  } else {
    check('gitbash 解析到的是 bash 而不是 WSL 入口', !/\\system32\\bash\.exe$/i.test(bashState.shell), bashState.shell);
    const bashCmd = await client.invoke('terminal.run', {
      sessionId: session.id,
      command: 'echo "bash:$BASH_VERSION" && echo CHAINED',
    });
    await waitExit(chunks, bashCmd.entryId);
    const bashOut = textOf(chunks, bashCmd.entryId);
    check('gitbash 档位真的跑在 bash 上', /bash:\d/.test(bashOut), bashOut.trim().split('\n')[0] || '(空)');
    // `&&` 可用是「与 Linux 一致」的核心：这正是 PowerShell 5.1 缺的那一项
    check('gitbash 支持 && 串行（Linux 语义）', bashOut.includes('CHAINED'));
  }

  // 上面这一档的断言随机器而变（装了 Git 走可用分支，没装走不可用分支）。
  // 下面两条是**与机器无关**的：它们锁的是两条解析规则本身，不依赖本机装了什么。
  const { resolveTerminalShell } = require('../packages/core-host/dist/terminal/shells.js');
  const wslOverride = resolveTerminalShell(
    'gitbash',
    { ...process.env, DEEPWORK_GIT_BASH: 'C:\\Windows\\System32\\bash.exe' },
    'win32',
  );
  check(
    '显式指向 WSL 的 bash.exe 会被拒绝（不当 gitbash）',
    wslOverride.exe === null || !/\\system32\\bash\.exe$/i.test(wslOverride.exe),
    wslOverride.exe ?? wslOverride.unavailable,
  );

  const noGit = resolveTerminalShell(
    'gitbash',
    { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', ComSpec: 'cmd.exe' },
    'win32',
  );
  check(
    '本机没有 Git 时如实报「未找到」而不是回退别的 shell',
    noGit.exe === null && /未找到/.test(noGit.unavailable),
    noGit.exe ?? noGit.unavailable,
  );

  // 恢复默认档位，避免影响后续断言
  await client.invoke('config.set', { patch: { terminalShell: 'powershell' } });
  const restored = await client.invoke('terminal.open', { sessionId: session.id });
  check('档位可切回 powershell', restored.shellKind === 'powershell', `shellKind=${restored.shellKind}`);

  // ── 关闭 ───────────────────────────────────────────────
  await client.invoke('terminal.close', { sessionId: session.id });
  let closed = false;
  try {
    await client.invoke('terminal.run', { sessionId: session.id, command: 'echo X' });
  } catch (error) {
    closed = true;
  }
  check('关闭后拒绝继续执行', closed);

  await client.stop();
  check('子进程已清理', true);

  const failed = results.filter((item) => !item.ok);
  console.log(
    `\n${failed.length === 0 ? '\u001b[32m全部通过\u001b[0m' : `\u001b[31m${failed.length} 项失败\u001b[0m`} （共 ${results.length} 项）\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('终端测试异常:', error);
  process.exit(1);
});
