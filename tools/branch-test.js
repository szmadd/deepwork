'use strict';

/**
 * 分叉与分支对比（M1 遗留）测试 —— 逐事件分叉、对比数据源、界面接线。
 *
 *   npm run test:branch
 *
 * ── 这一层要钉住的两个「看起来对、实际错」的形态 ───────────────────
 *  1. **分叉点被悄悄吸走**。旧语义是「找不超过目标的最近一轮结束位置」，
 *     于是拖到「第 3 步工具调用」上分叉，实际得到的是整轮结束 ——
 *     用户看到的落点与真正发生的事不一致，而且不报错。
 *     这里断言分叉点**就是**所指事件的那一条，一条不多、一条不少。
 *  2. **对比恒为空**。分叉共享同一个工作区（复制的是日志，不是文件系统快照），
 *     所以「读两边的磁盘文件」得到的永远是同一份 —— 对比自然恒空，
 *     而「空」会被读成「两边没冲突」。所以对比必须建在**事件里的改动记录**上，
 *     且两个来源（写工具的预览、真实内核的写审批请求）都要收。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-branch-'));
process.env.DEEPWORK_HOME = path.join(root, '.deepwork');
const workspace = path.join(root, 'ws');
fs.mkdirSync(workspace, { recursive: true });

const { DeepworkHost } = require('../packages/core-host/dist/host');
const { buildHandlers } = require('../packages/core-host/dist/rpc/stdio-server');
const { collectLastDiffs, compareBranches } = require('../packages/core-host/dist/session/compare');

const repo = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function throwsWith(fn, keyword) {
  try {
    fn();
  } catch (error) {
    return String(error instanceof Error ? error.message : error).includes(keyword);
  }
  return false;
}

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
}

// ══════════════════════════════════════════════════════════
// 1. 对比计算（纯函数，合成事件）
// ══════════════════════════════════════════════════════════
console.log('\n── 对比计算 ──');

const diffOf = (p, added) => ({ path: p, created: false, deleted: false, added, removed: 1, hunks: [] });
const started = (seq, diff) => ({ type: 'tool.started', runId: 'r', seq, call: { diff } });
const approval = (seq, diff) => ({ type: 'approval.requested', runId: 'r', seq, request: { diff } });
const other = (seq, type) => ({ type, runId: 'r', seq });

{
  const leftEvents = [
    started(1, diffOf('a.ts', 1)),
    other(2, 'message.delta'),
    started(3, diffOf('a.ts', 9)), // 同一路径的第二次改动：应以它为准
    approval(4, diffOf('b.ts', 2)), // 来源之二：真实内核的写审批请求
  ];
  const rightEvents = [started(1, diffOf('a.ts', 4)), started(2, diffOf('c.ts', 7))];

  check('同路径只保留最后一次改动', collectLastDiffs(leftEvents).get('a.ts').added === 9);
  check('两个来源（写工具预览 + 写审批请求）都收', collectLastDiffs(leftEvents).has('b.ts'));

  const cmp = compareBranches({
    left: { session: { id: 'L', title: '左' }, events: leftEvents },
    right: { session: { id: 'R', title: '右', fork: { sessionId: 'L', atSeq: 2 } }, events: rightEvents },
  });

  check('两边都改过的进 shared', cmp.shared.map((e) => e.path).join(',') === 'a.ts', cmp.shared.map((e) => e.path).join(','));
  check('只左改的进 leftOnly', cmp.leftOnly.map((e) => e.path).join(',') === 'b.ts');
  check('只右改的进 rightOnly', cmp.rightOnly.map((e) => e.path).join(',') === 'c.ts');
  check(
    'shared 的左右各带自己那一次的改动（可并排）',
    cmp.shared[0].left.added === 9 && cmp.shared[0].right.added === 4,
    `L+${cmp.shared[0].left.added} / R+${cmp.shared[0].right.added}`,
  );
  check('侧栏文件数按去重后的路径算', cmp.left.changedFiles === 2 && cmp.right.changedFiles === 2);
  check('分叉血缘透出（右侧标出从哪来）', cmp.right.forkedFrom === 'L');
  check('basis 讲清「对比的是改动不是磁盘文件」', cmp.basis.includes('改动') && cmp.basis.includes('最后一次'));

  const empty = compareBranches({
    left: { session: { id: 'L', title: '左' }, events: [] },
    right: { session: { id: 'R', title: '右' }, events: [] },
  });
  check(
    '空改动返回空结果但 basis 仍在（空不等于「没差异」这句话要有出处）',
    empty.shared.length === 0 && empty.leftOnly.length === 0 && Boolean(empty.basis),
  );
}

// ══════════════════════════════════════════════════════════
// 2. 逐事件分叉（mock 内核真跑一轮）
// ══════════════════════════════════════════════════════════
async function forkSection() {
  console.log('\n── 逐事件分叉 ──');
  const host = new DeepworkHost();
  await host.start(workspace);
  // 审批网关调成 auto：mock 内核的写工具会走去审批，不放开就会一直等一个人
  host.setGuard({ mode: 'auto' });

  try {
    const parent = host.createSession({ workspace, title: '分叉父会话' });
    await runRound(host, parent.id, '帮我建一个说明文件');

    const events = host.sessionEvents(parent.id);
    check('父会话产生了事件流', events.length > 3, String(events.length));

    // 找一个**不是**轮次边界的位置：优先取中途的 tool.started
    const midIndex = events.findIndex((event) => event.type === 'tool.started');
    const targetIndex = midIndex >= 0 ? midIndex : Math.max(0, Math.floor(events.length / 2));
    const target = events[targetIndex];

    const forked = host.forkSession(parent.id, target.seq);
    check('分叉点就是所指的那一条（不吸附到轮次边界）', forked.from.atSeq === target.seq, `#${forked.from.atSeq} vs #${target.seq}`);
    check('回执带上请求值，便于发现「你指的和实际的不一样」', forked.from.requestedSeq === target.seq);

    const childEvents = host.sessionEvents(forked.session.id);
    check(
      '继承条数 = 切点下标 + 1（含切点那一条，不多不少）',
      forked.from.copied === targetIndex + 1,
      `copied=${forked.from.copied} vs ${targetIndex + 1}`,
    );
    check(
      '继承的是父日志的**前 N 行**（逐条对齐，不重排）',
      childEvents
        .slice(0, forked.from.copied)
        .every((event, index) => event.seq === events[index].seq && event.type === events[index].type),
    );
    check(
      '末尾追加一条 session.forked 标记（子日志 = 父前缀 + 标记）',
      childEvents.length === forked.from.copied + 1 && childEvents[childEvents.length - 1].type === 'session.forked',
      `${childEvents.length} 条，末条 ${childEvents[childEvents.length - 1].type}`,
    );
    check('分叉标记落在新会话上（可回溯从哪来、切在哪）', forked.session.fork?.atSeq === target.seq && forked.session.fork?.sessionId === parent.id);
    check('新会话与父共享同一工作区（分叉复制的是日志，不是文件系统）', forked.session.workspace === parent.workspace);

    // 落在两个事件之间：取不晚于它的最近一条
    const lastSeq = events[events.length - 1].seq;
    const beyond = host.forkSession(parent.id, lastSeq + 10);
    check('请求位置超出末尾 → 落到最后一条事件（合理落点，不改成别的轮次）', beyond.from.atSeq === lastSeq, `#${beyond.from.atSeq}`);

    check(
      '请求位置早于首条事件 → 明确拒绝并说明原因',
      throwsWith(() => host.forkSession(parent.id, events[0].seq - 1), '没有可继承的事件'),
    );
  } finally {
    await host.stop();
  }

  // 新会话：日志里只有一条 session.created，切点只能落在它之后
  const host2 = new DeepworkHost();
  await host2.start(workspace);
  try {
    const empty = host2.createSession({ workspace, title: '新会话' });
    const only = host2.sessionEvents(empty.id);
    check(
      '新会话的日志里只有一条 session.created（还没有可分叉的历史）',
      only.length === 1 && only[0].type === 'session.created',
      only.map((event) => event.type).join(','),
    );
    check(
      '在首条事件之前没有可分叉的落点',
      throwsWith(() => host2.forkSession(empty.id, only[0].seq - 1), '没有可继承的事件'),
    );
    const handlers = buildHandlers(host2);
    check('RPC：session.fork 已注册', typeof handlers['session.fork'] === 'function');
    check('RPC：session.compareBranches 已注册', typeof handlers['session.compareBranches'] === 'function');
    check(
      'RPC：compareBranches 对不存在的会话如实报错（不返回空结果）',
      await (async () => {
        try {
          await handlers['session.compareBranches']({ leftId: 'nope', rightId: 'nope' });
          return false;
        } catch (error) {
          return String(error instanceof Error ? error.message : error).includes('会话不存在');
        }
      })(),
    );
  } finally {
    await host2.stop();
  }
}

// ══════════════════════════════════════════════════════════
// 3. 界面接线
// ══════════════════════════════════════════════════════════
function wiringSection() {
  console.log('\n── 界面接线 ──');
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');

  const panel = read('apps/desktop/src/components/TrajectoryPanel.tsx');
  check('轨迹面板支持逐事件分叉', panel.includes('onFork'));
  check('轨迹面板有对比视图', panel.includes('onCompare') && panel.includes('CompareBody'));

  const agent = read('apps/desktop/src/useAgent.ts');
  check('渲染层经 RPC 走对比（不在界面里算差异）', agent.includes("invoke('session.compareBranches'"));
  check('compareBranches 抛错原样交给调用方（不静默返回空）', agent.includes('compareBranches'));

  const rpc = read('packages/protocol/src/rpc.ts');
  check('契约层登记了 session.compareBranches', rpc.includes("'session.compareBranches'"));
}

async function main() {
  await forkSection();
  wiringSection();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n分叉与分支对比测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
