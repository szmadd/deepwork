'use strict';

/**
 * 技能上下文注入测试 —— 「已安装且启用的技能」如何变成内核本轮看到的内容。
 *
 *   npm run test:skillctx
 *
 * 两层各自独立断言：
 *   1. buildSkillContext 单元：摘要注入、/显式调用、截断、损坏跳过、停用排除；
 *   2. host 链路（mock 内核）：skill.attached 事件形状与次序、user.message 原文不被
 *      改写、适配器如实收到注入文本、停用后下一轮立即不再挂载。
 *
 * 这条链路最危险的失败形态是「看起来挂了技能，实际注入的是旧清单或改写过的文本」，
 * 所以断言全部落在「事件流里记录的」与「适配器收到的」两个真实出口上。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-skillctx-'));
const home = path.join(root, '.deepwork');
process.env.DEEPWORK_HOME = home;

const {
  buildSkillContext,
  SKILL_BODY_LIMIT,
  SKILL_CONTEXT_LIMIT,
} = require('../packages/core-host/dist/skills/context');
const { SkillStore } = require('../packages/core-host/dist/skills/store');
const { DeepworkHost } = require('../packages/core-host/dist/host');
const { buildTimeline } = require('../packages/protocol/dist/reduce');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function makeSkill(dir, name, description, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\ntriggers:\n  - 触发词${name}\n---\n\n${body}\n`,
    'utf8',
  );
  return dir;
}

// ══════════════════════════════════════════════════════════
// 1. buildSkillContext 单元
// ══════════════════════════════════════════════════════════
console.log('\n── 技能上下文构建 ──');

const store = new SkillStore(home);

{
  const empty = buildSkillContext(store, '随便聊聊');
  check('无技能时不产生注入', empty.prompt === null && empty.attached.length === 0);
}

store.install(makeSkill(path.join(root, 'src-alpha'), 'alpha-skill', '甲技能', '甲的正文BODY_ALPHA。'));
store.install(makeSkill(path.join(root, 'src-beta'), 'beta-skill', '乙技能', '乙的正文BODY_BETA。'));
store.toggle('beta-skill', false);

{
  const ctx = buildSkillContext(store, '帮我处理一下');
  check('摘要含名称与描述', Boolean(ctx.prompt) && ctx.prompt.includes('alpha-skill') && ctx.prompt.includes('甲技能'));
  check('摘要含触发提示', ctx.prompt.includes('触发词alpha-skill'));
  check(
    '摘要含 SKILL.md 绝对路径',
    ctx.prompt.includes(path.join(home, 'skills', 'alpha-skill', 'SKILL.md')),
  );
  check('摘要不含正文（正文按需由内核自取）', !ctx.prompt.includes('BODY_ALPHA'));
  check(
    'attached 标记为摘要注入',
    ctx.attached.length === 1 && ctx.attached[0].explicit === false && ctx.attached[0].bodyChars === 0,
    JSON.stringify(ctx.attached),
  );
  check('停用的技能不进上下文', !ctx.prompt.includes('beta-skill') && !ctx.prompt.includes('BODY_BETA'));
}

{
  const ctx = buildSkillContext(store, '/alpha-skill 按规矩来');
  const alpha = ctx.attached.find((s) => s.name === 'alpha-skill');
  check(
    '显式调用注入全文',
    Boolean(alpha?.explicit) && alpha.bodyChars > 0 && ctx.prompt.includes('BODY_ALPHA'),
    `explicit=${alpha?.explicit} bodyChars=${alpha?.bodyChars}`,
  );
  check('显式调用不截断正常长度正文', alpha.truncated === false);
}

{
  const ctx = buildSkillContext(store, '/nope-skill 不存在');
  check(
    '显式调用未安装技能：如实提示而非静默',
    ctx.prompt.includes('/nope-skill') && ctx.prompt.includes('未安装或已停用'),
  );
  check('未命中时不产生 explicit 条目', ctx.attached.every((s) => !s.explicit));
}

{
  // 装一个正文超长的技能，验证截断如实标记
  const bigBody = `开头标记HEAD\n${'长'.repeat(SKILL_BODY_LIMIT * 2)}\n结尾标记TAIL`;
  store.install(makeSkill(path.join(root, 'src-big'), 'big-skill', '长正文', bigBody));
  const ctx = buildSkillContext(store, '/big-skill 来');
  const big = ctx.attached.find((s) => s.name === 'big-skill');
  check(
    '超长正文截断并如实标记',
    Boolean(big?.truncated) && big.bodyChars === SKILL_BODY_LIMIT,
    `truncated=${big?.truncated} bodyChars=${big?.bodyChars}`,
  );
  check('截断后正文不含结尾标记', !ctx.prompt.includes('结尾标记TAIL'));
  check('整段上下文受总量上限约束', ctx.prompt.length <= SKILL_CONTEXT_LIMIT + 100, `length=${ctx.prompt.length}`);
}

{
  // 安装后把 SKILL.md 改坏：上下文仍要建得起来，坏技能记名跳过
  const brokenPath = path.join(home, 'skills', 'big-skill', 'SKILL.md');
  fs.writeFileSync(brokenPath, '没有 frontmatter 的内容', 'utf8');
  const ctx = buildSkillContext(store, '继续');
  check('损坏技能记名跳过', ctx.skipped.includes('big-skill'), ctx.skipped.join(','));
  check('损坏不阻断其余技能注入', ctx.prompt.includes('alpha-skill'));
  fs.rmSync(path.join(home, 'skills', 'big-skill'), { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════
// 2. host 链路（mock 内核）
// ══════════════════════════════════════════════════════════
console.log('\n── host 注入链路 ──');

async function runRound(host, sessionId, text) {
  const events = [];
  const off = (event) => events.push(event);
  host.onEvent(off);
  // 写工具在 auto 档自动放行，无需应答审批
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

async function main() {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const host = new DeepworkHost();
  // host 内部自建 SkillStore，与上面单元段共用同一个 DEEPWORK_HOME
  await host.start(workspace);
  host.setGuard({ mode: 'auto' });
  const session = host.createSession({ workspace, title: '技能链路' });

  {
    const events = await runRound(host, session.id, '看一下这个工作区');
    const attached = events.find((e) => e.type === 'skill.attached');
    const userMsg = events.find((e) => e.type === 'user.message');
    const runStarted = events.find((e) => e.type === 'run.started');
    check('skill.attached 事件发出', Boolean(attached), JSON.stringify(attached?.skills));
    check(
      'skill.attached 先于 run.started 且 runId 一致',
      Boolean(attached && runStarted) && attached.runId === runStarted.runId && attached.seq < runStarted.seq,
      `attached.seq=${attached?.seq} started.seq=${runStarted?.seq}`,
    );
    check('user.message 原文不被注入文本改写', userMsg?.text === '看一下这个工作区', userMsg?.text);
    check(
      'attached 含启用技能且为摘要注入',
      attached?.skills.some((s) => s.name === 'alpha-skill' && !s.explicit) ?? false,
    );
    const reasoning = events.filter((e) => e.type === 'reasoning.delta').map((e) => e.text).join('');
    check('mock 内核如实确认收到注入', reasoning.includes('技能上下文'), reasoning.slice(0, 40));
    const timeline = buildTimeline(events);
    check(
      '回放视图含技能挂载提示',
      timeline.some((item) => item.kind === 'notice' && item.text.includes('已挂载技能')),
    );
  }

  {
    const events = await runRound(host, session.id, '/alpha-skill 按技能指引处理');
    const attached = events.find((e) => e.type === 'skill.attached');
    check(
      '显式调用体现在事件里',
      attached?.skills.some((s) => s.name === 'alpha-skill' && s.explicit && s.bodyChars > 0) ?? false,
      JSON.stringify(attached?.skills),
    );
  }

  {
    host.toggleSkill('alpha-skill', false);
    const events = await runRound(host, session.id, '再来一轮');
    check(
      '停用后下一轮立即不再挂载',
      !events.some((e) => e.type === 'skill.attached'),
    );
    host.toggleSkill('alpha-skill', true);
  }

  {
    // 已启用但 SKILL.md 损坏：不阻断对话，但必须以事件形式可见（不只 log）
    store.install(makeSkill(path.join(root, 'src-broken'), 'broken-skill', '会坏的技能', '正文。'));
    fs.writeFileSync(path.join(home, 'skills', 'broken-skill', 'SKILL.md'), '没有 frontmatter 的内容', 'utf8');
    const events = await runRound(host, session.id, '看看工作区');
    const skipped = events.find((e) => e.type === 'skill.skipped');
    const runStarted = events.find((e) => e.type === 'run.started');
    check(
      'skill.skipped 事件发出且点名被跳过的技能',
      skipped?.skills.includes('broken-skill') ?? false,
      JSON.stringify(skipped?.skills),
    );
    check(
      'skill.skipped 先于 run.started 且 runId 一致',
      Boolean(skipped && runStarted) && skipped.runId === runStarted.runId && skipped.seq < runStarted.seq,
      `skipped.seq=${skipped?.seq} started.seq=${runStarted?.seq}`,
    );
    const timeline = buildTimeline(events);
    check(
      '回放视图含跳过警告（warn 级，可复现）',
      timeline.some((item) => item.kind === 'notice' && item.level === 'warn' && item.text.includes('broken-skill')),
    );
    store.uninstall('broken-skill');
  }

  await host.stop();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n技能上下文注入测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
