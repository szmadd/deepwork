'use strict';

/**
 * 模型配置（端点/凭据）测试。
 *
 *   npm run test:modelcfg
 *
 * 三层断言：
 *   1. 单元：端点覆盖补丁形状、运行时补丁序列化、credentials refs 合并、secrets 分模式存储；
 *   2. host 链路（mock 内核）：配置写入即出补丁文件、会话默认模型、apiKey RPC 只回掩码；
 *   3. 真实 dsh 端到端：自定义端点 = 本地 stub，断言**自定义模型名真的发到了端点**
 *      （requests[0].model === 'qwen-local-7b'）—— 「配置写了但内核还在用旧模型」
 *      只能靠它抓出来。dsh 缺席时优雅 SKIP。
 *
 * 历史教训（2026-09-13）：端点配置曾走 settings.yaml 热重载，与 session/new 公布
 * 目录存在竞态（同一配置间歇性失效）。现在走 --patch 覆盖补丁，组合期应用、
 * 启动即确定 —— 本测试第 3 段必须连跑多轮不抖才算数。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-modelcfg-'));
const deepworkHome = path.join(root, '.deepwork');
const dshHome = path.join(root, '.dsh');
process.env.DEEPWORK_HOME = deepworkHome;
process.env.DSH_HOME = dshHome;
delete process.env.DEEPSEEK_BASE_URL;

const {
  modelEndpointOverride,
  syncModelCredentials,
  setApiKey,
  getApiKey,
  clearApiKey,
  maskApiKey,
} = require('../packages/core-host/dist/models/endpoint');
const { buildRuntimePatch, serializeRuntimePatchYaml } = require('../packages/core-host/dist/mcp/patch');
const { DeepworkHost } = require('../packages/core-host/dist/host');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const credFile = () => path.join(dshHome, '.credentials.yaml');
const patchFile = () => path.join(deepworkHome, 'runtime', 'kernel.patch.yml');
const readMaybe = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

// ══════════════════════════════════════════════════════════
// 1. 覆盖补丁与凭据单元
// ══════════════════════════════════════════════════════════
console.log('\n── 端点补丁与凭据 ──');

{
  const override = modelEndpointOverride({ kind: 'custom', baseUrl: 'http://localhost:11434/v1/', model: 'qwen2.5:7b' });
  check(
    'custom 生成 llm-deepseek 覆盖条目',
    override?.id === 'llm-deepseek'
      && override?.name === '@deepseek-ai/dsh-llm-deepseek'
      && override?.config?.baseURL === 'http://localhost:11434/v1',
    JSON.stringify(override?.config),
  );
  check(
    'models 目录含自定义模型',
    override?.config?.models?.[0]?.id === 'qwen2.5:7b' && override.config.models[0].contextWindow > 0,
  );
  check('端点尾部斜杠被规范化', !override.config.baseURL.endsWith('/'));
  check('official 不生成覆盖条目', modelEndpointOverride({ kind: 'official' }) === null);

  const yaml = serializeRuntimePatchYaml([override]);
  check(
    '覆盖补丁 YAML 形状（id/name/config/models）',
    yaml.includes('- id: "llm-deepseek"')
      && yaml.includes('name: "@deepseek-ai/dsh-llm-deepseek"')
      && yaml.includes('baseURL: "http://localhost:11434/v1"')
      && yaml.includes('- id: "qwen2.5:7b"')
      && yaml.includes('contextWindow: 131072'),
  );

  const merged = buildRuntimePatch([], override);
  check('运行时补丁合并（仅端点）', merged?.length === 1 && 'id' in merged[0]);
  check('全空返回 null（内核零改动启动）', buildRuntimePatch([], null) === null);
}

{
  let threw = false;
  try {
    modelEndpointOverride({ kind: 'custom', baseUrl: 'localhost:11434', model: 'x' });
  } catch { threw = true; }
  check('缺协议的 baseUrl 被拒绝', threw);
  threw = false;
  try {
    modelEndpointOverride({ kind: 'custom', baseUrl: 'http://x/v1', model: ' ' });
  } catch { threw = true; }
  check('空模型名被拒绝', threw);
}

{
  const r1 = syncModelCredentials({ kind: 'custom', baseUrl: 'http://x/v1', model: 'm' });
  check('无 key 时凭据写占位值', readMaybe(credFile()).includes('DEEPSEEK_API_KEY: deepwork-no-key'), r1.detail);

  setApiKey('custom', 'sk-local-test-9999');
  syncModelCredentials({ kind: 'custom', baseUrl: 'http://x/v1', model: 'm' });
  check('设置 key 后凭据同步真实值', readMaybe(credFile()).includes('DEEPSEEK_API_KEY: sk-local-test-9999'));

  fs.appendFileSync(credFile(), '  OTHER_KEY: keep-me\n', 'utf8');
  syncModelCredentials({ kind: 'custom', baseUrl: 'http://x/v1', model: 'm' });
  const cred = readMaybe(credFile());
  check('refs 合并不丢其它键', cred.includes('OTHER_KEY: keep-me') && cred.includes('DEEPSEEK_API_KEY'));

  setApiKey('official', 'sk-official-aaaa');
  check('secrets 按模式分存', getApiKey('official') === 'sk-official-aaaa' && getApiKey('custom') === 'sk-local-test-9999');
  // 样例值必须是「形似但绝非真 key」的字符串（含非十六进制字符）：
  // 真实 DeepSeek key 是 sk- + 32 位纯 hex，任何真凭据都不许进仓库（见下方红线检查）。
  const fakeKey = 'sk-test0000test0000test0000test0000';
  const masked = maskApiKey(fakeKey);
  check('掩码不含明文主体', masked.endsWith('0000') && !masked.includes('test0000'), masked);
  clearApiKey('official');
  clearApiKey('custom');
  check('清除后按模式读取为空', getApiKey('official') === null && getApiKey('custom') === null);

  // 凭据红线：git 跟踪的文件里不允许出现 sk- + 32 位纯十六进制（真 DeepSeek key 形态）。
  // M2 轮曾把真实 key 当测试样例写进本文件并推上公开仓库（GitGuardian 告警），此检查防再犯。
  const tracked = require('node:child_process')
    .execSync('git ls-files', { encoding: 'utf8', cwd: path.join(__dirname, '..') })
    .split('\n').filter(Boolean);
  const offenders = [];
  for (const rel of tracked) {
    if (/\.(png|pak|asar|exe|dll|bin|ofd|docx|xlsx)$/.test(rel)) continue;
    try {
      const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      if (/sk-[a-f0-9]{32}/.test(text)) offenders.push(rel);
    } catch { /* 二进制等不可读文件跳过 */ }
  }
  check('凭据红线：仓库内无真实形态的 apikey', offenders.length === 0, offenders.join(', ') || '干净');
}

