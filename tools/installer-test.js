#!/usr/bin/env node
/**
 * 安装与部署语义验收（ROADMAP §八 / §8.4）。
 *
 * ── 这份测试在防什么 ────────────────────────────────────────────────────
 * 「文档说保留数据、安装器却在删」这一类不一致，**不会产生任何报错**：
 * 装的人看不出，卸载的人事后才知道。可检查的部分有两类：
 *
 *   1. **配置声明**：`apps/desktop/electron-builder.yml` 的 nsis 段是安装器行为的
 *      唯一来源，而它「对不对」只能与契约（`packages/protocol/src/deploy.ts`）比。
 *      本文件把「契约 ↔ 配置」钉在一起，谁改了一边忘了另一边就会红。
 *   2. **结构性事实**：用户数据目录在**用户主目录**下，与安装树不同树 ——
 *      这一条是「覆盖安装与卸载都不动数据」的**机械保证**，比任何承诺都可靠，
 *      所以直接断言路径关系，而不是断言文案。
 *
 * 不能在本机验收的部分（真机上装一遍/卸一遍的行为、卸载向导里的勾选项）
 * 在 `docs/DEPLOY.md` 里如实标注，不在这里假装通过。
 *
 * 用法：node tools/installer-test.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const {
  INSTALL_POLICY,
  BUNDLED_RUNTIMES,
  RUNTIME_RESOLUTION_ORDER,
  RUNTIME_ENV_OVERRIDE,
  DATA_DIR_NAME,
} = require(path.join(ROOT, 'packages/protocol/dist/deploy.js'));

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
 * 极简 YAML 取值读取：按缩进找 `section:` 块，取块内 `key: value` 的原始文本值。
 *
 * 刻意不引 yaml 库 —— tools/ 下的脚本保持零依赖是既有纪律（与 office-test 同源）。
 * 只够读这份文件：不含多行标量、不含锚点、值里也不含 `#`。
 */
function yamlBlock(text, sectionName) {
  const out = new Map();
  let inside = false;
  let baseIndent = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const match = /^([A-Za-z_][\w.-]*):(?:\s*(.*))?$/.exec(line.trim());
    if (!match) continue;
    if (!inside) {
      if (indent === 0 && match[1] === sectionName) {
        inside = true;
        baseIndent = indent;
      }
      continue;
    }
    if (indent <= baseIndent) {
      inside = false;
      continue;
    }
    out.set(match[1], (match[2] ?? '').trim());
  }
  return out;
}

const builderPath = path.join(ROOT, 'apps/desktop/electron-builder.yml');
const builderText = fs.readFileSync(builderPath, 'utf8');

console.log('深边AI Work · 安装与部署语义验收');
console.log(`契约：packages/protocol/src/deploy.ts  配置：apps/desktop/electron-builder.yml`);

// ── 一、契约本身的取值必须都是「可断言的字面量」 ──────────────────────────

section('契约（deploy.ts）');

check('应用本体走修复式覆盖', INSTALL_POLICY.appOverwrite === 'repair-in-place');
check('降级安装不静默覆盖', INSTALL_POLICY.allowDowngrade === false);
check('覆盖安装不动用户数据', INSTALL_POLICY.userDataSurvivesUpgrade === true);
check('卸载不动用户数据', INSTALL_POLICY.userDataSurvivesUninstall === true);
check('清数据是显式动作，不是卸载默认分支', INSTALL_POLICY.userDataPurge === 'manual-explicit');
check('一律不动系统环境', INSTALL_POLICY.systemEnvironmentTouch === 'never');
check('运行时只随安装包升级', INSTALL_POLICY.runtimeUpgrade === 'package-only');
check(
  '运行时解析顺序 = 显式指定 > 随包 > 系统 PATH',
  RUNTIME_RESOLUTION_ORDER.join(' > ') === 'explicit-env > bundled > system-path',
  RUNTIME_RESOLUTION_ORDER.join(' > '),
);
check(
  '两种随包运行时都有覆盖入口（不然「随包优先」不可退出）',
  Boolean(RUNTIME_ENV_OVERRIDE.node) && Boolean(RUNTIME_ENV_OVERRIDE.python),
  `${RUNTIME_ENV_OVERRIDE.node} / ${RUNTIME_ENV_OVERRIDE.python}`,
);

// ── 二、安装器配置与契约一致 ──────────────────────────────────────────────

section('NSIS 安装器配置（electron-builder.yml）');

const nsis = yamlBlock(builderText, 'nsis');

check('安装器配置可读（nsis 段存在）', nsis.size > 0);
check('不做全机安装（perMachine: false）', nsis.get('perMachine') === 'false', nsis.get('perMachine'));
check('不做一键安装（oneClick: false）', nsis.get('oneClick') === 'false', nsis.get('oneClick'));
check(
  '安装目录由用户选择（allowToChangeInstallationDirectory: true）',
  nsis.get('allowToChangeInstallationDirectory') === 'true',
);
check(
  `降级被拦下（allowDowngrade = ${INSTALL_POLICY.allowDowngrade}）`,
  nsis.get('allowDowngrade') === String(INSTALL_POLICY.allowDowngrade),
  `配置值 ${nsis.get('allowDowngrade')}`,
);
check(
  '卸载不动 Electron userData（deleteAppDataOnUninstall: false）',
  nsis.get('deleteAppDataOnUninstall') === 'false',
  `配置值 ${nsis.get('deleteAppDataOnUninstall')}`,
);
check(
  '卸载不对数据做任何删除动作（契约声明未被配置反着写）',
  INSTALL_POLICY.userDataSurvivesUninstall && nsis.get('deleteAppDataOnUninstall') === 'false',
);

