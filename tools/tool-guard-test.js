'use strict';

/**
 * 写工具守卫测试 —— 验证「模型改文件」这条路径的边界与错误信息质量。
 *
 *   npm run test:tools
 *
 * 为什么错误信息也算被测对象：
 *  Agent 的自我修正能力完全依赖工具返回的文本。返回「执行失败」它只能瞎猜；
 *  返回「old_string 在 x.ts 中出现 3 次，不唯一，请扩大上下文」它能立刻改对。
 *  因此这里断言的不是「有没有报错」，而是「报错是否可行动」。
 *
 * 同时覆盖安全边界：无变化的写入不应打扰用户，被拒绝的写入不应落盘，
 * 以及**逐 hunk 授权**这一档 —— 用户只采纳一部分改动时，落盘内容必须正好是那一部分。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-guard-'));
process.env.DEEPWORK_HOME = path.join(root, '.deepwork');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

const { ToolRegistry, createToolContext } = require('../packages/core-host/dist/tools/registry');
const { registerBuiltinTools } = require('../packages/core-host/dist/tools/builtin');
const { Guard } = require('../packages/core-host/dist/security/guard');

const registry = new ToolRegistry();
registerBuiltinTools(registry);
const guard = new Guard();

const results = [];
let approvals = [];

/**
 * 造一个工具上下文。
 * @param outcome 审批结论，默认整体放行；传 { approved, hunks } 可模拟逐 hunk 授权
 */
function makeCtx(outcome = { approved: true }) {
  return createToolContext({
    workspace,
    guard,
    requestApproval: async (input) => {
      approvals.push(input);
      return outcome;
    },
  });
}

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function shorten(text) {
  const line = text.split('\n')[0] ?? '';
  return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}

