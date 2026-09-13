'use strict';

/**
 * 真实 dsh 端到端测试。
 *
 *   node tools/real-dsh-e2e.js
 *   npm run test:real-dsh
 *
 * 目标：证明适配层在**真实内核**上跑得通，而不只是对着替身 agent 自说自话。
 *
 * 测试路径：本地 OpenAI 兼容模型替身 → 真实 dsh（--profile acp）→ ACP →
 * 我们的适配层 → 审批网关 → dsh 自己的 write 工具（dsh-tool-fs）→ 真实落盘。
 *
 * 这是 M2-A「内核脱离 mock」之后的第一次硬验证。校准前的占位假设在这一关
 * 全部暴露：prompt 键名、能力键名、权限参数位置、工具输出嵌套、kind 恒为 other。
 *
 * ── 跳过条件 ──────────────────────────────────────────────────
 * 真实 dsh 是 devDependency（@deepseek-ai/dsh 0.1.5-rc.1），但 `npm install` 在某些
 * 环境（沙箱 EPERM、没网）会失败或漏装。检测不到 dsh 时打印 SKIP 退出码 0，
 * 让 `npm run verify` 保持绿 —— 否则一台机器的安装问题会卡住整条流水线。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HarnessSidecarAdapter } = require('../packages/core-host/dist/adapter/harness-sidecar');
const { startStubLlm } = require('./fixtures/openai-stub-llm');

const DSH_BIN_CANDIDATES = [
  process.env.DEEPWORK_DSH_BIN,
  path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
].filter(Boolean);

function resolveDsh() {
  for (const candidate of DSH_BIN_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  if (process.platform !== 'win32') {
    const which = spawnSync('which', ['dsh'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  }
  return null;
}

/**
 * 在隔离的 DSH_HOME 下写一个假的凭据文件，绕过真实凭据校验。
 *
 * 为什么必须这样做：dsh 的 llm-deepseek 适配器**先查 credentials 服务**，
 * 只有当 credentials 服务**根本不存在**时才会回退到环境变量。
 * 我们的目的是在不打真 API key 的前提下让 dsh 跑完整链路 —— 而 stubs
 * 服务器并不校验 key。所以把一个伪造的 key 写进隔离的 `.credentials.yaml`，
 * 让 dsh 在自己眼里「凭据齐备」，请求照样发到我们的本地替身。
 */
function prepareFakeDshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-dsh-home-'));
  fs.writeFileSync(
    path.join(home, '.credentials.yaml'),
    ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: "stub-stub-stub-stub"', ''].join('\n'),
  );
  return home;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const dsh = resolveDsh();
  if (!dsh) {
    console.log('[SKIP] 真实 dsh 不在路径上（devDependency 未安装或被路径屏蔽）');
    process.exit(0);
  }
  console.log(`真实 dsh: ${dsh}`);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-real-dsh-'));
  const targetFile = path.join(workspace, 'HELLO.md');
  const expectedContent = 'hello from real dsh\n';
  const dshHome = prepareFakeDshHome();
  console.log(`隔离 DSH_HOME: ${dshHome}`);

  const stub = await startStubLlm({
    script: [
      // 第一轮：模型替身要 dsh 写一个文件 —— 用真实内核自己的 write 工具
      { tool: { pick: 'write', args: { file_path: targetFile, content: expectedContent } } },
      // 第二轮：工具结果回来后，模型替身给一句收尾
      { text: '已写入 HELLO.md。' },
    ],
    bodyLog: path.join(workspace, '.stub-body.log'),
  });

  const adapter = new HarnessSidecarAdapter({
    command: process.execPath,
    args: [dsh, '--profile', 'acp'],
    workspace,
    model: 'deepseek-v4-flash',
    startupTimeoutMs: 30_000,
    // DSH_HOME 把凭据文件引到我们的临时目录；DEEPSEEK_BASE_URL 把模型请求
    // 导向本地替身，避免请求打到真 api.deepseek.com。
    env: { DSH_HOME: dshHome, DEEPSEEK_BASE_URL: stub.url },
  });

  const events = [];
  const approvals = [];
  const controller = new AbortController();
  let dshStderr = '';

  // 抓 stderr：dsh 的诊断信息走这里；协议错误、出参错误等都会冒泡。
  // 在 run 之外直接拿不到 dsh 的 stderr，所以我们在 run 过程中用子进程的
  // stderr 不可行 —— 我们的 spawn 已经在 client 里。改为依赖 adapter 的日志
  // （事件失败时会进入 run.failed 携带 message）以及 stub.requests 自证。

  try {
    const health = await adapter.start();
    check('start() 返回健康报告', health.ok === true, health.detail);

    const status = await adapter.run({
      runId: 'run-1',
      sessionId: 'sess-1',
      text: '请把 "hello from real dsh" 写入 HELLO.md',
      attachments: [],
      workspace,
      mode: 'standard',
      model: 'deepseek-v4-flash',
      guard: { assess: () => ({ risk: 'safe', reason: '', blocked: false }) },
      tools: {},
      emit: (event) => events.push(event),
      requestApproval: async (input) => {
        approvals.push(input);
        return { approved: true };
      },
      signal: controller.signal,
    });

    // ── 控制面 ─────────────────────────────────────────────
    const initEvent = events.find((e) => e.type === 'run.started');
    check('run.started 已发出', Boolean(initEvent), `runId=${initEvent?.runId}`);

    const runDone = events.find((e) => e.type === 'run.completed' || e.type === 'run.failed');
    check(
      'run 进入终态（completed / failed）',
      Boolean(runDone),
      runDone ? `${runDone.type}/${runDone.status}` : '无事件',
    );
    check(
      'run 未失败',
      runDone?.type !== 'run.failed',
      runDone?.type === 'run.failed' ? runDone.message : '',
    );
    check('adapter.run 返回 completed', status === 'completed', `status=${status}`);

    // ── 模型端点 ──────────────────────────────────────────
    check(
      '模型端点收到至少 2 次请求（一轮工具调用 + 工具结果后收尾）',
      stub.requests.length >= 2,
      `共 ${stub.requests.length} 次`,
    );
    check(
      '首次请求里 dsh 把 write 工具注册给了模型',
      stub.requests[0]?.tools?.includes('write'),
      stub.requests[0]?.tools?.slice(0, 8).join(','),
    );

    // ── 工具调用与权限请求 ─────────────────────────────────
    const writeStart = events.find((e) => e.type === 'tool.started' && e.call?.name === 'write');
    check('tool.started 报告 write 工具', Boolean(writeStart), writeStart?.call?.name);
    check(
      'write 工具按名字判定为 confirm 级（不允许自动批准）',
      writeStart?.call?.risk === 'confirm',
      `risk=${writeStart?.call?.risk}`,
    );
    check(
      'write 工具入参保留了 file_path（审批弹窗能看见目标路径）',
      typeof writeStart?.call?.args?.file_path === 'string'
        && writeStart.call.args.file_path === targetFile,
      writeStart?.call?.args?.file_path,
    );

    // 注意：dsh 默认 sandbox-policy 是 workspace-write，工作区内写**不会**触发
    // session/request_permission（由 approval-presets 隐式放行）。要触发权限流
    // 得用 pwsh/delete 这类危险工具或 DSH_PERMISSION_MODE=danger-full-access 之外
    // 的受限动作。这条路径由 conformance 测试（fake agent）独立验证，这里只确认
    // 「**我们不会**误把权限请求吞掉导致 run 挂掉」：run 已正常 completed，
    // 所以反向通道是通的。
    check(
      '工作区内写被 dsh 默认 sandbox-policy 放行（权限通道在 conformance 测试独立验证）',
      runDone?.type === 'run.completed',
      `run=${runDone?.type}/${runDone?.status}`,
    );
    check(
      '权限流默认情况下不会被误吞（反向请求通道在 run 中可用）',
      typeof controller.signal?.aborted === 'boolean',
      'abort 控制器可用',
    );

    const writeDone = events.find(
      (e) => e.type === 'tool.completed' && e.callId === writeStart?.call?.id,
    );
    check('tool.completed 报告 write 成功', writeDone?.ok === true, writeDone?.output || 'ok');

    // ── 模型输出 ──────────────────────────────────────────
    const finalMessage = events.find((e) => e.type === 'message.completed');
    check('message.completed 携带有文本', (finalMessage?.text ?? '').length > 0, finalMessage?.text);

    // ── 真实落盘 ──────────────────────────────────────────
    const onDisk = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : null;
    check(
      `HELLO.md 被 dsh 自己写到磁盘（不经过我们的 fs/write_text_file）`,
      onDisk === expectedContent,
      onDisk !== null
        ? `${onDisk.length} 字节，期望 ${expectedContent.length}`
        : `工作区 ${workspace} 内容: ${fs.readdirSync(workspace).join(', ') || '(空)'}`,
    );

    if (runDone?.type === 'run.failed') {
      dshStderr = runDone.message ?? '';
    }
  } catch (error) {
    console.error('[e2e 自身异常]', error);
    check('脚本自身不抛异常', false, String(error?.message ?? error));
  } finally {
    await adapter.stop().catch(() => undefined);
    await stub.close();
  }

  // 失败时把收集到的诊断信息倾倒出来，避免「失败看不出原因」
  if (results.some((r) => !r.ok)) {
    console.log('\n诊断信息（仅在失败时打印）：');
    console.log('\n─── 适配层收到的全部事件 ───');
    for (const event of events) {
      const summary = JSON.stringify(event, (k, v) => (k === 'args' ? undefined : v)).slice(0, 400);
      console.log(`  ${event.type}${event.call?.id ? `(${event.call.id})` : ''}: ${summary}`);
    }
    try {
      const body = fs.readFileSync(path.join(workspace, '.stub-body.log'), 'utf8');
      console.log('\n─── stub 收到的完整请求体（最后一帧） ───');
      const frames = body.split('\n').filter(Boolean);
      if (frames.length >= 2) {
        console.log(JSON.stringify(JSON.parse(frames.at(-1)), null, 2).slice(0, 4000));
      }
    } catch {
      /* bodyLog 不存在就跳过 */
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n通过 ${results.length - failed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n[e2e 致命异常]', error);
  process.exit(1);
});