// ══════════════════════════════════════════════════════════
// 2. host 链路（mock 内核）
// ══════════════════════════════════════════════════════════
console.log('\n── host 配置链路 ──');

async function hostSection() {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const host = new DeepworkHost();
  await host.start(workspace);

  host.setConfig({ modelEndpoint: { kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'qwen-local-7b' } });
  const patch = readMaybe(patchFile());
  check('config.set 端点即出补丁文件', patch.includes('"llm-deepseek"') && patch.includes('"qwen-local-7b"'));

  const session = host.createSession({ workspace, title: 't' });
  check('custom 模式新会话默认端点模型', session.model === 'qwen-local-7b', session.model);

  const models = host.models();
  check('models() 返回自定义条目', models.length === 1 && models[0].id === 'qwen-local-7b', JSON.stringify(models.map((m) => m.id)));

  const st0 = host.modelApiKeyStatus();
  check('apiKey 状态初始未设置（两种模式均已清除）', st0.set === false);
  const st1 = host.setModelApiKey('sk-custom-bbbb');
  check('apiKey 设置后返回掩码而非明文', st1.set === true && st1.masked.endsWith('bbbb') && !st1.masked.includes('sk-custom'), st1.masked);
  check('apiKey 落进 dsh 凭据', readMaybe(credFile()).includes('DEEPSEEK_API_KEY: sk-custom-bbbb'));
  const st2 = host.clearModelApiKey();
  check('apiKey 清除后占位值兜底', st2.set === false && readMaybe(credFile()).includes('deepwork-no-key'));

  host.setConfig({ modelEndpoint: { kind: 'official' } });
  // 切回 official：端点覆盖条目被移除。注意补丁文件本身仍在 —— 内置浏览器 MCP 服务
  // 常驻注入（M2-H），所以断言看的是「端点覆盖没了」而不是「文件没了」；
  // 断文件存在与否会写死「补丁只可能由端点/连接器产生」这个实现细节。
  const officialPatch = readMaybe(patchFile());
  check('切回 official：端点覆盖条目被移除',
    !officialPatch.includes('"llm-deepseek"') && !officialPatch.includes('"qwen-local-7b"'));

  await host.stop();
}