async function main() {
  const sample = path.join(workspace, 'sample.txt');
  fs.writeFileSync(sample, 'alpha\nbeta\ngamma\nbeta\n', 'utf8');

  console.log('\n深边AI Work · 写工具守卫测试\n');

  // 1. 找不到原文 —— 必须告诉模型「先读文件、注意缩进」
  const notFound = await registry.execute(
    'fs.edit',
    { path: 'sample.txt', old_string: 'delta', new_string: 'x' },
    makeCtx(),
  );
  check(
    '未找到 old_string 时报错可行动',
    !notFound.ok && notFound.output.includes('未找到') && notFound.output.includes('读取'),
    shorten(notFound.output),
  );

  // 2. 匹配不唯一 —— 必须给出出现次数与两条出路
  const ambiguous = await registry.execute(
    'fs.edit',
    { path: 'sample.txt', old_string: 'beta', new_string: 'BETA' },
    makeCtx(),
  );
  check(
    '匹配不唯一时报错可行动',
    !ambiguous.ok && ambiguous.output.includes('2 次') && ambiguous.output.includes('replace_all'),
    shorten(ambiguous.output),
  );

  // 3. 显式 replace_all 应当成功，且差异计数如实反映两处改动
  approvals = [];
  const replaced = await registry.execute(
    'fs.edit',
    { path: 'sample.txt', old_string: 'beta', new_string: 'BETA', replace_all: true },
    makeCtx(),
  );
  const replacedDiff = approvals[0]?.diff;
  check(
    'replace_all 替换全部匹配',
    replaced.ok && fs.readFileSync(sample, 'utf8').includes('BETA\ngamma\nBETA'),
    shorten(replaced.output),
  );
  check(
    '差异计数与替换处数一致',
    Boolean(replacedDiff) && replacedDiff.added === 2 && replacedDiff.removed === 2,
    replacedDiff ? `+${replacedDiff.added} −${replacedDiff.removed}` : '未捕获差异',
  );

  // 4. 越界写入必须在读盘之前就被拦住
  const escape = await registry.execute(
    'fs.write',
    { path: '../../evil.txt', content: 'nope' },
    makeCtx(),
  );
  check(
    '越出工作区的写入被拒绝',
    !escape.ok && escape.output.includes('越出工作区') && !fs.existsSync(path.join(root, 'evil.txt')),
    shorten(escape.output),
  );

  // 5. 内容无变化 —— 不该弹审批，也不该算作一次改动
  approvals = [];
  const unchanged = await registry.execute(
    'fs.write',
    { path: 'sample.txt', content: fs.readFileSync(sample, 'utf8') },
    makeCtx(),
  );
  check(
    '内容无变化时短路且不打扰用户',
    unchanged.ok && unchanged.output.includes('无变化') && approvals.length === 0,
    shorten(unchanged.output),
  );

  // 6. 用户拒绝后必须真的没落盘，且拒绝前用户已经看过差异
  approvals = [];
  const blocked = await registry.execute(
    'fs.write',
    { path: 'blocked.md', content: '# 不该被创建\n' },
    makeCtx({ approved: false }),
  );
  check(
    '被拒绝的写入未落盘',
    !blocked.ok && !fs.existsSync(path.join(workspace, 'blocked.md')),
    shorten(blocked.output),
  );
  check(
    '拒绝前用户已看到差异',
    approvals.length === 1 && Boolean(approvals[0]?.diff) && approvals[0].diff.created === true,
    approvals[0]?.diff ? `新建 ${approvals[0].diff.added} 行` : '未携带差异',
  );

  // 7. 目录被当成文件写入时要说清楚
  fs.mkdirSync(path.join(workspace, 'adir'), { recursive: true });
  const asDir = await registry.execute(
    'fs.write',
    { path: 'adir', content: 'x' },
    makeCtx(),
  );
  check('把目录当文件写入时报错清晰', !asDir.ok && asDir.output.includes('目录'), shorten(asDir.output));

  // ── 逐 hunk 授权 ────────────────────────────────────────────
  // 用一份 40 行的文件改两处、相距足够远，确保差异引擎切出两个独立 hunk。
  const multi = path.join(workspace, 'multi.txt');
  const original = `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
  const target = original.replace('line 5', 'line 5 CHANGED').replace('line 35', 'line 35 CHANGED');
  fs.writeFileSync(multi, original, 'utf8');

  // 8. 两个 hunk 时应开放逐块选择
  approvals = [];
  await registry.execute('fs.write', { path: 'multi.txt', content: target }, makeCtx({ approved: false }));
  const multiDiff = approvals[0]?.diff;
  check(
    '多 hunk 差异被切分成两块',
    Boolean(multiDiff) && multiDiff.hunks.length === 2,
    multiDiff ? `${multiDiff.hunks.length} 块` : '未捕获差异',
  );
  check('多 hunk 时开放逐块选择', approvals[0]?.selectable === true, `selectable=${approvals[0]?.selectable}`);

  // 9. 只采纳第一块 —— 第 35 行的改动绝不能跟着落盘
  approvals = [];
  const firstOnly = await registry.execute(
    'fs.write',
    { path: 'multi.txt', content: target },
    makeCtx({ approved: true, hunks: [0] }),
  );
  const afterFirst = fs.readFileSync(multi, 'utf8');
  check(
    '只采纳第一块时仅该块落盘',
    firstOnly.ok && afterFirst.includes('line 5 CHANGED') && afterFirst.includes('line 35\n'),
    shorten(firstOnly.output),
  );
  check(
    '未采纳的块保持原文，其余行一字未动',
    afterFirst === original.replace('line 5', 'line 5 CHANGED'),
    `与「仅改第 5 行」逐字节比对${afterFirst === original.replace('line 5', 'line 5 CHANGED') ? '一致' : '不一致'}`,
  );
  check('输出如实说明采纳比例', firstOnly.output.includes('1/2'), shorten(firstOnly.output));

  // 10. 只采纳第二块 —— 对称验证，防止「只认第一块」这类实现偏差
  fs.writeFileSync(multi, original, 'utf8');
  approvals = [];
  const secondOnly = await registry.execute(
    'fs.write',
    { path: 'multi.txt', content: target },
    makeCtx({ approved: true, hunks: [1] }),
  );
  check(
    '只采纳第二块时仅该块落盘',
    secondOnly.ok && fs.readFileSync(multi, 'utf8') === original.replace('line 35', 'line 35 CHANGED'),
    shorten(secondOnly.output),
  );

  // 11. 采纳全部 —— 结果必须与整体授权完全一致（不能因为走了部分应用路径而丢东西）
  fs.writeFileSync(multi, original, 'utf8');
  await registry.execute(
    'fs.write',
    { path: 'multi.txt', content: target },
    makeCtx({ approved: true, hunks: [0, 1] }),
  );
  check('采纳全部时与目标内容一致', fs.readFileSync(multi, 'utf8') === target, '逐字节比对');

  // 12. 一个都不采纳 —— 等同于拒绝，不得写成空文件
  fs.writeFileSync(multi, original, 'utf8');
  const noneAccepted = await registry.execute(
    'fs.write',
    { path: 'multi.txt', content: target },
    makeCtx({ approved: true, hunks: [] }),
  );
  check(
    '空选择等同于拒绝且不落盘',
    !noneAccepted.ok && fs.readFileSync(multi, 'utf8') === original,
    shorten(noneAccepted.output),
  );

  // 13. 单 hunk 时不开放逐块选择（选块与全选等价，多一个开关只会添乱）
  fs.writeFileSync(sample, 'one\ntwo\nthree\n', 'utf8');
  approvals = [];
  await registry.execute(
    'fs.edit',
    { path: 'sample.txt', old_string: 'two', new_string: 'TWO' },
    makeCtx({ approved: false }),
  );
  check('单 hunk 时不开放逐块选择', approvals[0]?.selectable === false, `selectable=${approvals[0]?.selectable}`);

  // 14. 不可选却收到 hunk 选择 —— 整体放弃，而不是「尽力挑几块写下去」
  fs.writeFileSync(sample, 'one\ntwo\nthree\n', 'utf8');
  const inconsistent = await registry.execute(
    'fs.edit',
    { path: 'sample.txt', old_string: 'two', new_string: 'TWO' },
    makeCtx({ approved: true, hunks: [0] }),
  );
  check(
    '不可选时收到 hunk 选择则整体放弃',
    !inconsistent.ok && fs.readFileSync(sample, 'utf8') === 'one\ntwo\nthree\n',
    shorten(inconsistent.output),
  );

  const failed = results.filter((item) => !item.ok);
  console.log(
    `\n${failed.length === 0 ? '\u001b[32m全部通过\u001b[0m' : `\u001b[31m${failed.length} 项失败\u001b[0m`} （共 ${results.length} 项）\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('守卫测试异常:', error);
  process.exit(1);
});
