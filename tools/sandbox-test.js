#!/usr/bin/env node
/**
 * 沙箱后端验证（FR-3.5 取证资产）。
 *
 * ── 为什么是「直接驱动 runner」而不是「通过内核跑一轮对话」─────────────
 * 内核 `acp` profile 已装配完整沙箱链（`dsh-sandbox-local` + `dsh-sandbox-policy`
 * + win32 上的 `dsh-pwsh-sandbox`），默认模式 `workspace-write`。要验证它「真的挡」，
 * 有两条路：让模型跑一轮（要真 LLM、不可控、失败时说不清是哪一层），或直接驱动
 * 内核用的那个 runner（确定、快、失败定位到包）。本文件走第二条。
 *
 * runner 的调用形态来自 `dsh-sandbox-windows-acl` 的 README（README.zh.md
 * 「隔离 runner」一节）：不带 `--write-sid/--temp-write-sid` 时，`--temp` 是临时
 * **根目录**，runner 自己建随机私有子目录、自行管理临时 SID、重写 TMP/TEMP、
 * 退出时移除 —— 因此本文件不需要理解 SID 细节，只观察「写得到 / 写不到」。
 *
 * ── 两条让本文件不至于自欺的纪律 ──────────────────────────────────────
 * 1. **每组都先跑对照组**（同一命令、不套沙箱）。没有对照组时，「文件没出现」
 *    既可能是沙箱拒绝，也可能是命令本来就没跑起来 —— 两者不可区分，
 *    而后者会伪装成「沙箱生效了」的绿灯。
 * 2. **断言落在文件系统上**，不落在 runner 的退出码或输出上。拒绝是策略事实，
 *    退出码 1 还可能是 runner 自己坏了 —— 那是两种完全不同的故障。
 *
 * 用法：node tools/sandbox-test.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(
  ROOT,
  'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js',
);
const WRITER = path.join(ROOT, 'tools/fixtures/sandbox-writer.js');

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

function runnerAvailable() {
  return process.platform === 'win32' && fs.existsSync(RUNNER);
}

/** 跑一条进程，永不抛：把退出信息原样交回给调用方判断 */
function exec(argv, cwd) {
  try {
    const stdout = execFileSync(process.execPath, argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      cwd,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? -1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      message: error.message,
    };
  }
}

/** 不套沙箱：证明「这条写入命令本身可行」。对照组失败时后面的结论全部作废。 */
function writeDirect(target, cwd) {
  return exec([WRITER, target], cwd);
}

/**
 * 套沙箱：让内核用的那个 runner 包住同一条命令。
 *
 * `--` 之后第一个 argv 必须是**真正的可执行映像**：runner 走
 * `CreateProcessAsUserW`，不做 shell 式的扩展名解析 —— 直接给 `.js`
 * 会以 `Win32 193 / ERROR_BAD_EXE_FORMAT` 失败（exit=127，签名 `windows-acl-run:`）。
 * 内核侧同理：它传的是 `pwsh.exe` 的路径，而不是 `.ps1`。
 */
function writeConfined(mode, workspace, tempRoot, target) {
  return exec(
    [
      RUNNER,
      '--workspace',
      workspace,
      '--temp',
      tempRoot,
      '--mode',
      mode,
      '--',
      process.execPath,
      WRITER,
      target,
    ],
    workspace,
  );
}

/**
 * 分类一次受限执行的结果。
 * 三种可判别的情形：写成功了 / 被策略拒绝 / runner 自己坏了（后者不能算沙箱生效）。
 */
function classify(target, result) {
  if (fs.existsSync(target)) return 'written';
  if (/windows-acl-run:/i.test(result.stderr)) return 'runner-failure';
  return 'denied';
}

