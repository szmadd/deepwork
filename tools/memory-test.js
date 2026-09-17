'use strict';

/**
 * 三层记忆系统测试 —— 「画像 / 用户级 / 工作区」如何被写入、注入内核、并被看见。
 *
 *   npm run test:memory
 *
 * 四层各自独立断言：
 *   1. store 层：三层增删读、预算超限拒绝、画像读写、每日日志 append-only、30 天归档；
 *   2. context 层：三层分节、截断标记、无记忆返回 null；
 *   3. host 链路（mock 内核）：memory.attached 形状与次序、user.message 原文不改写、
 *      适配器如实收到注入、run 结束后当日日志多一行；
 *   4. RPC 接线：5 个 memory.* 方法注册可用；
 *   5. 内核自主写记忆：memory 工具的契约 / 校验 / 预算闸门，以及 MCP 服务
 *      按 stdio 的真实往返（真握手、真落盘、真读回）；内核补丁注入与顺序。
 *
 * 这条链路最危险的失败形态是「看起来记下了，实际注入的是旧的或被改写的文本」，
 * 所以断言全部落在事件流与适配器收到的真实出口上。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-memory-'));
const home = path.join(root, '.deepwork');
process.env.DEEPWORK_HOME = home;

const {
  MemoryStore,
  PROFILE_BUDGET,
  USER_MEMORY_BUDGET,
  WORKSPACE_NOTES_BUDGET,
  DAILY_LOG_TAIL,
} = require('../packages/core-host/dist/memory/store');
const { buildMemoryContext } = require('../packages/core-host/dist/memory/context');
const { runMemoryRead, runMemoryWrite } = require('../packages/core-host/dist/memory/tools');
const { DeepworkHost } = require('../packages/core-host/dist/host');
const { buildHandlers } = require('../packages/core-host/dist/rpc/stdio-server');
const { buildTimeline } = require('../packages/protocol/dist/reduce');
const {
  MEMORY_MCP_READ_TOOL,
  MEMORY_MCP_SERVER_NAME,
  MEMORY_MCP_WRITE_TOOL,
  MEMORY_WRITE_ARGS,
  MEMORY_WRITE_LAYERS,
  isMemoryWriteLayer,
  memoryReadInputJsonSchema,
  memoryWriteInputJsonSchema,
} = require('../packages/protocol/dist/memory');
const {
  buildMemoryMcpPatch,
  buildRuntimePatch,
  serializeRuntimePatchYaml,
} = require('../packages/core-host/dist/mcp/patch');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ══════════════════════════════════════════════════════════
// 1. store 层
// ══════════════════════════════════════════════════════════
console.log('\n── 记忆存储 ──');

const store = new MemoryStore(home);
const wsA = path.join(root, 'ws-a');
const wsB = path.join(root, 'ws-b');
fs.mkdirSync(wsA, { recursive: true });
fs.mkdirSync(wsB, { recursive: true });

{
  store.setProfile('后端工程师，回答用中文，偏好简洁。PROFILE_MARK');
  check('画像写入后可读回', store.getProfile().includes('PROFILE_MARK'));
  const listed = store.list('profile');
  check(
    '画像以伪条目（id=profile）读出',
    listed.length === 1 && listed[0].id === 'profile' && listed[0].text.includes('PROFILE_MARK'),
  );
  check('画像层拒绝条目式写入', throwsWith(() => store.add('profile', 'x'), 'setProfile'));
  check('remove(profile) 清空画像', store.remove('profile') === true && store.getProfile() === '');
  store.setProfile('后端工程师，回答用中文。PROFILE_MARK');
}

{
  const e1 = store.add('user', '我喜欢用 pnpm。USER_MARK_A');
  store.add('user', '提交信息用中文。USER_MARK_B');
  const listed = store.list('user');
  check(
    '用户级条目增读',
    listed.length === 2 && listed.every((e) => e.layer === 'user' && e.origin === 'user'),
    JSON.stringify(listed.map((e) => e.id)),
  );
  check('用户级条目按 id 删除', store.remove(e1.id) === true && !store.list('user').some((e) => e.id === e1.id));
  check('删除不存在的 id 返回 false', store.remove('m_nope') === false);
  check('空文本拒绝写入', throwsWith(() => store.add('user', '   '), '不能为空'));
  store.add('user', '我喜欢用 pnpm。USER_MARK_A');
}

{
  store.add('workspace', '这个项目用 taro 框架。WS_MARK', { workspace: wsA });
  const inA = store.list('workspace', wsA);
  const inB = store.list('workspace', wsB);
  check('工作区笔记按工作区隔离', inA.length === 1 && inA[0].workspace === path.resolve(wsA) && inB.length === 0);
  check('工作区笔记缺 workspace 拒绝写入', throwsWith(() => store.add('workspace', '孤儿'), 'workspace'));
}

{
  // 预算闸门：填满到接近上限后，超限写入必须被拒绝且给出可行动信息
  const filler = 'x'.repeat(USER_MEMORY_BUDGET - 60);
  store.add('user', filler);
  const overflow = throwsWith(() => store.add('user', 'y'.repeat(100)), '预算');
  check('用户级超预算拒绝并给出可行动信息', overflow, '');
  check('被拒的条目没有落盘', !store.list('user').some((e) => e.text === 'y'.repeat(100)));
  // 清掉填充，恢复后续链路测试的干净状态
  for (const entry of store.list('user')) {
    if (entry.text === filler) store.remove(entry.id);
  }

  // 工作区精选预算同理；wsA 已有笔记，用空的 wsB 验证，避免与隔离用例互相影响
  const wsFiller = 'z'.repeat(WORKSPACE_NOTES_BUDGET - 2);
  store.add('workspace', wsFiller, { workspace: wsB });
  check('工作区精选超预算拒绝', throwsWith(() => store.add('workspace', '再记一点', { workspace: wsB }), '预算'));
  for (const entry of store.list('workspace', wsB)) {
    if (entry.text === wsFiller) store.remove(entry.id);
  }
}

{
  store.appendDailyLog(wsA, '- 2026-01-01T10:00:00Z · 输入：第一条 · 结果：completed');
  store.appendDailyLog(wsA, '- 2026-01-01T10:05:00Z · 输入：第二条 · 结果：failed');
  const tail = store.readTodayLogTail(wsA);
  check(
    '每日日志 append-only（两次写入都在）',
    tail.text.includes('第一条') && tail.text.includes('第二条') && tail.truncated === false,
  );
}

{
  // 归档：构造一个 40 天前的日记文件，读取侧惰性触发按月合并
  const logDir = path.join(store.memoryDir(), 'workspaces', hashOf(wsB), 'log');
  fs.mkdirSync(logDir, { recursive: true });
  const oldFile = path.join(logDir, '2025-01-10.md');
  fs.writeFileSync(oldFile, '- 旧日志内容 ARCHIVE_MARK\n', 'utf8');
  const oldTime = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  fs.utimesSync(oldFile, oldTime, oldTime);
  store.stats(wsB); // 读取即触发归档
  const archive = path.join(store.memoryDir(), 'workspaces', hashOf(wsB), 'archive', '2025-01.md');
  check(
    '超 30 天日记按月归档：原文件删除、归档含内容',
    !fs.existsSync(oldFile) && fs.existsSync(archive) && fs.readFileSync(archive, 'utf8').includes('ARCHIVE_MARK'),
  );
}

// ══════════════════════════════════════════════════════════
// 2. context 层
// ══════════════════════════════════════════════════════════
console.log('\n── 记忆上下文构建 ──');

{
  const emptyStore = new MemoryStore(path.join(root, 'empty-home'));
  const ctx = buildMemoryContext(emptyStore, wsA);
  check(
    '无记忆时 prompt 为 null',
    ctx.prompt === null && ctx.layers.length === 3 && ctx.layers.every((l) => l.entries === 0),
  );
}

{
  const ctx = buildMemoryContext(store, wsA);
  check('注入含画像分节', Boolean(ctx.prompt) && ctx.prompt.includes('用户画像') && ctx.prompt.includes('PROFILE_MARK'));
  check('注入含用户级分节', ctx.prompt.includes('用户级记忆') && ctx.prompt.includes('USER_MARK_A'));
  check('注入含工作区分节', ctx.prompt.includes('精选笔记') && ctx.prompt.includes('WS_MARK'));
  check('注入含今日日志分节', ctx.prompt.includes('今日运行日志') && ctx.prompt.includes('第一条'));
  check(
    'layers 三层齐全且计数正确',
    ctx.layers.find((l) => l.layer === 'profile')?.entries === 1 &&
      ctx.layers.find((l) => l.layer === 'user')?.entries === 2 &&
      ctx.layers.find((l) => l.layer === 'workspace')?.entries === 1,
    JSON.stringify(ctx.layers),
  );
  check('预算在 stat 里可见', ctx.layers.every((l) => l.budget > 0 && typeof l.chars === 'number'));
}

{
  // 画像超注入上限：截断并如实标记
  const bigStore = new MemoryStore(path.join(root, 'big-home'));
  bigStore.setProfile(`开头HEAD\n${'长'.repeat(PROFILE_BUDGET)}\n结尾TAIL`);
  const ctx = buildMemoryContext(bigStore, wsA);
  const stat = ctx.layers.find((l) => l.layer === 'profile');
  check(
    '画像超预算截断并如实标记',
    Boolean(ctx.prompt?.includes('已截断')) && !ctx.prompt.includes('结尾TAIL') && stat?.truncated === true,
  );
}

{
  // 今日日志超尾部上限：只取尾部并标记
  const logStore = new MemoryStore(path.join(root, 'log-home'));
  const ws = path.join(root, 'ws-log');
  fs.mkdirSync(ws, { recursive: true });
  for (let i = 0; i < 200; i += 1) logStore.appendDailyLog(ws, `- 第 ${i} 条 ${'日志'.repeat(10)}`);
  const ctx = buildMemoryContext(logStore, ws);
  check(
    '今日日志取尾部并标记截断',
    Boolean(ctx.prompt?.includes('更早部分已截断')) && ctx.prompt.includes('第 199 条') && !ctx.prompt.includes('第 0 条'),
  );
}

// ══════════════════════════════════════════════════════════
// 3. host 链路（mock 内核）
// ══════════════════════════════════════════════════════════
console.log('\n── host 注入链路 ──');

async function runRound(host, sessionId, text) {
  const events = [];
  host.onEvent((event) => events.push(event));
  host.send({ sessionId, text });
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (events.some((e) => e.type === 'run.completed' || e.type === 'run.failed')) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 90_000) {
        clearInterval(timer);
        reject(new Error('运行超时'));
      }
    }, 50);
  });
  return events;
}

function todayLogLines(homeDir, workspace) {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(homeDir, 'memory', 'workspaces', hashOf(workspace), 'log', `${day}.md`);
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  // host 用独立的家目录（DEEPWORK_HOME 在构造时读取）：第一轮验证「无记忆不发事件」，
  // 不能与 store 段共用 —— 那里留下的条目会让第一轮不再是「无记忆」
  const hostHome = path.join(root, 'host-home');
  const wsHost = path.join(root, 'ws-host');
  fs.mkdirSync(wsHost, { recursive: true });
  process.env.DEEPWORK_HOME = hostHome;

  const host = new DeepworkHost();
  await host.start(wsHost);
  host.setGuard({ mode: 'auto' });
  const session = host.createSession({ workspace: wsHost, title: '记忆链路' });

  {
    const events = await runRound(host, session.id, '第一轮：还没有任何记忆');
    check('无记忆时不发 memory.attached', !events.some((e) => e.type === 'memory.attached'));
  }

  {
    host.setMemoryProfile('后端工程师。HOST_PROFILE_MARK');
    host.addMemory('user', '所有项目用中文提交信息。HOST_USER_MARK');
    host.addMemory('workspace', '本项目部署用 docker compose。HOST_WS_MARK', wsHost);
    const before = todayLogLines(hostHome, wsHost).length;

    const events = await runRound(host, session.id, '第二轮：带着记忆跑');
    const attached = events.find((e) => e.type === 'memory.attached');
    const userMsg = events.find((e) => e.type === 'user.message');
    const runStarted = events.find((e) => e.type === 'run.started');
    check('memory.attached 事件发出', Boolean(attached), JSON.stringify(attached?.layers));
    check(
      'memory.attached 先于 run.started 且 runId 一致',
      Boolean(attached && runStarted) && attached.runId === runStarted.runId && attached.seq < runStarted.seq,
      `attached.seq=${attached?.seq} started.seq=${runStarted?.seq}`,
    );
    check(
      'memory.attached 三层计数正确',
      attached?.layers.find((l) => l.layer === 'profile')?.entries === 1 &&
        attached?.layers.find((l) => l.layer === 'user')?.entries === 1 &&
        attached?.layers.find((l) => l.layer === 'workspace')?.entries === 1,
      JSON.stringify(attached?.layers),
    );
    check('user.message 原文不被注入文本改写', userMsg?.text === '第二轮：带着记忆跑', userMsg?.text);
    const reasoning = events.filter((e) => e.type === 'reasoning.delta').map((e) => e.text).join('');
    check('mock 内核如实确认收到记忆注入', /记忆上下文（\d+ 字符）/.test(reasoning), reasoning.slice(0, 60));
    const timeline = buildTimeline(events);
    check(
      '回放视图含记忆挂载提示',
      timeline.some((item) => item.kind === 'notice' && item.text.includes('已挂载记忆：画像 1 条 · 用户级 1 条 · 工作区 1 条')),
      timeline.filter((i) => i.kind === 'notice').map((i) => i.text).join(' | '),
    );

    // run 结束后当日日志多一行（.then 里追加，轮询等它落盘）
    let after = before;
    for (let i = 0; i < 40 && after !== before + 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = todayLogLines(hostHome, wsHost).length;
    }
    const lastLine = todayLogLines(hostHome, wsHost).at(-1) ?? '';
    check(
      'run 结束后当日日志多一行（时间/输入前80字/结果）',
      after === before + 1 && lastLine.includes('第二轮：带着记忆跑') && lastLine.includes('completed'),
      lastLine,
    );
  }

  await host.stop();

  // ══════════════════════════════════════════════════════════
  // 4. RPC 接线
  // ══════════════════════════════════════════════════════════
  console.log('\n── RPC 接线 ──');

  {
    const rpcHost = new DeepworkHost();
    await rpcHost.start(wsA);
    const handlers = buildHandlers(rpcHost);
    const names = ['memory.list', 'memory.add', 'memory.remove', 'memory.stats', 'memory.setProfile'];
    check('5 个 memory.* 方法全部注册', names.every((name) => typeof handlers[name] === 'function'));

    const stats = await handlers['memory.stats']({ workspace: wsA });
    check('memory.stats 返回三层', Array.isArray(stats) && stats.length === 3);

    const entry = await handlers['memory.add']({ layer: 'user', text: 'RPC 写入的记忆。RPC_MARK' });
    check('memory.add 返回条目', Boolean(entry?.id) && entry.layer === 'user');

    const listed = await handlers['memory.list']({ layer: 'user' });
    check('memory.list 读回该条目', listed.some((item) => item.id === entry.id && item.text.includes('RPC_MARK')));

    const removed = await handlers['memory.remove']({ id: entry.id });
    const afterRemove = await handlers['memory.list']({ layer: 'user' });
    check(
      'memory.remove 删除该条目',
      removed?.ok === true && !afterRemove.some((item) => item.id === entry.id),
    );

    const setOk = await handlers['memory.setProfile']({ text: 'RPC 画像。' });
    const profileListed = await handlers['memory.list']({ layer: 'profile' });
    check(
      'memory.setProfile 生效',
      setOk?.ok === true && profileListed.some((item) => item.id === 'profile' && item.text.includes('RPC 画像')),
    );

    await rpcHost.stop();
  }

  // ══════════════════════════════════════════════════════════
  // 5. 内核自主写记忆（memory 工具）
  // ══════════════════════════════════════════════════════════
  await memoryToolSection();
  memoryPatchSection();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n三层记忆系统测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

/**
 * 段 5：内核自主写记忆。
 *
 * 这条链路最危险的失败形态是「模型说记下了，实际没落盘 / 落到了别的地方」——
 * 所以断言分两半：一半直接压 memory/tools.ts 的校验与预算闸门，
 * 另一半把 MCP 服务按 stdio 真拉起来、真握手、真落盘，再从磁盘读回。
 */
