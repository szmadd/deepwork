'use strict';

/**
 * Composer `/` 技能名补全测试 —— 触发条件、候选排序、插入结果、与内核口径对齐。
 *
 *   npm run test:completion
 *
 * ── 这一层为什么必须有 ─────────────────────────────────────────────
 * 补全最坏的失败形态不是「没弹出来」，而是**弹出来、选中、却没有生效**：
 * 用户打了 `/work`，选中的是 `/workspace-check`，输入框里出来的是
 * `/workspace-check再看一下` —— 名字后面没空格，内核侧的正则要求名字后必须是
 * 空白或行尾，于是整段退化成普通文本，技能正文根本没进来，而且**不报任何错**。
 * 所以断言必须落在「插入后的文本长什么样」，而不能只验「函数返回了候选」。
 *
 * ── 内核口径是外部约束，必须对齐 ───────────────────────────────────
 * 内核侧的显式调用正则是 `^\/([a-z0-9][a-z0-9-]*)(?=\s|$)`（本项目的契约注释
 * 与 DEVLOG 都记着它）。这是别人定的规矩，我们只能对齐、不能改。
 * 因此这里把它当作**外部契约**直接搬进来断言：补全产出的每一段文本，
 * 都必须能被这条正则认出来。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  skillCommandCompletion,
  applySkillCommandCompletion,
} = require('../packages/protocol/dist/skills');

const repo = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 内核侧的显式调用正则（外部契约，抄写而非推导） */
const KERNEL_EXPLICIT_RE = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)/;

const skill = (name, description = `${name} 的说明`, enabled = true) => ({
  manifest: { name, description, version: '1.0.0' },
  source: '/x',
  installedAt: '2026-01-01T00:00:00.000Z',
  enabled,
  audit: { findings: [], summary: '' },
});

const skills = [
  skill('workspace-check', '检查工作区'),
  skill('work', '简短的那个'),
  skill('workspace-long-name', '长的那个'),
  skill('zzz-late', '字母序靠后'),
  skill('disabled-one', '已停用', false),
];

// ══════════════════════════════════════════════════════════
// 1. 触发条件
// ══════════════════════════════════════════════════════════
console.log('\n── 触发条件 ──');

const at = (text, caretOverride) => ({ text, caret: caretOverride ?? text.length, skills });

check('空文本不弹', skillCommandCompletion(at('')) === null);
check('不以 / 开头不弹', skillCommandCompletion(at('帮我看看')) === null);
check(
  '「/」不在第一个词的位置不弹（补全一个不会生效的东西比不补更糟）',
  skillCommandCompletion(at('看一下 /work')) === null,
  JSON.stringify(skillCommandCompletion(at('看一下 /work'))),
);
check('名字已写完（后面有空白）不再补全', skillCommandCompletion(at('/work 看一下')) === null);
check('候选为空时不弹（弹个空气泡比不弹更糟）', skillCommandCompletion(at('/qqq')) === null);

{
  const completion = skillCommandCompletion(at('/'));
  check('光一个 / 就列出全部启用技能（停用的不算）', completion !== null && !completion.candidates.some((c) => c.name === 'disabled-one'), String(completion?.candidates.length));
  check('start/end/query 描述替换区间', completion.start === 0 && completion.end === 1 && completion.query === '');
}

{
  const completion = skillCommandCompletion(at('  /work'));
  check('前导空白被跳过：start 落在 / 上（缩进不该破坏补全）', completion.start === 2 && completion.end === 7, `start=${completion?.start} end=${completion?.end}`);
}

{
  const completion = skillCommandCompletion(at('/WORK'));
  check('大小写不敏感地匹配（但插入的永远是规范名）', completion !== null && completion.candidates.some((c) => c.name === 'work'), JSON.stringify(completion?.candidates.map((c) => c.name)));
}

{
  const completion = skillCommandCompletion(at('/work'));
  const names = completion.candidates.map((c) => c.name);
  const lengths = names.map((name) => name.length);
  check(
    '候选按名字短的排前面（输入越少，短名越可能是想找的那个）',
    names[0] === 'work' && lengths.every((value, index) => index === 0 || lengths[index - 1] <= value),
    names.join(','),
  );
}

{
  const completion = skillCommandCompletion(at('/zz'));
  check('只匹配前缀（不是子串包含）', completion?.candidates.map((c) => c.name).join(',') === 'zzz-late', JSON.stringify(completion?.candidates.map((c) => c.name)));
}

{
  const completion = skillCommandCompletion({ text: '/w', caret: 99, skills });
  check('光标越界被夹回文本长度（不抛错、不越界切片）', completion.end === 2);
}

// ══════════════════════════════════════════════════════════
// 2. 插入结果：与内核口径对齐
// ══════════════════════════════════════════════════════════
console.log('\n── 插入结果 ──');