function main() {
  console.log('沙箱后端验证（内核 win32 ACL 受限令牌档）');

  if (!runnerAvailable()) {
    console.log(
      `  [SKIP] 平台=${process.platform} 或 runner 不存在 —— runner 真帧那几节只在 Windows 上有意义`,
    );
    // 解析规则与内核装配两节与平台无关，不能跟着一起跳过：
    // 否则在非 Windows 上跑本文件会给出「全绿」的假象，而实际上什么都没验。
    modeResolutionSection();
    kernelAssemblySection();
    hostStatusSection();
    denialDialectSection();
    console.log(`\n通过 ${passed} 项 / 失败 ${failed} 项`);
    process.exit(failed > 0 ? 1 : 0);
  }

  // 全部现场放在系统临时目录下，跑完即删 —— 不碰仓库、不碰用户目录
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-sandbox-probe-'));
  const workspace = path.join(base, 'workspace');
  const tempRoot = path.join(base, 'temp');
  const outside = path.join(base, 'outside');
  for (const dir of [workspace, tempRoot, outside]) fs.mkdirSync(dir, { recursive: true });

  const rm = (p) => {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 文件本就不存在 */
    }
  };

  /** shell 族的拒绝原文，留给第 7 节做方言对比（见该节注释里的不对称说明） */
  let runnerDenialText = '';

  try {
    // ── 对照组：不套沙箱 ──────────────────────────────────────────────
    // 它失败的话，本文件后面所有「被拒绝」都是废话。先钉死这条基线。
    section('0) 对照组：同一条命令不套沙箱时能写成功');
    const baseIn = path.join(workspace, 'baseline-inside.txt');
    const baseOut = path.join(outside, 'baseline-outside.txt');
    rm(baseIn);
    rm(baseOut);
    const c1 = writeDirect(baseIn, workspace);
    check(
      '对照组：工作区内写入成功（命令本身可行）',
      fs.existsSync(baseIn),
      `exit=${c1.code} stderr=${(c1.stderr || c1.message || '').slice(0, 200)}`,
    );
    const c2 = writeDirect(baseOut, workspace);
    check(
      '对照组：工作区外写入成功（未套沙箱时确实没有边界）',
      fs.existsSync(baseOut),
      `exit=${c2.code} stderr=${(c2.stderr || c2.message || '').slice(0, 200)}`,
    );

    // ── workspace-write ──────────────────────────────────────────────
    section('1) workspace-write：边界是工作区');
    const inFile = path.join(workspace, 'inside.txt');
    rm(inFile);
    const r1 = writeConfined('workspace-write', workspace, tempRoot, inFile);
    check(
      '工作区内写入成功（沙箱不误杀合法写）',
      classify(inFile, r1) === 'written',
      `判定=${classify(inFile, r1)} exit=${r1.code} stderr=${(r1.stderr || '').slice(0, 200)}`,
    );

    const outFile = path.join(outside, 'escaped.txt');
    rm(outFile);
    const r2 = writeConfined('workspace-write', workspace, tempRoot, outFile);
    check(
      '工作区外写入被拒绝',
      classify(outFile, r2) === 'denied',
      `判定=${classify(outFile, r2)} exit=${r2.code} stderr=${(r2.stderr || '').slice(0, 200)}`,
    );

    // ── read-only ────────────────────────────────────────────────────
    section('2) read-only：连工作区内也写不了');
    const roFile = path.join(workspace, 'readonly.txt');
    rm(roFile);
    const r3 = writeConfined('read-only', workspace, tempRoot, roFile);
    check(
      'read-only 下工作区内写入被拒绝',
      classify(roFile, r3) === 'denied',
      `判定=${classify(roFile, r3)} exit=${r3.code} stderr=${(r3.stderr || '').slice(0, 200)}`,
    );

    // ── 方言记录（不作断言，供人核对与后续分类使用）────────────────────
    section('3) 拒绝方言（记录用）');
    console.log(`  workspace-write 越界写 exit=${r2.code}`);
    console.log(`    stderr: ${JSON.stringify((r2.stderr || '').trim().slice(0, 300))}`);
    console.log(`  read-only 工作区内写 exit=${r3.code}`);
    console.log(`    stderr: ${JSON.stringify((r3.stderr || '').trim().slice(0, 300))}`);
    runnerDenialText = [r2.stderr, r3.stderr].filter(Boolean).join('\n');
  } finally {
    try {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.log(`  [注意] 临时目录未清理干净：${base}（${error.message}）`);
    }
  }

  modeResolutionSection();
  kernelAssemblySection();
  hostStatusSection();
  denialDialectSection([runnerDenialText]);

  console.log(`\n通过 ${passed} 项 / 失败 ${failed} 项`);
  if (failed > 0) console.log(`失败项：${failures.join('、')}`);
  // 显式退出：第 6 节会构造真实宿主，它可能留下未清句柄（调度器等），
  // 让进程挂着不退出会把「跑完了」伪装成「卡住了」。
  process.exit(failed > 0 ? 1 : 0);
}