async function memoryToolSection() {
  console.log('\n── 内核自主写记忆（memory 工具）──');

  // 契约：入参表是单一事实来源（描述与 JSON Schema 同源，两处不会分叉）
  const schema = memoryWriteInputJsonSchema();
  check(
    'memory_write 的 JSON Schema 从入参表派生',
    schema.required.join(',') === 'layer,text' &&
      MEMORY_WRITE_ARGS.every((arg) => schema.properties[arg.name]?.description === arg.description),
  );
  check('可写层只有 user / workspace', MEMORY_WRITE_LAYERS.join(',') === 'user,workspace');
  check(
    '画像是工具写入的禁区（修改必须由用户亲手完成）',
    !isMemoryWriteLayer('profile') && !isMemoryWriteLayer('nope') && isMemoryWriteLayer('user'),
  );
  check('read 的 schema 里 layer 可选', !memoryReadInputJsonSchema().required.includes('layer'));

  // 工具实现：校验、预算闸门、origin 标记
  const toolHome = path.join(root, 'tool-home');
  const toolStore = new MemoryStore(toolHome);
  const wsTool = path.join(root, 'ws-tool');
  fs.mkdirSync(wsTool, { recursive: true });

  const writeText = runMemoryWrite(toolStore, { layer: 'user', text: '用户偏好 pnpm。TOOL_MARK' }, wsTool);
  check(
    '工具写入用户级记忆，origin=agent（面板能认出不是用户自己加的）',
    toolStore.list('user').some((item) => item.text.includes('TOOL_MARK') && item.origin === 'agent'),
  );
  check(
    '写入回执带该层用量与预算（模型据此判断快写满了没有）',
    writeText.includes('用户级记忆') && writeText.includes('预算') && writeText.includes('TOOL_MARK'),
    writeText,
  );

  runMemoryWrite(toolStore, { layer: 'workspace', text: '本项目约定：契约先行。WS_TOOL_MARK' }, wsTool);
  check(
    '工作区层写入落到该工作区的 hash 目录',
    fs
      .readFileSync(path.join(toolHome, 'memory', 'workspaces', hashOf(wsTool), 'notes.json'), 'utf8')
      .includes('WS_TOOL_MARK'),
  );

  check(
    '工具拒绝写画像（不依赖调用方记得传对 layer）',
    throwsWith(() => runMemoryWrite(toolStore, { layer: 'profile', text: 'x' }, wsTool), '画像'),
  );
  check(
    '工具拒绝空文本',
    throwsWith(() => runMemoryWrite(toolStore, { layer: 'user', text: '   ' }, wsTool), 'text'),
  );
  check(
    '工具拒绝未知层并说明可选值',
    throwsWith(() => runMemoryWrite(toolStore, { layer: 'nope', text: 'x' }, wsTool), 'layer'),
  );
  check(
    '预算闸门原样透出（记不下就说记不下，不静默截断）',
    throwsWith(
      () => runMemoryWrite(toolStore, { layer: 'user', text: 'x'.repeat(USER_MEMORY_BUDGET + 10) }, wsTool),
      '超出预算',
    ),
  );

  const readAll = runMemoryRead(toolStore, {}, wsTool);
  check(
    '读工具返回三层，且与面板同源',
    readAll.includes('画像') && readAll.includes('TOOL_MARK') && readAll.includes('WS_TOOL_MARK'),
    readAll.split('\n')[0],
  );
  check('读工具可按层过滤', !runMemoryRead(toolStore, { layer: 'user' }, wsTool).includes('WS_TOOL_MARK'));
  check(
    '读工具拒绝未知层',
    throwsWith(() => runMemoryRead(toolStore, { layer: 'nope' }, wsTool), 'layer'),
  );

  // 真实进程往返：MCP 服务按 stdio 真拉起来、真握手、真落盘
  const entry = path.join(__dirname, '..', 'packages', 'core-host', 'dist', 'cli', 'memory-mcp.js');
  if (!fs.existsSync(entry)) {
    check('记忆 MCP 服务入口存在', false, entry);
    return;
  }
  check('记忆 MCP 服务入口存在（补丁里写的就是这个路径）', true, entry);

  const mcpHome = path.join(root, 'mcp-home');
  const mcpWs = path.join(root, 'mcp-ws');
  fs.mkdirSync(mcpWs, { recursive: true });
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, DEEPWORK_HOME: mcpHome, DEEPWORK_WORKSPACE: mcpWs },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => lines.push(line));
  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8');
  });

  const call = async (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const found = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((item) => item && item.id === message.id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`MCP 响应超时（id=${message.id}）；stderr 片段：${stderrText.slice(-200)}`);
  };

  try {
    const init = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'memory-test', version: '0' } },
    });
    check(
      'initialize 回显协议版本并公布 tools 能力',
      init.result?.protocolVersion === '2025-06-18' && Boolean(init.result?.capabilities?.tools),
    );
    check('initialize 公布服务名', init.result?.serverInfo?.name === MEMORY_MCP_SERVER_NAME, init.result?.serverInfo?.name);

    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (list.result?.tools ?? []).map((tool) => tool.name).sort();
    check(
      'tools/list 只列出两个记忆工具（不声明没实现的能力）',
      names.join(',') === [MEMORY_MCP_READ_TOOL, MEMORY_MCP_WRITE_TOOL].sort().join(','),
      names.join(','),
    );
    check(
      '两个工具都带 JSON Schema 入参',
      (list.result?.tools ?? []).every((tool) => tool.inputSchema?.type === 'object'),
    );

    const made = await call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: MEMORY_MCP_WRITE_TOOL, arguments: { layer: 'user', text: 'MCP 写入的记忆。MCP_MARK' } },
    });
    const madeText = made.result?.content?.[0]?.text ?? '';
    check('tools/call 真的落盘并回一句话回执', madeText.includes('已写入用户级记忆'), madeText.split('\n')[0]);
    check(
      '落盘位置与宿主同源（写进 DEEPWORK_HOME/memory）',
      fs.readFileSync(path.join(mcpHome, 'memory', 'user.json'), 'utf8').includes('MCP_MARK'),
    );

    const read = await call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: MEMORY_MCP_READ_TOOL, arguments: {} },
    });
    check('read 工具读到刚写的条目', (read.result?.content?.[0]?.text ?? '').includes('MCP_MARK'));

    const badLayer = await call({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: MEMORY_MCP_WRITE_TOOL, arguments: { layer: 'profile', text: 'x' } },
    });
    check(
      '业务失败按 isError 内容返回（不是 JSON-RPC error，否则模型看不到原因）',
      badLayer.result?.isError === true &&
        !badLayer.error &&
        (badLayer.result?.content?.[0]?.text ?? '').includes('画像'),
      badLayer.result?.content?.[0]?.text,
    );

    const unknown = await call({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'memory_nope', arguments: {} },
    });
    check('未知工具是协议层错误（客户端问了一个不存在的名字）', unknown.error?.code === -32602, JSON.stringify(unknown.error));
    const notImplemented = await call({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
    check('未实现的方法明确报 -32601（不静默挂起）', notImplemented.error?.code === -32601);
  } finally {
    child.kill();
  }
}

