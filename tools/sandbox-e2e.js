#!/usr/bin/env node
'use strict';

/**
 * 沙箱端到端取证（FR-3.5 第二期）：
 * 设置页上显示的那个档位，真的在约束**模型写文件**吗。
 *
 *   node tools/sandbox-e2e.js
 *
 * ── 为什么直连 runner 的取证还不够 ────────────────────────────────────
 * `tools/sandbox-test.js` 证明的是「内核用的那个 runner 会挡」——它把 runner 单独拽出来
 * 跑一条写命令，走的是 **shell 能力族**。但设置页上写的是「模型改文件的实际边界」，
 * 而模型的 `write` 工具走的是**另一条路**：`dsh-fs-sandbox` 的进程内围栏
 * （见该包 README.zh.md「围栏行为」）。两条路共享同一个 `writableRoots`，
 * 但「共享」是文档的承诺，不是本机的观测 —— 承诺漂移的那天，界面上的档位就成了装饰。
 * 本文件补的就是这一环：真内核 + 真 ACP + 真工具 + 真落盘。
 *
 * ── 一条会让人得出相反结论的坑（写在这里，因为下次一定还会踩）──────────
 * `workspace-write` 允许写入「会话工作区**或平台临时区**（`os.tmpdir()`）之下」
 * （README.zh.md 原文）。所以把「工作区外」的目标放进 `os.tmpdir()`，
 * 沙箱会**放行**，而这会被误读成「沙箱没生效」。
 * 本文件的 `outside` 因此取 tmpdir 的**兄弟目录**，并有一项 fixture 自检：
 * `outside` 必须既不位于 workspace 之下、也不位于 tmpdir 之下。
 * 该自检失败时整份结论作废 —— 而不是给出一个漂亮的假绿。
 *
 * ── 场景矩阵 ─────────────────────────────────────────────────────────
 * | 编号 | DSH_PERMISSION_MODE | 目标位置   | 模型带沙箱升级重试 | 审批答复 | 用来回答什么 |
 * |------|---------------------|-----------|------------------|---------|-------------|
 * | A    | （不设 = 内核默认）   | 工作区内   | 否               | 拒绝     | **对照组**：这条指令真送到了、工具真跑了 |
 * | B1   | workspace-write      | 工作区外   | 否               | 拒绝     | 判据：边界挡不挡，以及挡在哪一层 |
 * | B2   | workspace-write      | 工作区外   | 否               | 放行     | 记录：模型不重试时，用户点「允许」也没用 |
 * | C    | read-only            | 工作区内   | 否               | 拒绝     | 判据：read-only 是否连工作区内也挡 |
 * | D    | danger-full-access   | 工作区外   | 否               | 放行     | **反证**：同一个目录在宽模式下写得进 → 差别只来自模式 |
 * | E1   | workspace-write      | 工作区外   | 是（提到最宽）    | 放行     | 判据：**升级重试真的会弹审批**，批准后这一跳真能写成 |
 * | E2   | workspace-write      | 工作区外   | 是（提到最宽）    | 拒绝     | 判据：用户拒绝后 nothing happens，且说法是内核原话 |
 * | F    | workspace-write      | 工作区外   | 是（要求同级）    | 放行     | **反证**：「更宽」是硬判据 —— 同级申请直接失败且**不问人** |
 *
 * D 不是凑数：没有 D 的话，「工作区外没写进去」还可能是因为那个目录本身不可写
 * （ACL、只读盘、路径打错）── 那是和沙箱生效完全不同的原因，且会伪装成绿灯。
 * A 与 D 一个守「工具路径通」、一个守「目录可写」，B1 / C 才有资格说「是沙箱挡的」。
 *
 * ── E 组要验的那一跳，此前从没在本机跑通过 ─────────────────────────────
 * 上轮留下的问题：界面上说「被拦下之后，模型可以带 `sandbox_permissions` 重试一次，
 * 那时才会弹审批」—— 那句话当时是**引用内核文档**，不是本机观测。
 * E 组就是去观测它：让替身端点真的照提示重试一次，看整条链路是什么样。
 * F 组是它的反证 —— 没有它，「弹了审批」还可能被解释成「任何带 sandbox_permissions
 * 的调用都会弹」，而事实上非更宽的申请连问都不问（fail-closed）。
 *
 * ── 跳过条件 ─────────────────────────────────────────────────────────
 * 与 real-dsh-e2e.js 同：真实 dsh 是 devDependency，检测不到就打印 SKIP 退出码 0，
 * 让 `npm run verify` 保持绿 —— 否则一台机器的安装问题会卡住整条流水线。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HarnessSidecarAdapter } = require('../packages/core-host/dist/adapter/harness-sidecar');
const {
  SANDBOX_ESCALATION_ARG,
  SANDBOX_JUSTIFICATION_ARG,
} = require('../packages/protocol/dist/security');
const { startStubLlm } = require('./fixtures/openai-stub-llm');

const KERNEL_ENV = 'DSH_PERMISSION_MODE';

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
 * 隔离的 DSH_HOME，写一个伪造凭据绕过真实凭据校验。
 * 理由与 real-dsh-e2e.js 相同：llm-deepseek 适配器**先查 credentials 服务**，
 * 只有该服务根本不存在时才回退环境变量；而我们的替身端点并不校验 key。
 */
function prepareFakeDshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-sbx-e2e-home-'));
  fs.writeFileSync(
    path.join(home, '.credentials.yaml'),
    ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: "stub-stub-stub-stub"', ''].join('\n'),
  );
  return home;
}

/**
 * 严格包含判断（词法，大小写不敏感 —— win32 上路径大小写不敏感，
 * 用 `startsWith` 裸比会把 `C:\Users\X\WORKSPACE` 判成不在 `workspace` 之下）。
 */
function isUnder(child, parent) {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  if (a === b) return true;
  const sep = path.sep;
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}

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

/**
 * 跑一个场景：起替身端点 → 起真内核（带指定 DSH_PERMISSION_MODE）→ 让「模型」
 * 调它自己的 write 工具 → 收事件 → 看磁盘。
 *
 * 返回一份**完整记录**而不是布尔值：本文件的结论里，「挡在哪一层」（沙箱 / 审批）
 * 与「有没有写进去」同等重要，前者决定界面该怎么说话。
 */
async function runScenario(dsh, home, base, name, opts) {
  const workspace = path.join(base, 'workspace');
  const target = opts.target;
  // 目标先清掉：残留会让「写进去了」与「本来就是旧文件」无法区分
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* 本就不存在 */
  }

  /**
   * 剧本：先照常写一次，被拦下后**照内核给的提示重试一次**，最后收尾。
   *
   * 重试那一步必须真的把 `sandbox_permissions` 放进入参 —— 这是整份文件里
   * 唯一在模拟「模型读了拒绝提示之后会怎么做」的地方。替身不知道提示写了什么，
   * 是我们（照着真帧里的提示文本）让它这么做的；所以 E 组证明的是
   * 「**如果**模型照提示重试，链路是什么样」，而不是「模型一定会重试」。
   */
  const justification = opts.justification ?? `探针要写到工作区外的 ${path.dirname(target)}`;
  const script = [
    { tool: { pick: 'write', args: { file_path: target, content: `probe ${name}\n` } } },
  ];
  if (opts.retry) {
    script.push({
      tool: {
        pick: 'write',
        args: {
          file_path: target,
          content: `probe ${name}\n`,
          [SANDBOX_ESCALATION_ARG]: opts.retry,
          [SANDBOX_JUSTIFICATION_ARG]: justification,
        },
      },
    });
  }
  script.push({ text: `场景 ${name} 结束。` });

  const stub = await startStubLlm({ script });

  const env = { DSH_HOME: home, DEEPSEEK_BASE_URL: stub.url };
  // 只有显式给了模式才设键：A 组要验的正是「不设时内核自己的默认」，
  // 把默认值从产品侧写进去会让这一组失去意义（它就变成了 B 组）。
  if (opts.mode) env[KERNEL_ENV] = opts.mode;

  const adapter = new HarnessSidecarAdapter({
    command: process.execPath,
    args: [dsh, '--profile', 'acp'],
    workspace,
    model: 'deepseek-v4-flash',
    startupTimeoutMs: 30_000,
    env,
  });

  const events = [];
  const approvals = [];
  const controller = new AbortController();
  const record = { name, mode: opts.mode ?? '(内核默认)', approval: opts.approval, target, events, approvals };
  record.retryMode = opts.retry ?? null;
  record.justification = opts.retry ? justification : null;

  try {
    const health = await adapter.start();
    record.health = health.ok === true;
    if (!health.ok) {
      record.startError = health.detail;
      return record;
    }

    record.status = await adapter.run({
      runId: `run-${name}`,
      sessionId: `sess-${name}`,
      text: `请把 "probe ${name}" 写入 ${target}`,
      attachments: [],
      workspace,
      mode: 'standard',
      model: 'deepseek-v4-flash',
      guard: { assess: () => ({ risk: 'safe', reason: '', blocked: false }) },
      tools: {},
      emit: (event) => events.push(event),
      requestApproval: async (input) => {
        approvals.push(input);
        return { approved: opts.approval === 'allow' };
      },
      signal: controller.signal,
    });
  } catch (error) {
    record.selfError = String(error?.message ?? error);
  } finally {
    await adapter.stop().catch(() => undefined);
    await stub.close();
  }

  record.requests = stub.requests.length;
  record.toolOffered = Boolean(stub.requests[0]?.tools?.includes('write'));
  record.written = fs.existsSync(target);
  if (record.written) {
    try {
      record.bytes = fs.readFileSync(target, 'utf8');
    } catch {
      record.bytes = null;
    }
  }

  const runDone = events.find((e) => e.type === 'run.completed' || e.type === 'run.failed');
  record.runDone = runDone ? `${runDone.type}/${runDone.status ?? ''}` : '无终态事件';
  record.runMessage = runDone?.message ?? '';

  /**
   * 本轮里模型发起的**每一次** write 调用。
   *
   * 记成数组而不是只取第一次：升级重试的场景里会有两次（被拒的那次 + 带
   * `sandbox_permissions` 的那次），而这两次的差别正是要观测的东西。
   */
  record.attempts = [];
  for (const started of events) {
    if (started.type !== 'tool.started' || started.call?.name !== 'write') continue;
    const done = events.find(
      (e) => (e.type === 'tool.completed' || e.type === 'tool.failed') && e.callId === started.call?.id,
    );
    record.attempts.push({
      callId: started.call?.id ?? '',
      risk: started.call?.risk ?? '',
      outcome: done ? `${done.type} ok=${done.ok}` : '无工具终态事件',
      ok: done?.ok === true,
      output: String(done?.output ?? done?.error ?? '').slice(0, 600),
    });
  }

  // 兼容旧字段：既有各节读的都是「第一次尝试」，语义未变
  const first = record.attempts[0];
  record.toolStarted = Boolean(first);
  record.toolRisk = first?.risk ?? '';
  record.toolOutcome = first?.outcome ?? '无工具终态事件';
  record.toolOutput = first?.output ?? '';

  /** 升级重试那一次的终态（E 组用） */
  record.retryAttempt = record.attempts[1] ?? null;

  /** 审批请求里带回来的升级申请（由适配器从 rawInput 补的，见 protocol 的说明） */
  record.escalationAsked = approvals.find((a) => a?.escalation)?.escalation ?? null;

  /**
   * 内核有没有把升级参数广告给模型。
   *
   * 这是**可观测量**而不是能力清单：`sandbox_permissions` 只在挂了限制性文件系统
   * 后端时才进 write 的 parameters。它没被广告出去时，模型永远不可能申请升级，
   * 而链路上一点异常都看不到 —— 所以这条必须由真请求的 schema 来回答。
   */
  const writeParams = stub.requests[0]?.toolParams?.write ?? null;
  const props = writeParams?.properties ?? {};
  record.escalationSchema = {
    hasMode: Boolean(props[SANDBOX_ESCALATION_ARG]),
    hasJustification: Boolean(props[SANDBOX_JUSTIFICATION_ARG]),
    modes: Array.isArray(props[SANDBOX_ESCALATION_ARG]?.enum)
      ? props[SANDBOX_ESCALATION_ARG].enum
      : [],
  };

  return record;
}