/**
 * 模式解析规则。
 *
 * 这一节盯的是**产品侧的两个坑**：
 *  1. 用户已经在环境里设了内核变量时，我们不能用产品默认把它静默盖掉；
 *  2. 给了非法值时，不能既不改、又不留痕迹。
 */
function modeResolutionSection() {
  section('4) 模式解析（DSH_PERMISSION_MODE 从未被产品设置这件事的修法）');
  const { resolveSandboxMode, sandboxLaunchEnv, DEFAULT_SANDBOX_MODE, KERNEL_SANDBOX_ENV } =
    coreSandboxModule();

  const none = resolveSandboxMode({});
  check(
    '什么都没设 → 产品默认 + source=product-default',
    none.mode === DEFAULT_SANDBOX_MODE && none.source === 'product-default' && none.rejected === undefined,
    `实际 ${JSON.stringify(none)}`,
  );
  check(
    `产品默认与内核默认一致（${DEFAULT_SANDBOX_MODE}）`,
    DEFAULT_SANDBOX_MODE === 'workspace-write',
    `实际 ${DEFAULT_SANDBOX_MODE}`,
  );

  const byProduct = resolveSandboxMode({ DEEPWORK_SANDBOX_MODE: 'read-only' });
  check(
    'DEEPWORK_SANDBOX_MODE 生效',
    byProduct.mode === 'read-only' && byProduct.source === 'env-override',
    `实际 ${JSON.stringify(byProduct)}`,
  );

  // 关键：用户直接设的是**内核**变量、没设产品变量。
  // 若这里回落到产品默认，等于把用户的选择静默改掉。
  const byKernelVar = resolveSandboxMode({ [KERNEL_SANDBOX_ENV]: 'danger-full-access' });
  check(
    '用户直接设 DSH_PERMISSION_MODE 时不被产品默认覆盖',
    byKernelVar.mode === 'danger-full-access' && byKernelVar.source === 'env-override',
    `实际 ${JSON.stringify(byKernelVar)}`,
  );

  const both = resolveSandboxMode({
    DEEPWORK_SANDBOX_MODE: 'read-only',
    [KERNEL_SANDBOX_ENV]: 'danger-full-access',
  });
  check(
    '两个都设时产品侧优先（显式入口赢）',
    both.mode === 'read-only',
    `实际 ${JSON.stringify(both)}`,
  );

  const bad = resolveSandboxMode({ DEEPWORK_SANDBOX_MODE: 'readonly' });
  check(
    '非法值回落默认，且 rejected 留下原值（不静默）',
    bad.mode === DEFAULT_SANDBOX_MODE && bad.rejected === 'readonly',
    `实际 ${JSON.stringify(bad)}`,
  );
  const badWide = resolveSandboxMode({ DEEPWORK_SANDBOX_MODE: 'danger_full_access' });
  check(
    '打错的宽值不会被当成宽权限生效',
    badWide.mode === DEFAULT_SANDBOX_MODE && badWide.rejected === 'danger_full_access',
    `实际 ${JSON.stringify(badWide)}`,
  );

  const launchEnv = sandboxLaunchEnv('workspace-write');
  check(
    '交给内核的键名是 DSH_PERMISSION_MODE（内核的旋钮，不是自造的）',
    Object.keys(launchEnv).length === 1 && launchEnv[KERNEL_SANDBOX_ENV] === 'workspace-write',
    `实际 ${JSON.stringify(launchEnv)}`,
  );
}