{
  const text = '/work';
  const completion = skillCommandCompletion({ text, caret: text.length, skills });
  const applied = applySkillCommandCompletion(text, completion, 'workspace-check');
  check('插入的是规范名而不是用户输入的大小写', applied.text === '/workspace-check ', JSON.stringify(applied.text));
  check('**带尾随空格**（内核正则要求名字后是空白或行尾）', applied.text.endsWith(' '));
  check('光标停在空格之后（可以直接接着打参数）', applied.caret === applied.text.length);
  check(
    '插入结果能被内核显式调用正则认出来',
    KERNEL_EXPLICIT_RE.test(applied.text),
  );
}

{
  // 最重要的一条：补全之后继续打参数，整段仍然被内核认作显式调用
  const text = '/work';
  const completion = skillCommandCompletion({ text, caret: text.length, skills });
  const applied = applySkillCommandCompletion(text, completion, 'workspace-check');
  const withArgs = `${applied.text}读一下 README`;
  check(
    '补全后接着打参数，整段仍被内核认作显式调用',
    KERNEL_EXPLICIT_RE.test(withArgs) && KERNEL_EXPLICIT_RE.exec(withArgs)[1] === 'workspace-check',
    withArgs,
  );
  check(
    '（反例）不带空格时内核认不出来 —— 这正是必须补空格的原因',
    KERNEL_EXPLICIT_RE.exec('/workspace-check读一下') === null,
    String(KERNEL_EXPLICIT_RE.exec('/workspace-check读一下')),
  );
}

{
  const text = '/wo';
  const completion = skillCommandCompletion({ text, caret: text.length, skills });
  const applied = applySkillCommandCompletion(text, completion, 'work');
  check('替换区间正确（不吞掉 / 前面的内容）', applied.text === '/work ', JSON.stringify(applied.text));
}

{
  const text = '  /wo';
  const completion = skillCommandCompletion({ text, caret: text.length, skills });
  const applied = applySkillCommandCompletion(text, completion, 'work');
  check('带缩进时前导空白被保留', applied.text === '  /work ', JSON.stringify(applied.text));
}

check(
  '每个启用技能的名插进去都能被内核正则接受',
  skills
    .filter((s) => s.enabled)
    .every((s) => KERNEL_EXPLICIT_RE.test(applySkillCommandCompletion('/x', { start: 0, end: 2, query: 'x', candidates: [] }, s.manifest.name).text)),
);

/*
 * 三处口径必须一致：内核的显式调用正则、清单解析的 NAME_RE、store 的 isValidName。
 * 任何一处放宽，就会出现「装得进却调不动」或「补全给的候选内核认不出」的技能，
 * 而这两种失败都不报错。这里直接读源码里的正则做交叉核对（比重复一份常量更硬）。
 */
{
  const charset = '[a-z0-9][a-z0-9-]*';
  const manifest = fs.readFileSync(path.join(repo, 'packages/core-host/src/skills/manifest.ts'), 'utf8');
  const store = fs.readFileSync(path.join(repo, 'packages/core-host/src/skills/store.ts'), 'utf8');
  check('清单解析的技能名正则与内核口径一致', manifest.includes(charset));
  check('store 的技能名校验与内核口径一致', store.includes(charset));
}

// ══════════════════════════════════════════════════════════
// 3. 界面接线
// ══════════════════════════════════════════════════════════
console.log('\n── 界面接线 ──');
{
  const composer = fs.readFileSync(path.join(repo, 'apps/desktop/src/components/Composer.tsx'), 'utf8');
  check('Composer 用契约层的两个纯函数（不在组件里重写规则）', composer.includes('skillCommandCompletion(') && composer.includes('applySkillCommandCompletion('));
  check(
    '补全打开时接管 ↑↓ / Enter / Tab / Esc（否则 Enter 会直接把半截命令发出去）',
    composer.includes("'ArrowDown'") &&
      composer.includes("'ArrowUp'") &&
      composer.includes("'Enter'") &&
      composer.includes("'Tab'") &&
      composer.includes("'Escape'"),
  );
  check('Esc 关闭后不再自动弹回（dismissed 状态）', composer.includes('dismissed'));
  check('候选渲染成列表项', composer.includes('completion.candidates.map'));

  const app = fs.readFileSync(path.join(repo, 'apps/desktop/src/App.tsx'), 'utf8');
  check('App 把技能清单喂给 Composer', /<Composer[\s\S]{0,200}skills=\{/.test(app));

  const hook = fs.readFileSync(path.join(repo, 'apps/desktop/src/useAgent.ts'), 'utf8');
  check('技能清单来自内核（refreshSkills），不是硬编码', hook.includes("invoke('skills.list'") || hook.includes("'skills.list'"));
}

const failed = results.filter((r) => !r.ok);
console.log(`\nComposer 技能补全测试：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
