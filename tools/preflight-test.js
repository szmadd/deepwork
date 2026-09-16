#!/usr/bin/env node
/**
 * 安装前环境体检验收（ROADMAP §8.3）。
 *
 * ── 这份测试在证明什么 ──────────────────────────────────────────────────
 * 「体检报告有用」这件事拆成三条可断言的性质，缺一条这份报告就不值钱：
 *
 *   1. **逐项命中**：人为造出来的每一个不满足项，报告里都**真的出现了**
 *      并且标成了不通过。一份「什么都报通过」的报告与没有报告等价。
 *   2. **建议可行动**：不通过项必须带一句能照着做的事。只说「检查失败」，
 *      等于把问题原样丢回给用户 —— 那正是体检要消灭的东西。
 *   3. **分级按后果**：缺随包 Python 不该阻断安装（产品今天不用它），
 *      缺随包 Node 必须阻断（内核起不来）。分级错了的后果是：
 *      用户在没坏的时候不敢装，或者在真坏了的时候装上去。
 *
 * 本机造不出的场景（架构不符、磁盘极小）通过**注入参数**构造 ——
 * 这是 `PreflightInput` 里那几个覆盖字段存在的唯一理由。
 *
 * 用法：node tools/preflight-test.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const {
  runPreflight,
  summarizePreflight,
  defaultResourcesDirs,
} = require(path.join(ROOT, 'packages/core-host/dist/runtime/preflight.js'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-preflight-'));
const byId = (report, id) => report.checks.find((item) => item.id === id);

console.log('深边AI Work · 安装前环境体检验收');

// ── 一、报告本身的性质 ───────────────────────────────────────────────────

section('报告结构');

const realResources = path.join(ROOT, 'offline-bundle/staging');
const real = runPreflight({ resourcesDir: realResources, writeDir: scratch });

check('体检跑得起来且返回条目', real.checks.length >= 8, `${real.checks.length} 项`);
check(
  '每项都带 id / 标题 / 分级 / 现状 / 建议',
  real.checks.every((item) => item.id && item.title && item.level && item.detail && item.remedy),
);
check(
  '分级只有 block / warn 两种取值',
  real.checks.every((item) => item.level === 'block' || item.level === 'warn'),
);
check(
  '每项的建议都不是空话（≥10 字）',
  real.checks.every((item) => item.remedy.length >= 10),
  real.checks.filter((item) => item.remedy.length < 10).map((item) => item.id).join(', '),
);
check('blocked / warned 计数与条目一致',
  real.blocked === real.checks.filter((c) => !c.ok && c.level === 'block').length
  && real.warned === real.checks.filter((c) => !c.ok && c.level === 'warn').length);
check('ok 的判定只看阻断项（有警告仍为 true 才算对）',
  real.ok === (real.blocked === 0));

// ── 二、逐项命中（人为制造不满足项） ─────────────────────────────────────

section('人为制造的不满足项');

const emptyResources = path.join(scratch, 'empty-resources');
fs.mkdirSync(emptyResources, { recursive: true });

const broken = runPreflight({
  resourcesDir: emptyResources,
  writeDir: scratch,
  minFreeBytes: 1e15, // 造一个任何真实磁盘都满足不了的阈值
  arch: 'arm64',
  platform: 'freebsd',
  pipSource: undefined,
});

check(
  '架构不符 → 命中，且是阻断',
  byId(broken, 'os-arch').ok === false && byId(broken, 'os-arch').level === 'block',
  byId(broken, 'os-arch').detail,
);
check(
  '随包 Node 缺失 → 命中，且是阻断（内核起不来）',
  byId(broken, 'bundled-node').ok === false && byId(broken, 'bundled-node').level === 'block',
  byId(broken, 'bundled-node').detail,
);
check(
  '随包 Python 缺失 → 命中，但是警告（产品今天不依赖它）',
  byId(broken, 'bundled-python').ok === false && byId(broken, 'bundled-python').level === 'warn',
  byId(broken, 'bundled-python').detail,
);
check(
  '真实内核依赖缺失 → 命中，且是警告（可用 mock 降级）',
  byId(broken, 'bundled-dsh').ok === false && byId(broken, 'bundled-dsh').level === 'warn',
);
check(
  '磁盘空间不足 → 命中，且是阻断',
  byId(broken, 'disk-space').ok === false && byId(broken, 'disk-space').level === 'block',
  byId(broken, 'disk-space').detail,
);
check(
  '非 Windows → 无系统浏览器命中，且是警告',
  byId(broken, 'system-browser').ok === false && byId(broken, 'system-browser').level === 'warn',
);
check(
  '未配 pip 源 → 命中，且是警告',
  byId(broken, 'pip-source').ok === false && byId(broken, 'pip-source').level === 'warn',
);
check('有阻断项 → 整体 ok=false', broken.ok === false);
check('阻断与警告计数正确', broken.blocked === 3 && broken.warned === 4,
  `blocked=${broken.blocked} warned=${broken.warned}`);
check(
  '每个不通过项都带具体建议（可行动）',
  broken.checks.filter((c) => !c.ok).every((c) => c.remedy.length >= 10),
);

// ── 三、文件在但跑不起来（AV 拦截的形态） ────────────────────────────────

section('「文件在但跑不起来」');

const fakeResources = path.join(scratch, 'fake-resources');
fs.mkdirSync(path.join(fakeResources, 'node-runtime'), { recursive: true });
const fakeNode = path.join(fakeResources, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'node');
fs.writeFileSync(fakeNode, '');

{
  const report = runPreflight({ resourcesDir: fakeResources, writeDir: scratch });
  const nodeCheck = byId(report, 'bundled-node');
  check(
    '文件存在但不可执行 → 判为不通过（不是「文件在就算过」）',
    nodeCheck.ok === false,
    nodeCheck.detail,
  );
  check(
    '现状说明指出了「跑不起来」这个形态（而不是笼统的「失败」）',
    /跑不起来/.test(nodeCheck.detail),
    nodeCheck.detail,
  );
  check(
    '建议指向杀毒白名单 / 重装（针对这个形态的可行动作）',
    /杀毒|白名单|修复安装/.test(nodeCheck.remedy),
    nodeCheck.remedy,
  );
}

// ── 四、写入权限 ─────────────────────────────────────────────────────────

section('写入权限');

{
  // 拿一个「文件」当目录用：mkdir 必然失败，且失败原因与真实的无权限目录同类
  const asFile = path.join(scratch, 'i-am-a-file');
  fs.writeFileSync(asFile, 'x');
  const report = runPreflight({ resourcesDir: realResources, writeDir: path.join(asFile, 'sub') });
  const writeCheck = byId(report, 'write-permission');
  check('目标目录不可用 → 命中阻断', writeCheck.ok === false && writeCheck.level === 'block', writeCheck.detail);
  check('现状里带上底层错误信息（排查时唯一的线索）', writeCheck.detail.includes('不可写'), writeCheck.detail);
  check('建议给出换目录 / 提权两条动作', /换一个|管理员/.test(writeCheck.remedy), writeCheck.remedy);
}

{
  const report = runPreflight({ resourcesDir: realResources, writeDir: scratch });
  check('可写目录 → 写权限通过', byId(report, 'write-permission').ok === true,
    byId(report, 'write-permission').detail);
}

// ── 五、pip 源配置后的形态 ───────────────────────────────────────────────

section('pip 源');

{
  const report = runPreflight({
    resourcesDir: realResources,
    writeDir: scratch,
    pipSource: { indexUrl: 'http://nexus.corp/repository/pypi/simple', trustedHost: 'nexus.corp' },
  });
  const pipCheck = byId(report, 'pip-source');
  check('配了源 → 通过', pipCheck.ok === true, pipCheck.detail);
  check('现状里带上地址与受信主机（配错时一眼能看出）',
    pipCheck.detail.includes('nexus.corp') && pipCheck.detail.includes('受信主机'), pipCheck.detail);
}

// ── 六、摘要文案 ─────────────────────────────────────────────────────────

section('摘要');

check('有阻断 → 摘要说阻断，并给出条数', /阻断/.test(summarizePreflight(broken)) && summarizePreflight(broken).includes('3'),
  summarizePreflight(broken));
{
  const warnOnly = runPreflight({ resourcesDir: realResources, writeDir: scratch });
  check(
    '无阻断但有警告 → 摘要说通过（并可带警告条数）',
    /通过/.test(summarizePreflight(warnOnly)),
    summarizePreflight(warnOnly),
  );
}

// ── 七、默认目录推导 ─────────────────────────────────────────────────────

section('随包目录推导');

check('默认候选覆盖打包态与开发态两种布局', defaultResourcesDirs().length >= 2,
  defaultResourcesDirs().join(' | '));

// ── 汇总 ─────────────────────────────────────────────────────────────────

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
}
process.exit(failed === 0 ? 0 : 1);
