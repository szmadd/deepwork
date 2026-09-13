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
 *   4. RPC 接线：5 个 memory.* 方法注册可用。
 *
 * 这条链路最危险的失败形态是「看起来记下了，实际注入的是旧的或被改写的文本」，
 * 所以断言全部落在事件流与适配器收到的真实出口上。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
const { DeepworkHost } = require('../packages/core-host/dist/host');
const { buildHandlers } = require('../packages/core-host/dist/rpc/stdio-server');
const { buildTimeline } = require('../packages/protocol/dist/reduce');

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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n三层记忆系统测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
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