/** 段 6：内核补丁（记忆服务注入） */
function memoryPatchSection() {
  console.log('\n── 内核补丁（记忆服务注入）──');
  const entry = path.join(__dirname, '..', 'packages', 'core-host', 'dist', 'cli', 'memory-mcp.js');
  const patch = buildMemoryMcpPatch({
    command: process.execPath,
    entry,
    env: { DEEPWORK_HOME: home, DEEPWORK_WORKSPACE: wsA },
  });
  const item = patch.insert[0];
  check('补丁是一个 insert 条目', Array.isArray(patch.insert) && patch.insert.length === 1);
  check('条目 name 是内核依赖闭包内的 MCP 客户端包名', item.name === '@deepseek-ai/dsh-mcp-client', item.name);
  check('serverName 与契约层一致', item.config.serverName === MEMORY_MCP_SERVER_NAME);
  check('传输是 stdio', item.config.transport === 'stdio');
  check('args 指向记忆 MCP 入口', item.config.args[0] === entry);
  check('入口文件在磁盘上真实存在（否则内核拉起必失败）', fs.existsSync(entry), entry);
  check(
    'env 同时带 HOME 与 WORKSPACE（少了 HOME 会写到另一份文件里去）',
    item.config.env.DEEPWORK_HOME === home && item.config.env.DEEPWORK_WORKSPACE === wsA,
  );

  const builtin = (id, serverName) => ({
    insert: [{ id, name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio', serverName, command: 'node' } }],
  });
  const merged = buildRuntimePatch([], null, builtin('deepwork-browser', 'deepwork_browser'), builtin('deepwork-chart', 'deepwork_chart'), patch);
  check('合并补丁含三项内置服务', Array.isArray(merged) && merged.length === 3, String(merged?.length));
  check(
    '顺序是 图表 → 记忆 → 浏览器（浏览器恒为最后一项）',
    merged.map((entry2) => entry2.insert[0].id).join(',') === 'deepwork-chart,deepwork-memory,deepwork-browser',
    merged.map((entry2) => entry2.insert[0].id).join(','),
  );
  const yaml = serializeRuntimePatchYaml(merged);
  check(
    'YAML 可序列化（两个内置服务的 serverName 都在）',
    yaml.includes('serverName: "deepwork_memory"') && yaml.includes('serverName: "deepwork_chart"'),
  );
}

function throwsWith(fn, keyword) {
  try {
    fn();
  } catch (error) {
    return String(error instanceof Error ? error.message : error).includes(keyword);
  }
  return false;
}

/** 与 store 内部一致的工作区目录名（sha256 前 16 位），仅用于直接读文件断言 */
function hashOf(workspace) {
  return require('node:crypto')
    .createHash('sha256')
    .update(path.resolve(workspace))
    .digest('hex')
    .slice(0, 16);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