function coreSandboxModule() {
  return require(path.join(ROOT, 'packages/core-host/dist/security/sandbox.js'));
}

/**
 * 内核拒绝方言的**逐字真帧副本** —— 不要手改它。
 *
 * 来源：`node tools/sandbox-e2e.js` 于 2026-09-15 跑出的 `tool.completed.output`
 * （场景 B1 workspace-write 越界、场景 C read-only 工作区内）。
 * 手改这份副本会让下面的断言变成「用我的假设验我的假设」——
 * 本项目上一版 `models.ts` 的自编目录就是这么活到文档里的。
 * 真帧本身由 sandbox-e2e.js 用**当场跑出来的输出**另行校验，两份互为独立参照。
 */
const REAL_DENIALS = {
  workspaceWrite: [
    'Error: [sandbox: file access denied under workspace-write mode]',
    '[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
  ].join('\n'),
  readOnly: [
    'Error: [sandbox: file access denied under read-only mode]',
    '[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
  ].join('\n'),
};

/**
 * 拒绝解析节。
 *
 * ── 为什么单列一节而不是塞进 e2e ──────────────────────────────────────
 * sandbox-e2e.js 在检测不到真实内核时会整份 SKIP。解析规则与平台、与内核安装
 * 都无关，不该跟着一起静默消失 —— 那会让「解析器坏了」在一台没装内核的机器上
 * 表现为全绿。这一节只依赖逐字副本，任何环境都要跑。
 */
function denialDialectSection(runnerOutputs = []) {
  section('7) 拒绝方言解析（界面上「被沙箱拦下」与「工具失败」的分界）');
  const { parseSandboxDenial, SANDBOX_ESCALATION_ARG, SANDBOX_MODES } = require(
    path.join(ROOT, 'packages/protocol/dist/security.js'),
  );

  const w = parseSandboxDenial(REAL_DENIALS.workspaceWrite);
  check(
    'workspace-write 越界真帧 → 档位正确',
    w !== null && w.mode === 'workspace-write' && w.knownMode === true,
    JSON.stringify(w),
  );
  check('workspace-write 真帧 → 认出升级路径', w?.escalation === true, JSON.stringify(w));

  const r = parseSandboxDenial(REAL_DENIALS.readOnly);
  check(
    'read-only 真帧 → 档位正确',
    r !== null && r.mode === 'read-only' && r.knownMode === true,
    JSON.stringify(r),
  );

  check(
    '升级入参名与内核真帧一致（sandbox_permissions）',
    SANDBOX_ESCALATION_ARG === 'sandbox_permissions' && REAL_DENIALS.readOnly.includes(SANDBOX_ESCALATION_ARG),
    SANDBOX_ESCALATION_ARG,
  );

  // 假阳性：解析器必须在「不是沙箱拒绝」时说不是。这条比正例更重要 ——
  // 一个过宽的正则会把所有工具失败都说成档位问题，用户会去改档位而问题依旧。
  check('普通工具失败不被误判', parseSandboxDenial('Error: EPERM: operation not permitted') === null);
  check('空输出不被误判', parseSandboxDenial('') === null);
  check(
    '提到 sandbox 但不含拒绝行的输出不被误判',
    parseSandboxDenial('sandbox mode is workspace-write; nothing to do') === null,
  );

  // 未知档位必须保真：内核将来加第四档时，界面要照实显示而不是当成「没拒绝」。
  const unknown = parseSandboxDenial(
    'Error: [sandbox: file access denied under quantum-superuser mode]',
  );
  check(
    '未知档位仍被识别为拒绝，但 knownMode=false（保真优先，不丢事实）',
    unknown !== null && unknown.mode === 'quantum-superuser' && unknown.knownMode === false,
    JSON.stringify(unknown),
  );
  check(
    '已知词汇仍只有内核的三个档位',
    SANDBOX_MODES.length === 3,
    SANDBOX_MODES.join('/'),
  );

  /*
   * ── 一条必须写下来的不对称，免得后来者以为解析器覆盖了全部沙箱 ──────────
   * 内核有**两条**能力族的拒绝，方言并不一样：
   *   · fs 族（模型改文件）→ `[sandbox: file access denied under <mode> mode]`，有显式标记；
   *   · shell 族（bash/pwsh）→ 裸 `EPERM: operation not permitted`，**没有**标记（本节上方第 3 节打印的就是它）。
   * 解析器只认前者，而且是**有意**的：`EPERM` 与「文件本来就只读 / ACL 不让写」
   * 长得一模一样，把它算成沙箱拒绝就是编结论。代价是 shell 族被拒时界面不会贴
   * 「被沙箱拦下」标签 —— 这是知情下的取舍，不是漏做。
   */
  const runnerText = runnerOutputs.join('\n');
  if (runnerText) {
    check(
      'shell 族的拒绝不带 [sandbox: 标记，解析器不认它（有意，见注释）',
      parseSandboxDenial(runnerText) === null && /EPERM/.test(runnerText),
      `runner 方言片段：${JSON.stringify(runnerText.slice(0, 120))}`,
    );
  }

  /*
   * 防漂移：mock 为渲染截图造的那一帧，必须与这里的真帧副本**逐字相同**。
   *
   * 这条断言存在的理由：「三处使用同一份方言」写进注释是拦不住人的 ——
   * 内核改方言时，改了一处、漏了两处的话，截图里显示的是旧方言、解析的是新方言，
   * 两边各自「正常」，只有把它们摆在一起才知道分家了。
   */
  const { MOCK_SANDBOX_DENIAL } = require(path.join(ROOT, 'packages/core-host/dist/adapter/mock-harness.js'));
  check(
    'mock 模拟帧与解析层参照物逐字相同（防三处漂移）',
    MOCK_SANDBOX_DENIAL === REAL_DENIALS.workspaceWrite,
    MOCK_SANDBOX_DENIAL === REAL_DENIALS.workspaceWrite
      ? ''
      : `mock=${JSON.stringify(MOCK_SANDBOX_DENIAL.slice(0, 80))}`,
  );

  escalationArgsSection();
}

