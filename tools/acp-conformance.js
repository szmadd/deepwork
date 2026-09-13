'use strict';

/**
 * ACP 契约一致性测试 —— 证明「我们的客户端符合 Agent Client Protocol」，
 * 而不是「我们把占位字符串换了一组」。
 *
 *   npm run test:acp
 *
 * 为什么需要参考 agent（tools/fixtures/fake-acp-agent.js）：
 * 真实 dsh 要下载完整运行时、要模型凭据，没法进自检。但协议正确性必须可验证，
 * 否则所谓校准毫无证据。于是按 ACP 规格写一个最小 agent 来驱动完整一轮。
 *
 * 这套断言真正要看守的是三件事：
 *  1. **写文件必须过审批网关**。ACP 把 fs/write_text_file 交给客户端执行，
 *     这既是机会也是陷阱 —— 客户端若照单全收，内核就多了一条绕过 diff 审阅的旁路，
 *     用户在界面上看到的审批就成了摆设。
 *  2. **逐 hunk 授权在内核写入路径上同样成立**。只在本工具的写操作上验证过不够，
 *     内核让客户端代写时也要按采纳结果落盘。
 *  3. **工作区边界**。内核给的路径是它自己决定的，越界写入必须由客户端拦下。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HarnessSidecarAdapter } = require('../packages/core-host/dist/adapter/harness-sidecar');
const { buildFileDiff, applySelectedHunks } = require('../packages/core-host/dist/diff');

const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-acp-agent.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findLog(log, kind) {
  return log.find((entry) => entry.kind === kind);
}

/** 跑一个完整场景，返回事件流、内核侧日志与 run 状态 */
async function runScenario(options) {
  const {
    scenario,
    approval,
    before,
    onEvent,
  } = options;

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-acp-'));
  const logFile = path.join(workspace, '.fake-acp.log');
  fs.writeFileSync(path.join(workspace, 'package.json'), '{ "name": "demo" }\n');
  if (before) fs.writeFileSync(path.join(workspace, 'AGENT-NOTES.md'), before);

  process.env.FAKE_ACP_LOG = logFile;
  process.env.FAKE_ACP_SCENARIO = scenario;

  const events = [];
  const approvals = [];
  const adapter = new HarnessSidecarAdapter({
    command: process.execPath,
    args: [FAKE_AGENT],
    workspace,
    model: 'test-model',
    startupTimeoutMs: 15_000,
  });

  const controller = new AbortController();
  let status;
  try {
    const health = await adapter.start();
    events.push({ __health: health });

    status = await adapter.run({
      runId: 'run-1',
      sessionId: 'sess-1',
      text: '梳理一下这个工程',
      attachments: [],
      workspace,
      mode: 'standard',
      model: 'test-model',
      guard: { assess: () => ({ risk: 'safe', reason: '', blocked: false }) },
      tools: {},
      emit: (event) => {
        events.push(event);
        onEvent?.(event, { adapter, controller });
      },
      requestApproval: async (input) => {
        approvals.push(input);
        return typeof approval === 'function' ? approval(input) : approval;
      },
      signal: controller.signal,
    });
  } finally {
    await adapter.stop().catch(() => undefined);
  }

  return { workspace, log: readLog(logFile), events, approvals, status };
}

const APPROVE = { approved: true };
const DENY = { approved: false };