/** 把记录打印成一行结论，供人核对（断言之外的现场）。 */
function printRecord(r) {
  console.log(
    `    ${r.name.padEnd(22)} 模式=${String(r.mode).padEnd(18)} 审批答复=${r.approval.padEnd(5)}` +
      ` 写入=${r.written ? '是' : '否'} write 次数=${r.attempts.length} 审批请求=${r.approvals.length} run=${r.runDone}`,
  );
  if (r.retryMode) console.log(`      升级申请: ${r.retryMode}（理由 "${r.justification}"）`);
  if (r.toolOutcome !== '无工具终态事件') console.log(`      首次工具终态: ${r.toolOutcome}`);
  if (r.retryAttempt) console.log(`      重试工具终态: ${r.retryAttempt.outcome}`);
  if (r.toolOutput) console.log(`      工具输出: ${JSON.stringify(r.toolOutput.slice(0, 200))}`);
  if (r.runMessage) console.log(`      run 消息: ${JSON.stringify(r.runMessage.slice(0, 200))}`);
  if (r.selfError) console.log(`      脚本异常: ${r.selfError}`);
  if (r.startError) console.log(`      内核启动失败: ${r.startError}`);
}

async function main() {
  const dsh = resolveDsh();
  if (!dsh) {
    console.log('[SKIP] 真实 dsh 不在路径上（devDependency 未安装或被路径屏蔽）');
    process.exit(0);
  }
  console.log(`真实 dsh: ${dsh}`);

  const tmp = os.tmpdir();
  const base = fs.mkdtempSync(path.join(tmp, 'deepwork-sbx-e2e-'));
  const workspace = path.join(base, 'workspace');
  /**
   * 「工作区外」的落点：取 tmpdir 的**兄弟目录**。
   *
   * 不能取 tmpdir 之内 —— workspace-write 把 `os.tmpdir()` 整体算作可写区，
   * 放在里面的「越界」目标其实并不越界，会得到假绿（见文件头）。
   */
  const outside = path.join(path.dirname(tmp), `deepwork-sbx-e2e-out-${path.basename(base)}`);
  for (const dir of [workspace, outside]) fs.mkdirSync(dir, { recursive: true });

  console.log(`临时根（os.tmpdir）: ${tmp}`);
  console.log(`工作区            : ${workspace}`);
  console.log(`工作区外          : ${outside}`);

  // ── fixture 自检 ─────────────────────────────────────────────────
  // 本文件的全部结论都建立在「outside 真的是 outside」上。这条不成立时，
  // 后面的「被拒绝」是假的 —— 先钉死它，而不是等结论漂亮了再回头怀疑。
  section('0) fixture 自检：取证现场本身得站得住');
  check(
    'outside 不在 workspace 之下',
    !isUnder(outside, workspace),
    `outside=${outside}`,
  );
  check(
    'outside 不在 os.tmpdir 之下（workspace-write 把临时区算可写，放这儿会假绿）',
    !isUnder(outside, tmp),
    `tmp=${tmp}`,
  );
  check('workspace 在 os.tmpdir 之下（沙箱允许的写区）', isUnder(workspace, tmp), `workspace=${workspace}`);

  const home = prepareFakeDshHome();
  const scenarios = [
    { key: 'A', mode: undefined, target: path.join(workspace, 'A-inside.txt'), approval: 'deny' },
    { key: 'B1', mode: 'workspace-write', target: path.join(outside, 'B1-escape.txt'), approval: 'deny' },
    { key: 'B2', mode: 'workspace-write', target: path.join(outside, 'B2-escape.txt'), approval: 'allow' },
    { key: 'C', mode: 'read-only', target: path.join(workspace, 'C-readonly.txt'), approval: 'deny' },
    { key: 'D', mode: 'danger-full-access', target: path.join(outside, 'D-wide.txt'), approval: 'allow' },
    // E / F：唯一新增的自变量是「模型有没有带 sandbox_permissions 重试」
    { key: 'E1', mode: 'workspace-write', target: path.join(outside, 'E1-escalated.txt'), approval: 'allow', retry: 'danger-full-access' },
    { key: 'E2', mode: 'workspace-write', target: path.join(outside, 'E2-escalated.txt'), approval: 'deny', retry: 'danger-full-access' },
    { key: 'F', mode: 'workspace-write', target: path.join(outside, 'F-same-mode.txt'), approval: 'allow', retry: 'workspace-write' },
  ];

  const records = [];
  try {
    section('1) 逐场景跑真内核（真 ACP · 真工具 · 真落盘）');
    for (const s of scenarios) {
      console.log(`  · 场景 ${s.key}：模式=${s.mode ?? '(内核默认)'} 审批=${s.approval}`);
      // 会话 cwd 就是 workspace；每个场景一个全新内核进程 —— 模式是**加载期**参数，
      // 同一个进程里换不了（这正是 DEVLOG 记的那条「mode 不是运行期指令」）。
      const r = await runScenario(dsh, home, base, s.key, s);
      records.push(r);
      printRecord(r);
    }

    const by = (k) => records.find((r) => r.name === k);

    section('2) 对照组：这条指令真的能落盘吗（不成立则后面全部作废）');
    const A = by('A');
    check(
      'A 内核默认模式下，模型把文件写进了工作区（工具路径通 + 指令送达）',
      A.written === true,
      `写入=${A.written} run=${A.runDone} 工具=${A.toolOutcome} ${A.toolOutput.slice(0, 160)}`,
    );
    check('A 确实调用了真实 write 工具（不是替身退化成纯文本）', A.toolStarted === true, A.toolOutcome);
    check('A 组替身端点自报把 write 注册给了模型', A.toolOffered === true);

    section('3) 反证：同一个目录在宽模式下必须写得进（否则「被拒绝」另有原因）');
    const D = by('D');
    check(
      'D danger-full-access 下，工作区外同一个目录写入成功',
      D.written === true,
      `写入=${D.written} run=${D.runDone} 工具=${D.toolOutcome} ${D.toolOutput.slice(0, 160)}`,
    );

    section('4) 判据：受限模式下模型的越界写被拦住了吗');
    const B1 = by('B1');
    check(
      'B1 workspace-write 下，工作区外写入被拦住（文件未落盘）',
      B1.written === false,
      `写入=${B1.written} run=${B1.runDone} 工具=${B1.toolOutcome} ${B1.toolOutput.slice(0, 200)}`,
    );
    check(
      'B1 的 run 没有因此崩掉（拒绝是可处理的工具结果，不是链路故障）',
      B1.status !== undefined && !String(B1.runDone).includes('failed'),
      `run=${B1.runDone} ${B1.runMessage.slice(0, 160)}`,
    );

    const C = by('C');
    check(
      'C read-only 下，连工作区内的写入也被拦住',
      C.written === false,
      `写入=${C.written} run=${C.runDone} 工具=${C.toolOutcome} ${C.toolOutput.slice(0, 200)}`,
    );

    section('5) 对照：A 与 B1 目标不同、模式不同，唯一变量是「越界」');
    check(
      'A（工作区内）写成了 / B1（工作区外）没写成 —— 边界确实在起作用',
      A.written === true && B1.written === false,
      `A=${A.written} B1=${B1.written}`,
    );

    section('6) 拒绝方言（记录用，供界面如实呈现与后续分类）');
    for (const r of [B1, C]) {
      console.log(`  ${r.name}（${r.mode}，审批答复=${r.approval}）`);
      console.log(`    工具终态: ${r.toolOutcome}`);
      console.log(`    工具输出: ${JSON.stringify(r.toolOutput.slice(0, 300))}`);
      console.log(`    审批请求数: ${r.approvals.length}`);
      if (r.approvals.length > 0) {
        console.log(`    首个审批请求: ${JSON.stringify(r.approvals[0]).slice(0, 300)}`);
      }
    }
    const B2 = by('B2');
    console.log(`  B2（workspace-write，工作区外，审批=放行，模型不重试）`);
    console.log(`    写入: ${B2.written}  审批请求数: ${B2.approvals.length}  工具终态: ${B2.toolOutcome}`);
    console.log(
      '    说明：B2 与 E1 只差「模型有没有带 sandbox_permissions 重试」。用户点「允许」本身',
    );
    console.log(
      '    不构成授权 —— 不重试就没有第二次调用，也就没有可批准的东西。对照 E1 看这一点。',
    );

    section('7) 判据：升级重试真的会弹审批吗（上轮只到「引用内核文档」）');
    const E1 = by('E1');
    const E2 = by('E2');
    const F = by('F');

    // 前置条件：参数得先到模型手里，否则后面「模型没重试」什么的都无从谈起
    console.log(`  替身端点在首轮请求里看到的 write 参数：${JSON.stringify(E1.escalationSchema)}`);
    check(
      '内核把 sandbox_permissions 广告给了模型（挂了限制性后端的证据）',
      E1.escalationSchema.hasMode === true,
      JSON.stringify(E1.escalationSchema),
    );
    check(
      '内核同时广告了 justification（两者是成对的，缺一个内核会报 invalid escalation）',
      E1.escalationSchema.hasJustification === true,
      JSON.stringify(E1.escalationSchema),
    );
    check(
      '升级目标的枚举是内核的两个更宽档位，且不含 read-only',
      E1.escalationSchema.modes.length === 2 &&
        E1.escalationSchema.modes.includes('workspace-write') &&
        E1.escalationSchema.modes.includes('danger-full-access') &&
        !E1.escalationSchema.modes.includes('read-only'),
      JSON.stringify(E1.escalationSchema.modes),
    );

    // 负对照：单是被拒，不该弹审批。这一条是「此时才会弹」里那个「才」字的判据
    check(
      'B1（被拒但没重试）审批请求数 = 0 —— 被拦下本身不弹审批',
      B1.approvals.length === 0,
      `审批请求数=${B1.approvals.length}`,
    );

    // 正题：模型真的重试了，审批才会来
    check(
      'E1 带了 sandbox_permissions 重试，于是**出现了审批请求**（此时才会弹）',
      E1.approvals.length >= 1,
      `审批请求数=${E1.approvals.length} run=${E1.runDone} 工具=${E1.retryAttempt?.outcome}`,
    );
    check(
      'E1 的升级申请带着档位与理由一起到了宿主（内核的 ACP 帧不带理由，是适配器从 rawInput 补的）',
      E1.escalationAsked?.mode === 'danger-full-access' &&
        // 逐字比对：宿主解析出来的理由必须与替身写给内核的那一句完全相同。
        // 只查「非空」是不够的 —— 那验不出适配器是不是把内容弄丢了。
        E1.escalationAsked?.justification === E1.justification,
      `${JSON.stringify(E1.escalationAsked)} vs 发出的 ${JSON.stringify(E1.justification)}`,
    );
    check(
      'E1 宿主批准之后，越界写真的落盘了（升级只作用于这一次调用）',
      E1.written === true,
      `写入=${E1.written} run=${E1.runDone} 重试工具=${E1.retryAttempt?.outcome}`,
    );
    check(
      'E1 的重试那次工具调用是成功的（不是以别的方式侥幸落盘）',
      E1.retryAttempt?.ok === true,
      `${E1.retryAttempt?.outcome} ${E1.retryAttempt?.output?.slice(0, 200)}`,
    );

    // 拒绝那一支：审批来了、用户拒绝了、什么都没发生
    check(
      'E2 同样弹了审批（弹不弹只取决于模型有没有重试，不取决于用户会点哪个）',
      E2.approvals.length >= 1,
      `审批请求数=${E2.approvals.length}`,
    );
    check('E2 用户拒绝后，越界写没有落盘', E2.written === false, `写入=${E2.written}`);
    console.log(`  E2 重试工具的输出（内核原话）: ${JSON.stringify(E2.retryAttempt?.output?.slice(0, 300))}`);
    check(
      'E2 的失败说法是内核的 reject 原话（fail-closed 的证据，不是文件没写成的默认报错）',
      /rejected escalating this operation/i.test(E2.retryAttempt?.output ?? ''),
      E2.retryAttempt?.output?.slice(0, 200),
    );

    // 反证：非更宽的申请连问都不问
    check(
      'F 申请同级（workspace-write → workspace-write）时失败：内核要求「严格更宽」',
      F.written === false && /not strictly wider/i.test(F.retryAttempt?.output ?? ''),
      `写入=${F.written} ${F.retryAttempt?.output?.slice(0, 200)}`,
    );
    check(
      'F 没有弹审批 —— 非更宽的申请在问人之前就被判掉了（fail-closed，不是「先问再说」）',
      F.approvals.length === 0,
      `审批请求数=${F.approvals.length} 输出=${F.retryAttempt?.output?.slice(0, 160)}`,
    );

    section('8) 解析器真帧自证：拒绝方言被接住了吗');
    // 参照物是**上面刚跑出来的输出**，不是手抄的样本 —— 内核改方言的那天，
    // 这一节会跟着红，而不是继续对着过时样本绿着。
    const { parseSandboxDenial } = require('../packages/protocol/dist/security.js');

    const parsedB1 = parseSandboxDenial(B1.toolOutput);
    check(
      'B1 的真实输出被识别为沙箱拒绝，且档位=workspace-write',
      parsedB1?.mode === 'workspace-write',
      JSON.stringify(parsedB1),
    );
    check(
      'B1 的档位落在已知词汇里（knownMode）',
      parsedB1?.knownMode === true,
      JSON.stringify(parsedB1),
    );
    check(
      'B1 被识别出「留了升级路径」（escalation）',
      parsedB1?.escalation === true,
      JSON.stringify(parsedB1),
    );
    check(
      '拒绝提示里点名了重试参数 sandbox_permissions（E 组就是照着这行真帧重试的）',
      B1.toolOutput.includes(SANDBOX_ESCALATION_ARG),
      B1.toolOutput.slice(0, 240),
    );

    const parsedC = parseSandboxDenial(C.toolOutput);
    check(
      'C 的真实输出被识别为沙箱拒绝，且档位=read-only',
      parsedC?.mode === 'read-only' && parsedC?.knownMode === true,
      JSON.stringify(parsedC),
    );

    // 假阳性防线：这两条都不是沙箱拒绝，解析器必须说「不是」。
    // 没有这一节的话，一个「什么都匹配」的正则会让界面把所有失败都说成档位问题。
    check(
      '成功的工具输出不被误判为拒绝（A 组）',
      parseSandboxDenial(A.toolOutput) === null,
      A.toolOutput.slice(0, 120),
    );
    check(
      '普通工具失败不被误判为拒绝（EPERM 一类）',
      parseSandboxDenial('Error: EPERM: operation not permitted, open ...') === null,
      '',
    );
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    // outside 在 tmp 之外，删它要单独来一次 —— 漏删会在用户目录里留垃圾
    await fs.promises.rm(outside, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
      console.log(`  [注意] 工作区外现场未清理干净：${outside}（${error.message}）`);
    });
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  console.log(`\n通过 ${passed} 项 / 失败 ${failed} 项`);
  if (failed > 0) console.log(`失败项：${failures.join('、')}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\n[沙箱 e2e 致命异常]', error);
  process.exit(1);
});