/**
 * 升级申请入参的**逐字真帧副本** —— 不要手改它。
 *
 * 来源：`node tools/sandbox-e2e.js` 的 E1 场景（2026-09-16）—— 替换身端点照内核
 * 拒绝提示重试时，实际发出去的那一份 write 入参。它是内核校验通过、并落到
 * `tool_call.rawInput` 里的那份内容；宿主侧从它解析出档位与理由，已由 e2e 用
 * 「与发出去的那句逐字相同」另行校验，两份互为独立参照。
 *
 * ── 为什么这一节必须有 ──────────────────────────────────────────────
 * 升级申请的解析是**界面呈现的前提**：内核过 ACP 时把模型的理由丢了，
 * 全靠这一层从入参捞回来。它一旦坏掉，界面上的表现不是「少一行字」，
 * 而是用户面对一个「允许 / 拒绝」却不知道模型在申请什么 —— 版式上完全正常。
 * 纯函数断言不依赖真实内核，任何环境都要跑。
 */
const REAL_ESCALATION_ARGS = {
  path: 'C:/out/escape.txt',
  content: 'probe E1\n',
  sandbox_permissions: 'danger-full-access',
  justification: '探针要写到工作区外的 C:/out',
};

/**
 * 「用户拒绝了升级」时内核输出的**逐字真帧副本** —— 不要手改它。
 *
 * 来源：`node tools/sandbox-e2e.js` 的 E2 场景（2026-09-16）。
 * 它与 mock 内核里那帧 MOCK_ESCALATION_REJECTED 指同一份字面量，靠下方断言防漂移。
 */
const REAL_ESCALATION_REJECTED =
  'Error: the user rejected escalating this operation to "danger-full-access"';

