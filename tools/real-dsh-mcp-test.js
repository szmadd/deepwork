'use strict';

/**
 * 真实 dsh + 真实 MCP server 的连接器端到端测试。
 *
 *   node tools/real-dsh-mcp-test.js
 *   npm run test:real-dsh-mcp
 *
 * 测试路径：本地 OpenAI 兼容模型替身（第一轮返回精确工具名 mcp__fake__echo）
 *   → 真实 dsh（--profile acp --patch kernel.patch.yml）
 *   → dsh-mcp-client 插件拉起 tools/fixtures/fake-mcp-server.js（真实 stdio MCP）
 *   → 工具注册为 mcp__fake__echo → 模型调用路由到 fake server → 结果带回。
 *
 * 这里替掉的只有模型与「外部工具提供方」：dsh、插件加载、MCP 协议栈、ACP、
 * 适配层全是真的。--patch 补丁文件由生产代码路径生成
 * （buildConnectorPatch + serializeConnectorPatchYaml + HarnessSidecarAdapter
 * 的 patchFile 选项），不是测试里另写一份。
 *
 * ── 跳过条件 ──────────────────────────────────────────────────
 * 与 tools/real-dsh-e2e.js 同一条纪律：检测不到 dsh 时打印 SKIP 退出码 0。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HarnessSidecarAdapter } = require('../packages/core-host/dist/adapter/harness-sidecar');
const { buildConnectorPatch, serializeConnectorPatchYaml } = require('../packages/core-host/dist/mcp/patch');
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

/** 与 real-dsh-e2e.js 同一招：隔离 DSH_HOME + 假凭据，让 dsh「凭据齐备」但请求打到本地替身 */
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
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const dsh = resolveDsh();
  if (!dsh) {
    console.log('[SKIP] 真实 dsh 不在路径上（devDependency 未安装或被路径屏蔽）');
    process.exit(0);
  }
  console.log(`真实 dsh: ${dsh}`);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-real-mcp-'));
  const dshHome = prepareFakeDshHome();
  const fakeServer = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

  // 补丁文件走生产代码路径生成：清单 → 补丁对象 → YAML → 落盘
  const patch = buildConnectorPatch([
    { name: 'fake', command: process.execPath, args: [fakeServer], enabled: true },
  ]);
  const patchFile = path.join(workspace, 'connectors.patch.yml');
  fs.writeFileSync(patchFile, serializeConnectorPatchYaml(patch), 'utf8');
  console.log(`连接器补丁: ${patchFile}\n${fs.readFileSync(patchFile, 'utf8')}`);

  const stub = await startStubLlm({
    script: [
      // 第一轮：精确名优先 —— pick 直接用注册后的公开工具名（M2-B 的教训：
      // 模糊词边界匹配会命中错的工具，这里目标名是已知的，精确名最干净）
      { tool: { pick: 'mcp__fake__echo', args: { text: 'ping-mcp' } } },
      // 第二轮：工具结果回来后收尾
      { text: 'echo 完成。' },
    ],
    bodyLog: path.join(workspace, '.stub-body.log'),
  });

  const adapter = new HarnessSidecarAdapter({
    command: process.execPath,
    args: [dsh, '--profile', 'acp'],
    workspace,
    model: 'deepseek-v4-flash',
    startupTimeoutMs: 60_000, // 插件要拉起 MCP server 并做首轮 tools/list，比纯启动慢
    patchFile,
    env: { DSH_HOME: dshHome, DEEPSEEK_BASE_URL: stub.url },
  });

  const events = [];
  const controller = new AbortController();

  try {
    const health = await adapter.start();
    check('start() 返回健康报告（含 MCP 插件加载）', health.ok === true, health.detail);

    const status = await adapter.run({
      runId: 'run-1',
      sessionId: 'sess-1',
      text: '调用 echo 工具回显 ping-mcp',
      attachments: [],
      workspace,
      mode: 'standard',
      model: 'deepseek-v4-flash',
      guard: { assess: () => ({ risk: 'safe', reason: '', blocked: false }) },
      tools: {},
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
      signal: controller.signal,
    });

    const runDone = events.find((e) => e.type === 'run.completed' || e.type === 'run.failed');
    check('run 进入终态且未失败', runDone?.type === 'run.completed', runDone ? `${runDone.type}/${runDone.status ?? ''} ${runDone.message ?? ''}` : '无事件');
    check('adapter.run 返回 completed', status === 'completed', `status=${status}`);

    // 模型端点：dsh 应把 fake server 的工具注册成 mcp__fake__echo
    check(
      '首次请求里 dsh 把 mcp__fake__echo 注册给了模型',
      stub.requests[0]?.tools?.includes('mcp__fake__echo'),
      stub.requests[0]?.tools?.filter((t) => t.startsWith('mcp__')).join(',') || '(无 mcp__ 工具)',
    );

    // 工具调用经 ACP 事件流回来，标题保留完整工具名
    const toolStart = events.find((e) => e.type === 'tool.started' && String(e.call?.name).includes('mcp__fake__echo'));
    check('tool.started 标题含 mcp__fake__echo', Boolean(toolStart), toolStart?.call?.name);
    check('mcp__ 工具分级为 confirm（不自动批准）', toolStart?.call?.risk === 'confirm', `risk=${toolStart?.call?.risk}`);

    // 结果带回：fake server 回显的文本出现在 tool.completed 的输出里
    const toolDone = events.find((e) => e.type === 'tool.completed' && e.callId === toolStart?.call?.id);
    check('tool.completed 携回 fake server 的回显', toolDone?.ok === true && String(toolDone?.output ?? '').includes('echo:ping-mcp'), String(toolDone?.output ?? '').slice(0, 120));

    // 模型真的发起了这次工具调用（第二轮请求带 tool 结果）
    check('模型替身收到工具结果后的第二轮请求', stub.requests.length >= 2, `共 ${stub.requests.length} 次`);
  } catch (error) {
    console.error('[e2e 自身异常]', error);
    check('脚本自身不抛异常', false, String(error?.message ?? error));
  } finally {
    await adapter.stop().catch(() => undefined);
    await stub.close();
  }

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
      if (frames.length >= 1) {
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