// ══════════════════════════════════════════════════════════
// 3. 真实 dsh 端到端：自定义模型名必须真的到达端点
// ══════════════════════════════════════════════════════════
console.log('\n── 真实 dsh 自定义端点 ──');

async function realDshSection() {
  const dshBin = path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(dshBin)) {
    console.log('  [SKIP] 未找到 dsh，跳过真实内核段');
    return;
  }
  const { HarnessSidecarAdapter } = require('../packages/core-host/dist/adapter/harness-sidecar');
  const { startStubLlm } = require('./fixtures/openai-stub-llm');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-modelcfg-ws-'));
  const targetFile = path.join(workspace, 'CUSTOM.md');
  const stub = await startStubLlm({
    script: [
      { tool: { pick: 'write', args: { file_path: targetFile, content: 'custom endpoint ok' } } },
      { text: '已写入。' },
    ],
  });

  // 走产品真实路径：覆盖补丁 + 凭据同步（补丁是确定性路径，不再是 settings.yaml）
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-modelcfg-dsh-'));
  process.env.DSH_HOME = realHome;
  const override = modelEndpointOverride({ kind: 'custom', baseUrl: stub.url, model: 'qwen-local-7b' });
  syncModelCredentials({ kind: 'custom', baseUrl: stub.url, model: 'qwen-local-7b' });
  const patchPath = path.join(realHome, 'kernel.patch.yml');
  fs.writeFileSync(patchPath, serializeRuntimePatchYaml(buildRuntimePatch([], override)), 'utf8');

  const adapter = new HarnessSidecarAdapter({
    command: process.execPath,
    args: [dshBin, '--profile', 'acp'],
    workspace,
    model: 'qwen-local-7b',
    startupTimeoutMs: 30_000,
    env: { DSH_HOME: realHome },
    patchFile: patchPath,
  });

  const events = [];
  const controller = new AbortController();
  try {
    await adapter.start();
    const status = await adapter.run({
      runId: 'run-1',
      sessionId: 'sess-1',
      text: '把 "custom endpoint ok" 写入 CUSTOM.md',
      attachments: [],
      workspace,
      mode: 'standard',
      model: 'qwen-local-7b',
      guard: { assess: () => ({ risk: 'safe', reason: '', blocked: false }) },
      tools: {},
      emit: (e) => events.push(e),
      requestApproval: async () => ({ approved: true }),
      signal: controller.signal,
    });

    check('run 完成', status === 'completed', `status=${status}`);
    check(
      '自定义模型名真的到达端点',
      stub.requests.length > 0 && stub.requests[0].model === 'qwen-local-7b',
      `requests=${stub.requests.length} model=${stub.requests[0]?.model}`,
    );
    check('端点请求未夹带官方模型名', stub.requests.every((r) => r.model === 'qwen-local-7b'));
    check(
      '工具落盘经自定义端点完成',
      fs.existsSync(targetFile) && fs.readFileSync(targetFile, 'utf8').includes('custom endpoint ok'),
    );
  } finally {
    await adapter.stop().catch(() => undefined);
    await stub.close();
  }
}

async function main() {
  await hostSection();
  // 竞态教训：真实段连跑两轮，补丁路径必须轮轮一致
  await realDshSection();
  await realDshSection();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n模型配置测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