function escalationArgsSection() {
  section('9) 升级申请解析（审批弹窗凭什么说清「模型在申请放宽档位」）');
  const { parseSandboxEscalation, SANDBOX_JUSTIFICATION_ARG } = require(
    path.join(ROOT, 'packages/protocol/dist/security.js'),
  );

  const parsed = parseSandboxEscalation(REAL_ESCALATION_ARGS);
  check(
    '真帧入参 → 认出升级申请，档位与理由逐字保真',
    parsed !== null &&
      parsed.mode === 'danger-full-access' &&
      parsed.knownMode === true &&
      parsed.justification === REAL_ESCALATION_ARGS.justification,
    JSON.stringify(parsed),
  );
  check(
    '配套理由的入参名与内核契约一致（justification）',
    SANDBOX_JUSTIFICATION_ARG === 'justification',
    SANDBOX_JUSTIFICATION_ARG,
  );

  // 没有升级参数时必须是 null，否则每一次普通写入的审批弹窗都会挂上「模型在申请放宽档位」
  check(
    '普通写入入参（无 sandbox_permissions）不被误判为升级申请',
    parseSandboxEscalation({ path: 'a.txt', content: 'x' }) === null,
  );
  check('空值 / 非对象入参不被误判', parseSandboxEscalation(undefined) === null && parseSandboxEscalation('x') === null);
  check(
    'sandbox_permissions 是空串时不算申请（内核同样不认它）',
    parseSandboxEscalation({ sandbox_permissions: '   ', justification: '理由' }) === null,
  );

  // 未知档位保真：与拒绝解析同一条纪律，不因为不认识就把申请抹掉
  const unknown = parseSandboxEscalation({ sandbox_permissions: 'quantum-superuser', justification: '理由' });
  check(
    '未知档位仍被识别为升级申请，knownMode=false（界面照实说是新档位，而不是当作没有申请）',
    unknown !== null && unknown.mode === 'quantum-superuser' && unknown.knownMode === false,
    JSON.stringify(unknown),
  );
  check(
    '缺 justification 时退化成空串而不是丢失整条申请（宿主仍有话可说）',
    parseSandboxEscalation({ sandbox_permissions: 'danger-full-access' })?.justification === '',
  );

  /*
   * 防漂移：mock 演示链演的那句拒绝原话，必须与真帧副本逐字相同。
   *
   * 与第 7 节最后一条同一条纪律：靠注释记住「两处一起改」是记不住的。
   * 这一句是要出现在截图上的，漂了就会变成「界面上演的和内核说的是两回事」。
   */
  const { MOCK_ESCALATION_REJECTED, MOCK_SANDBOX_ESCALATION } = require(
    path.join(ROOT, 'packages/core-host/dist/adapter/mock-harness.js'),
  );
  check(
    'mock 的「用户拒绝升级」原话与真帧副本逐字相同（防漂移）',
    MOCK_ESCALATION_REJECTED === REAL_ESCALATION_REJECTED,
    MOCK_ESCALATION_REJECTED === REAL_ESCALATION_REJECTED
      ? ''
      : `mock=${JSON.stringify(MOCK_ESCALATION_REJECTED.slice(0, 80))}`,
  );
  check(
    'mock 申请的档位与真帧副本一致，且解析层认得它（knownMode）',
    MOCK_SANDBOX_ESCALATION.mode === 'danger-full-access' &&
      parseSandboxEscalation({
        sandbox_permissions: MOCK_SANDBOX_ESCALATION.mode,
        justification: MOCK_SANDBOX_ESCALATION.justification,
      })?.knownMode === true,
    MOCK_SANDBOX_ESCALATION.mode,
  );
}

/**
 * 内核装配真帧：`dsh --profile acp --dump-config` 打出的是内核**组合后**的插件清单。
 *
 * 这一节回答的是本文件最重要的问题 ——「我们拧的这个旋钮，内核真的在读吗」。
 * 只断言「我们设了某个环境变量」是不够的（那可能是个谁也不看的变量）；
 * 权威依据在内核自己的装配里。
 */