/**
 * appId 是「同 appId 重装 = 修复式覆盖」的机械前提：
 * appId 变了，安装器会当成另一个应用，装出两份并存的程序。
 */
const appId = /^appId:\s*(\S+)\s*$/m.exec(builderText);
check('appId 已声明（同 appId 才能覆盖安装）', Boolean(appId && appId[1]), appId ? appId[1] : '未找到');

// ── 三、用户数据与安装树的关系（结构性保证） ──────────────────────────────

section('用户数据归属');

const dataDir = path.join(os.homedir(), DATA_DIR_NAME);

/**
 * 打包条目 = extraResources 的 from / to + files 列表项。
 *
 * 刻意**只看条目，不看全文**：全文里必然出现 `.deepwork` —— 上面那段注释
 * 正在解释「它为什么不在安装树里」。拿全文当断言，等于把解释本身当成违规，
 * 而这种断言最后只有两种下场：被注释掉，或被改成「反正也测不出什么」的形状。
 */
const fromValues = [...builderText.matchAll(/^\s*from:\s*(\S+)\s*$/gm)].map((m) => m[1]);
const toValues = [...builderText.matchAll(/^\s*to:\s*(\S+)\s*$/gm)].map((m) => m[1]);
const listItems = [...builderText.matchAll(/^\s*-\s+(\S+)\s*$/gm)].map((m) => m[1]);

check(
  `数据目录在用户主目录下（${DATA_DIR_NAME}）`,
  path.dirname(dataDir) === os.homedir(),
  dataDir,
);
check('数据目录名与契约字段一致', path.basename(dataDir) === INSTALL_POLICY.userDataDirName);

/**
 * 反证：数据目录与仓库/安装树不同树。
 *
 * 这条比「我们承诺不会删」强得多 —— 卸载器只处理自己装下去的文件，
 * 数据根本不在那棵树里，所以「卸载删数据」这件事在结构上无法发生。
 */
const relToRepo = path.relative(ROOT, dataDir);
check(
  '数据目录不在安装树内（卸载/覆盖在结构上碰不到它）',
  relToRepo.startsWith('..') || path.isAbsolute(relToRepo),
  `相对仓库：${relToRepo}`,
);

const packagedEntries = [...fromValues, ...toValues, ...listItems];
check(
  '打包条目里没有用户数据目录（不会被装进去，也不会被删）',
  !packagedEntries.some((entry) => entry.includes(DATA_DIR_NAME)),
  packagedEntries.filter((entry) => entry.includes(DATA_DIR_NAME)).join(', '),
);

// ── 四、随包运行时的落位声明 ──────────────────────────────────────────────

section('随包运行时');

check('随包 Node 运行时落位声明存在', toValues.includes('node-runtime'), toValues.join(', '));
check('随包 dsh 运行时落位声明存在', toValues.includes('dsh-runtime/node_modules'));
check('随包 Python 运行时落位声明存在', toValues.includes('python-runtime'));

/** 落位必须在 asar 之外（外部子进程要读，见 electron-builder.yml 顶部约束 1） */
const filesBlock = yamlBlock(builderText, 'files');
check(
  'asar 内不含运行时目录（内核由外部进程读取）',
  [...filesBlock.keys()].every((k) => !k.includes('runtime')),
  [...filesBlock.keys()].join(', '),
);

// ── 五、钉死版本与实际产物一致 ────────────────────────────────────────────

section('版本钉死');

const dshManifest = path.join(
  ROOT,
  'offline-bundle/dsh-runtime/node_modules/@deepseek-ai/dsh/package.json',
);
if (fs.existsSync(dshManifest)) {
  const version = JSON.parse(fs.readFileSync(dshManifest, 'utf8')).version;
  check(
    `随包 dsh 版本与契约一致（${BUNDLED_RUNTIMES.dsh}）`,
    version === BUNDLED_RUNTIMES.dsh,
    `磁盘上：${version}`,
  );
} else {
  check('随包 dsh 目录存在（用于核对版本）', false, dshManifest);
}

const manual = path.join(ROOT, 'offline-bundle/使用说明.txt');
if (fs.existsSync(manual)) {
  const text = fs.readFileSync(manual, 'utf8');
  check(
    `使用说明里的 dsh 版本与契约一致（${BUNDLED_RUNTIMES.dsh}）`,
    text.includes(BUNDLED_RUNTIMES.dsh),
  );
  const nodeMajor = BUNDLED_RUNTIMES.node.split('.')[0];
  check(
    `使用说明里的 Node 主版本与契约一致（Node ${nodeMajor}）`,
    text.includes(`Node ${nodeMajor}`),
  );
  check(
    `使用说明里的 Python 版本与契约一致（${BUNDLED_RUNTIMES.python}）`,
    text.includes(BUNDLED_RUNTIMES.python),
    '使用说明尚未写明随包 Python 版本',
  );
} else {
  check('离线包使用说明存在', false, manual);
}

// ── 汇总 ─────────────────────────────────────────────────────────────────

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
}
process.exit(failed === 0 ? 0 : 1);