async function main() {
  console.log('\n会话建立与能力协商');

  const allow = await runScenario({ scenario: 'allow', approval: APPROVE });

  const init = findLog(allow.log, 'initialize');
  check('握手发送 protocolVersion=1', init?.params?.protocolVersion === 1, `收到 ${init?.params?.protocolVersion}`);
  check(
    '客户端按规格用 `fs` 键声明代管文件读写（写成 fileSystem 会静默失效）',
    init?.params?.clientCapabilities?.fs?.writeTextFile === true
      && init?.params?.clientCapabilities?.fs?.readTextFile === true,
    JSON.stringify(init?.params?.clientCapabilities),
  );

  const newSession = findLog(allow.log, 'session/new');
  check(
    'session/new 传入绝对 cwd（规格要求 + 越界拦截依赖它）',
    typeof newSession?.params?.cwd === 'string' && path.isAbsolute(newSession.params.cwd),
    newSession?.params?.cwd,
  );
  check(
    'session/new 的 cwd 就是本项目的工作区',
    newSession?.params?.cwd === path.resolve(allow.workspace),
    '与 workspace 一致',
  );

  console.log('\n事件映射（ACP session/update → 归一化事件）');

  const types = allow.events.filter((e) => !e.__health).map((e) => e.type);
  check('轮次以 run.started 开始', types[0] === 'run.started', types[0]);

  const thought = allow.events.find((e) => e.type === 'reasoning.delta');
  check('agent_thought_chunk → reasoning.delta', thought?.text === '先看一下工程结构', thought?.text);

  const toolStarted = allow.events.find((e) => e.type === 'tool.started');
  check('tool_call → tool.started', Boolean(toolStarted), toolStarted?.call?.name);
  check(
    '工具分类映射为风险级别（read → safe）',
    toolStarted?.call?.risk === 'safe',
    `risk=${toolStarted?.call?.risk}`,
  );

  const toolDone = allow.events.find((e) => e.type === 'tool.completed');
  check('tool_call_update(completed) → tool.completed', toolDone?.ok === true, toolDone?.output);
  check(
    '工具输出取自 content 块数组',
    toolDone?.output === '{ "name": "demo" }',
    toolDone?.output,
  );

  // dsh 形状：kind 恒为 other，工具名在 title、入参在 rawInput
  const writeCall = allow.events.find((e) => e.type === 'tool.started' && e.call?.id === 'tc-2');
  check(
    'kind 恒为 other 时改由工具名判风险（write → confirm）',
    writeCall?.call?.risk === 'confirm',
    `name=${writeCall?.call?.name} risk=${writeCall?.call?.risk}`,
  );
  check(
    '工具入参被保留下来（审批弹窗才有东西可看）',
    typeof writeCall?.call?.args?.path === 'string',
    writeCall?.call?.args?.path,
  );
  const nestedDone = allow.events.find((e) => e.type === 'tool.completed' && e.callId === 'tc-2');
  check(
    '工具输出兼容 dsh 的嵌套 content 包装（不是永远空串）',
    nestedDone?.output === '已写入',
    JSON.stringify(nestedDone?.output),
  );

  const deltas = allow.events.filter((e) => e.type === 'message.delta');
  check('两段 message chunk 都映射为 message.delta', deltas.length === 2, `${deltas.length} 段`);

  const completed = allow.events.find((e) => e.type === 'message.completed');
  check(
    '轮次结束时汇总完整文本',
    completed?.text === '已梳理完工程结构：包含三个包与一个壳。',
    completed?.text,
  );

  const runDone = allow.events.filter((e) => !e.__health).at(-1);
  check('stopReason=end_turn → run.completed', runDone?.type === 'run.completed' && runDone?.status === 'completed', `${runDone?.type}/${runDone?.status}`);
  check('run 返回 completed', allow.status === 'completed', allow.status);

  console.log('\n反向请求（内核调用客户端）');

  const promptLog = findLog(allow.log, 'prompt');
  check(
    'session/prompt 用 `prompt` 数组传内容（真实内核会拒绝 content 键）',
    Array.isArray(promptLog?.params?.prompt) && promptLog.params.prompt[0]?.type === 'text',
    JSON.stringify(promptLog?.params).slice(0, 120),
  );

  const permission = findLog(allow.log, 'permission.result');
  check(
    '内核的权限请求由审批网关应答（批准 → allow-once）',
    permission?.result?.outcome?.optionId === 'allow-once',
    JSON.stringify(permission?.result),
  );
  check(
    '权限请求能还原出「哪个工具、动什么」（不是 unknown）',
    allow.approvals.some(
      (a) => a.tool === 'write' && typeof a.subject === 'string' && a.subject.includes('AGENT-NOTES.md'),
    ),
    allow.approvals.map((a) => `${a.tool}/${a.subject}`).join(', '),
  );

  const read = findLog(allow.log, 'read.result');
  check('只读请求直接满足，不惊动用户', read?.ok === true && read?.result?.content?.includes('demo'), read?.ok ? 'content 已回传' : read?.error);
  check(
    '只读请求未产生审批弹窗',
    !allow.approvals.some((a) => a.tool === 'fs.read'),
    `审批次数 ${allow.approvals.length}`,
  );

  const write = findLog(allow.log, 'write.result');
  check('写文件请求被受理', write?.ok === true, write?.error || 'ok');
  check(
    '内核要写入时，审批链路拿到了可审阅的差异',
    allow.approvals.some((a) => a.tool === 'fs.write' && a.diff && a.diff.hunks.length > 0),
    allow.approvals.map((a) => `${a.tool}(${a.diff?.hunks?.length ?? 0} hunk)`).join(', '),
  );

  const onDisk = fs.readFileSync(path.join(allow.workspace, 'AGENT-NOTES.md'), 'utf8');
  check(
    '批准后内容完整落盘',
    onDisk.includes('- 无（本轮已收尾）'),
    `${onDisk.split('\n').length} 行`,
  );

  console.log('\n拒绝与边界');

  const deny = await runScenario({ scenario: 'allow', approval: DENY });
  const denyWrite = findLog(deny.log, 'write.result');
  check('拒绝后内核收到错误而不是静默成功', denyWrite?.ok === false, denyWrite?.error);
  check(
    '拒绝后文件没有被创建',
    !fs.existsSync(path.join(deny.workspace, 'AGENT-NOTES.md')),
    '磁盘上不存在',
  );
  const denyPerm = findLog(deny.log, 'permission.result');
  check(
    '拒绝映射到 reject-once（而不是随便回一个选项）',
    denyPerm?.result?.outcome?.optionId === 'reject-once',
    JSON.stringify(denyPerm?.result),
  );

  const outside = await runScenario({ scenario: 'outside', approval: APPROVE });
  const outsideWrite = findLog(outside.log, 'write.result');
  check(
    '工作区外的写入被拦下',
    outsideWrite?.ok === false && String(outsideWrite?.error).includes('越界'),
    outsideWrite?.error,
  );
  check(
    '越界写入没有真的落盘',
    !fs.existsSync(path.join(path.dirname(outside.workspace), 'OUTSIDE-NOTES.md')),
    '工作区外无文件',
  );

  console.log('\n内核写入路径上的逐 hunk 授权');

  // 与 fake agent 的 partial 内容配套：第一处改第 3 行，第二处删掉末尾那行，
  // 中间隔 6 行公共内容，好让差异引擎把它们判成两个 hunk。
  const before = [
    '# 运行笔记',
    '',
    '- 待补充后续改动',
    '',
    '- 说明一',
    '- 说明二',
    '- 说明三',
    '- 说明四',
    '- 说明五',
    '- 说明六',
    '',
    '- 旧的一行',
    '',
  ].join('\n');
  let capturedDiff = null;
  const partial = await runScenario({
    scenario: 'partial',
    before,
    approval: (input) => {
      capturedDiff = input.diff;
      return { approved: true, hunks: [0] };
    },
  });

  const partialDisk = fs.readFileSync(path.join(partial.workspace, 'AGENT-NOTES.md'), 'utf8');
  const fullDisk = applySelectedHunks(before, capturedDiff);
  const expected = applySelectedHunks(before, capturedDiff, [0]);
  check(
    '磁盘内容 == 逐块应用的结果（独立计算对拍）',
    partialDisk === expected,
    `${partialDisk.split('\n').length} 行逐字节一致`,
  );
  check(
    '逐块授权只写入被采纳的那处：既不是原文，也不是全量',
    partialDisk !== before && partialDisk !== fullDisk,
    `与原文差 ${Math.abs(partialDisk.length - before.length)} 字符，与全量差 ${Math.abs(partialDisk.length - fullDisk.length)} 字符`,
  );
  check(
    '采纳一块与采纳全部产生不同内容（确实走了部分路径）',
    expected !== fullDisk,
    '两种选择结果不同',
  );
  check(
    '多 hunk 的差异被标记可选（界面才会渲染勾选框）',
    capturedDiff !== null && capturedDiff.hunks.length > 1,
    `${capturedDiff?.hunks.length} 处改动`,
  );

  console.log('\n中断');

  let abortCalled = false;
  const aborted = await runScenario({
    scenario: 'allow',
    approval: APPROVE,
    onEvent: (event, { adapter }) => {
      if (event.type === 'tool.completed' && !abortCalled) {
        abortCalled = true;
        adapter.abort(event.runId);
      }
    },
  });
  const cancel = aborted.log.find((e) => e.kind === 'notification' && e.method === 'session/cancel');
  check('abort 发出 session/cancel 通知', Boolean(cancel), cancel ? `sessionId=${cancel.params?.sessionId}` : '未发出');
  check('中断后 run 状态为 aborted', aborted.status === 'aborted', aborted.status);

  console.log('\n未就绪时的行为');

  const missing = new HarnessSidecarAdapter({
    command: process.execPath,
    args: [path.join(__dirname, 'fixtures', 'no-such-agent.js')],
    workspace: os.tmpdir(),
    model: 'test-model',
    startupTimeoutMs: 4_000,
  });
  let failedOk = false;
  let failMessage = '';
  try {
    await missing.start();
  } catch (error) {
    failedOk = true;
    failMessage = error.message;
  } finally {
    await missing.stop().catch(() => undefined);
  }
  check(
    '内核不可用时明确失败，而不是伪装成可用',
    failedOk && /ACP/.test(failMessage),
    failMessage.slice(0, 60),
  );

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    for (const item of results.filter((r) => !r.ok)) console.log(`  [FAIL] ${item.name} — ${item.detail ?? ''}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n测试自身出错：', error);
  process.exit(1);
});