function kernelAssemblySection() {
  section('5) 内核装配真帧（我们拧的旋钮内核真的在读吗）');
  const { SANDBOX_MODES } = require(path.join(ROOT, 'packages/protocol/dist/security.js'));

  const dshBin = path.join(ROOT, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (!fs.existsSync(dshBin)) {
    console.log('  [SKIP] 找不到仓库内的 dsh —— 该节只在装有内核依赖时运行');
    return;
  }

  let dump = '';
  const result = exec([dshBin, '--profile', 'acp', '--dump-config'], ROOT);
  dump = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
  if (result.code !== 0 || !dump.trim()) {
    check('dump-config 可读（没有装配清单就无从取证）', false, `exit=${result.code}`);
    return;
  }

  check(
    'sandbox-policy 的 mode 来源是 process.env.DSH_PERMISSION_MODE',
    /mode:\s*!!js[^\n]*DSH_PERMISSION_MODE/.test(dump),
    'dump 里没找到该引用 —— 内核可能换了旋钮名，产品的接线需要跟着改',
  );

  check(
    '任一平台都有沙箱后端被装配（不是「无实现」）',
    /@deepseek-ai\/dsh-sandbox-local/.test(dump) && /@deepseek-ai\/dsh-fs-sandbox/.test(dump),
    'dump 里找不到 sandbox-local / fs-sandbox',
  );

  // 词汇一致性：产品契约里的三个模式必须与内核预置的键完全相同。
  // 两边名字不一致的那天，界面显示的档位与内核执行的就是两回事。
  const presetKeys = [...dump.matchAll(/^\s{6}([a-z-]+):\s*$/gm)].map((m) => m[1]);
  const matched = SANDBOX_MODES.filter((m) => presetKeys.includes(m));
  check(
    `内核 permission-presets 的键与产品词汇一致（${SANDBOX_MODES.join(' / ')}）`,
    matched.length === SANDBOX_MODES.length,
    `dump 里认到的预置键：${JSON.stringify(presetKeys)}`,
  );
}

/**
 * 宿主真的把它交出来了吗。
 *
 * ── 为什么解析函数测过了还要再测一遍这个 ────────────────────────────
 * 「解析规则正确」与「宿主在启动时确实用了它、且确实放进了 `HostStatus`」是两件事。
 * 本项目栽过恰好前者对、后者错的跟头（白名单漏 `models.refresh`：函数写得没错，
 * 只是没有调用点），所以调用点必须有自己的哨兵 —— 否则界面那一格显示「未知」，
 * 而所有单元测试全是绿的。
 */
function hostStatusSection() {
  section('6) 宿主真的把它交出来了吗（status().sandbox）');
  const { DeepworkHost } = require(path.join(ROOT, 'packages/core-host/dist/host.js'));

  const plain = new DeepworkHost();
  const s1 = plain.status();
  check('status().sandbox 有值（不是只有类型定义）', Boolean(s1.sandbox), JSON.stringify(s1.sandbox));
  check(
    '默认模式 workspace-write、来源 product-default',
    s1.sandbox?.mode === 'workspace-write' && s1.sandbox?.source === 'product-default',
    JSON.stringify(s1.sandbox),
  );
  check(
    'win32 上带平台边界说明（其余平台允许为空）',
    process.platform !== 'win32' || typeof s1.sandbox?.note === 'string',
    JSON.stringify(s1.sandbox),
  );

  process.env.DEEPWORK_SANDBOX_MODE = 'read-only';
  try {
    const overridden = new DeepworkHost();
    const s2 = overridden.status();
    check(
      '环境变量覆盖真的进得了 status（证明宿主用了它，而不只是解析函数写对了）',
      s2.sandbox?.mode === 'read-only' && s2.sandbox?.source === 'env-override',
      JSON.stringify(s2.sandbox),
    );
  } finally {
    delete process.env.DEEPWORK_SANDBOX_MODE;
  }

  process.env.DEEPWORK_SANDBOX_MODE = 'nope';
  try {
    const bad = new DeepworkHost();
    const s3 = bad.status();
    check(
      '非法覆盖在 status 里留下 rejected（界面据此提示，而不是静默认了）',
      s3.sandbox?.rejected === 'nope' && s3.sandbox?.mode === 'workspace-write',
      JSON.stringify(s3.sandbox),
    );
  } finally {
    delete process.env.DEEPWORK_SANDBOX_MODE;
  }
}

main();
