'use strict';

/**
 * 模型配置（端点/凭据/目录）测试。
 *
 *   npm run test:modelcfg
 *
 * 四层断言：
 *   1. 单元：端点覆盖补丁形状、运行时补丁序列化、credentials refs 合并、secrets 分模式存储；
 *   2. 目录解析（纯函数）：拿**真实内核帧的逐字副本**断言模型清单怎么来的 ——
 *      显示名以内核为准、没有 contextWindow 这个字段、模型值与裸模型名的映射；
 *   3. host 链路（mock 内核）：配置写入即出补丁文件、**用户选定的默认模型不被端点覆盖**、
 *      apiKey RPC 只回掩码；
 *   4. 真实 dsh 端到端：自定义端点 = 本地 stub，断言**自定义模型名真的发到了端点**
 *      （requests[0].model === 'qwen-local-7b'），并把内核真帧解析出的目录打出来 ——
 *      「配置写了但内核还在用旧模型」只能靠它抓出来。dsh 缺席时优雅 SKIP。
 *
 * 历史教训（2026-09-13）：端点配置曾走 settings.yaml 热重载，与 session/new 公布
 * 目录存在竞态（同一配置间歇性失效）。现在走 --patch 覆盖补丁，组合期应用、
 * 启动即确定 —— 本测试第 4 段必须连跑多轮不抖才算数。
 *
 * 历史教训（2026-09-14）：清单曾在源码里写死四个官方模型，带自编的显示名与
 * contextWindow。它不会被任何测试发现 —— 因为它就是「期望值」本身。
 * 所以第 2 段用的是探针落盘的真帧副本，而不是手写一份好看的 JSON。
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
const {
  parseModelOptionValue,
  matchModelValue,
  matchPlainValue,
  findOption,
  catalogFromConfigOptions,
} = require('../packages/core-host/dist/models/catalog');
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
  const override = modelEndpointOverride({ kind: 'custom', baseUrl: 'http://127.0.0.1:8000/v1/', model: 'qwen-local-7b' });
  check(
    'custom 生成 llm-deepseek 覆盖条目',
    override?.id === 'llm-deepseek'
      && override?.name === '@deepseek-ai/dsh-llm-deepseek'
      && override?.config?.baseURL === 'http://127.0.0.1:8000/v1',
    JSON.stringify(override?.config),
  );
  check(
    'models 目录含自定义模型',
    override?.config?.models?.[0]?.id === 'qwen-local-7b' && override.config.models[0].contextWindow > 0,
  );
  check('端点尾部斜杠被规范化', !override.config.baseURL.endsWith('/'));
  check('official 不生成覆盖条目', modelEndpointOverride({ kind: 'official' }) === null);

  // 上下文窗口：用户填了就用用户的。写死一个数字当事实是上一版的问题 ——
  // 这个数端点不会告诉我们，只有用户知道；但 schema 又必须有它。
  const sized = modelEndpointOverride({
    kind: 'custom',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'qwen-local-7b',
    contextWindow: 65_536,
  });
  check('端点填的 contextWindow 透传进补丁', sized?.config?.models?.[0]?.contextWindow === 65_536);

  let threw = false;
  try {
    modelEndpointOverride({
      kind: 'custom',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'x',
      contextWindow: -1,
    });
  } catch { threw = true; }
  check('非法 contextWindow 被拒绝', threw);

  const yaml = serializeRuntimePatchYaml([override]);
  check(
    '覆盖补丁 YAML 形状（id/name/config/models）',
    yaml.includes('- id: "llm-deepseek"')
      && yaml.includes('name: "@deepseek-ai/dsh-llm-deepseek"')
      && yaml.includes('baseURL: "http://127.0.0.1:8000/v1"')
      && yaml.includes('- id: "qwen-local-7b"')
      && yaml.includes('contextWindow: 131072'),
    '131072 = 用户未填时的估计值（DEFAULT_ENDPOINT_CONTEXT_WINDOW）',
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
// 2. 目录解析：用真实内核帧的逐字副本
// ══════════════════════════════════════════════════════════
console.log('\n── 模型目录解析（真帧）──');

{
  /**
   * 以下 JSON 是 `node tools/real-dsh-probe.js`（2026-09-14，dsh 0.1.5-rc.1）落盘的
   * `session/new` 结果的逐字副本，只删掉了 sessionId。**不要手改它**：
   * 它是这一层唯一的参照物，改一次就等于把「内核说了什么」换成「我们以为内核说了什么」。
   */
  const REAL_CONFIG_OPTIONS = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: '["deepseek-official","deepseek-v4-flash"]',
      options: [
        {
          group: 'deepseek-official',
          name: 'DeepSeek',
          options: [
            { value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' },
            {
              value: '["deepseek-official","deepseek-v4-flash"]',
              name: 'DeepSeek-V4-Flash',
              description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
            },
            {
              value: '["deepseek-official","deepseek-v4-pro"]',
              name: 'DeepSeek-V4-Pro',
              description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
            },
            { value: '["deepseek-official","deepseek-v4-flash-vision-exp"]', name: 'DeepSeek-V4-Flash-Vision-Exp' },
          ],
        },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'off', name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
        { value: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
        { value: 'high', name: 'High', description: 'The default balance for most tasks.' },
        { value: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
      ],
    },
  ];

  const grouped = parseModelOptionValue('["deepseek-official","deepseek-v4-flash"]');
  check(
    '模型值（JSON 元组）解析出提供方与模型名',
    grouped.provider === 'deepseek-official' && grouped.model === 'deepseek-v4-flash',
    JSON.stringify(grouped),
  );
  check(
    '裸模型名也解析（退化为模型名而不是报错）',
    parseModelOptionValue('qwen-local-7b').model === 'qwen-local-7b',
    JSON.stringify(parseModelOptionValue('qwen-local-7b')),
  );

  const catalog = catalogFromConfigOptions(REAL_CONFIG_OPTIONS);
  check('从真帧解析出目录', catalog !== null);
  check(
    '模型清单 = 内核公布的四个（顺序一致）',
    catalog.models.map((m) => m.id).join(',')
      === 'deepseek-flash,deepseek-v4-flash,deepseek-v4-pro,deepseek-v4-flash-vision-exp',
    catalog.models.map((m) => m.id).join(','),
  );
  // 这一条是本次改动的核心：显示名必须来自内核帧，而不是我们自编的好听名字。
  check(
    '显示名以内核为准（DeepSeek-V41-Flash，不是自编的 DeepSeek V4.1 Flash）',
    catalog.models[0].label === 'DeepSeek-V41-Flash',
    catalog.models[0].label,
  );
  check('provider 取分组显示名（DeepSeek）', catalog.models.every((m) => m.provider === 'DeepSeek'));
  check('条目来源标注为 kernel', catalog.models.every((m) => m.source === 'kernel'));
  // 内核帧里根本没有这个字段 —— 所以解析结果里也不许冒出一个人造值来
  check(
    '不伪造 contextWindow（真帧没有这个字段）',
    catalog.models.every((m) => !('contextWindow' in m)),
    Object.keys(catalog.models[0]).join(','),
  );
  check('内核默认模型取 currentValue', catalog.kernelDefaultModel === 'deepseek-v4-flash', String(catalog.kernelDefaultModel));

  check(
    '推理档位 = 内核公布的四个',
    catalog.reasoningEfforts.map((e) => e.value).join(',') === 'off,low,high,max',
    catalog.reasoningEfforts.map((e) => e.value).join(','),
  );
  check(
    '推理档位带上了内核给的解释（不自己写文案）',
    catalog.reasoningEfforts[3].description.startsWith('Reserve for the hardest'),
    catalog.reasoningEfforts[3].description,
  );
  check('内核默认推理档位 = high', catalog.kernelDefaultReasoningEffort === 'high');

  const modelOption = findOption(REAL_CONFIG_OPTIONS, 'model');
  check(
    '发回内核的取值是原样的 JSON 元组',
    matchModelValue(modelOption, 'deepseek-v4-flash') === '["deepseek-official","deepseek-v4-flash"]',
    String(matchModelValue(modelOption, 'deepseek-v4-flash')),
  );
  check('未公布的模型名返回 null（保持内核默认）', matchModelValue(modelOption, 'gpt-oss-120b') === null);
  // 反子串匹配：旧实现用 value.includes('"'+model+'"')，模型名叫 'flash' 时
  // 会命中任何一个含 flash 的条目 —— 那种「匹配上了但匹配错了」不会报错。
  check('不接受子串匹配（"flash" 不与任何条目相等）', matchModelValue(modelOption, 'flash') === null);

  const effortOption = findOption(REAL_CONFIG_OPTIONS, 'reasoning_effort');
  check('推理档位按取值匹配', matchPlainValue(effortOption, 'max') === 'max');
  check('未公布的推理档位返回 null', matchPlainValue(effortOption, 'ultra') === null);

  check('没有 model 项的真帧 → null（不伪造清单）', catalogFromConfigOptions([REAL_CONFIG_OPTIONS[1]]) === null);
  check('空 configOptions → null', catalogFromConfigOptions([]) === null);
  check('undefined configOptions → null', catalogFromConfigOptions(undefined) === null);
}

// ══════════════════════════════════════════════════════════
// 3. host 链路（mock 内核）
// ══════════════════════════════════════════════════════════
console.log('\n── host 配置链路 ──');

async function hostSection() {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const host = new DeepworkHost();
  await host.start(workspace);

  host.setConfig({ modelEndpoint: { kind: 'custom', baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen-local-7b' } });
  const patch = readMaybe(patchFile());
  check('config.set 端点即出补丁文件', patch.includes('"llm-deepseek"') && patch.includes('"qwen-local-7b"'));

  // ── 默认模型的优先级（本轮修掉的静默覆盖）─────────────────────
  // 用户在设置页选定的默认模型，不许被端点配置顶掉。
  // 曾经的顺序是「端点模型 > 配置默认」，后果是界面显示他选的、实际跑另一个。
  host.setConfig({ defaultModel: 'my-chosen-model' });
  const chosen = host.createSession({ workspace, title: 'chosen' });
  check(
    '用户选定的默认模型优先于端点模型',
    chosen.model === 'my-chosen-model',
    `model=${chosen.model}`,
  );

  // 空串 = 跟随：没有内核真帧时退到端点填的模型（这是合理的兜底，不是覆盖用户选择）
  host.setConfig({ defaultModel: '' });
  const followed = host.createSession({ workspace, title: 'follow' });
  check(
    '默认模型留空时退到端点模型（跟随，而非覆盖）',
    followed.model === 'qwen-local-7b',
    `model=${followed.model}`,
  );

  // 显式指定永远最优先（界面上那一栏选的模型）
  const explicit = host.createSession({ workspace, title: 'explicit', model: 'qwen-local-7b' });
  check('显式指定的模型优先于一切', explicit.model === 'qwen-local-7b', explicit.model);
  host.setConfig({ defaultModel: '' });

  const catalog = await host.modelCatalog();
  check(
    'custom 端点时目录只有端点那一个模型，且标注来源为 endpoint',
    catalog.models.length === 1
      && catalog.models[0].id === 'qwen-local-7b'
      && catalog.models[0].source === 'endpoint',
    JSON.stringify(catalog.models.map((m) => `${m.id}:${m.source}`)),
  );
  check('端点目录如实说明「未与端点核对」', catalog.note.includes('未与端点核对'), catalog.note);
  check('端点条目带上 baseUrl 供界面区分同名模型', catalog.models[0].endpoint === 'http://127.0.0.1:8000/v1');
  check('端点未填 contextWindow 时条目不带该字段（未知就说未知）', !('contextWindow' in catalog.models[0]));

  host.setConfig({
    modelEndpoint: { kind: 'custom', baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen-local-7b', contextWindow: 32_768 },
  });
  const sized = await host.modelCatalog();
  check('端点填了 contextWindow 时条目带上它', sized.models[0].contextWindow === 32_768, String(sized.models[0].contextWindow));

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

  // mock 内核没有 ACP 会话，也就没有真帧 —— 目录必须是 mock 自己的条目，
  // 而不是一份看起来很像官方的清单。
  const mockCatalog = await host.modelCatalog();
  check(
    'mock 内核的目录只列 mock-echo 并标注来源',
    mockCatalog.source === 'mock' && mockCatalog.models.length === 1 && mockCatalog.models[0].id === 'mock-echo',
    JSON.stringify(mockCatalog.models.map((m) => m.id)),
  );
  check('mock 目录不提供推理档位（内核没公布就不编）', mockCatalog.reasoningEfforts.length === 0);

  await host.stop();
}

// ══════════════════════════════════════════════════════════
// 4. 真实 dsh 端到端：自定义模型名必须真的到达端点
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
  /**
   * 再塞一个模型进补丁。
   *
   * 为什么需要第二个：本段要验的是「同一会话中途换模型」——
   * 补丁里只注册一个模型时，换模型这个动作在内核侧无值可设，
   * 测试会退化成「什么都没验还全绿」。两个模型都指向同一个 stub，
   * 所以「请求里的 model 变了」只可能来自我们真的换成功了。
   */
  override.config.models.push({ id: 'qwen-local-14b', name: 'qwen-local-14b', contextWindow: 131_072 });
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
  const runOnce = (runId, model, text, reasoningEffort) =>
    adapter.run({
      runId,
      sessionId: 'sess-1',
      text,
      attachments: [],
      workspace,
      mode: 'standard',
      model,
      reasoningEffort,
      guard: { assess: () => ({ risk: 'safe', reason: '', blocked: false }) },
      tools: {},
      emit: (e) => events.push(e),
      requestApproval: async () => ({ approved: true }),
      signal: controller.signal,
    });

  try {
    await adapter.start();

    // ── 目录：打印内核真帧解析出来的清单（这是「内核到底给了什么」的留痕）──
    const catalog = await adapter.modelCatalog(true);
    console.log(`  内核目录: ${JSON.stringify(catalog)}`);
    check(
      'modelCatalog 从内核真帧取到目录并标注来源',
      catalog !== null && catalog.source === 'kernel' && catalog.models.length > 0,
      `source=${catalog?.source} models=${catalog?.models?.map((m) => m.id).join('/')}`,
    );
    check(
      '补丁生效：内核按端点补丁公布模型（含补丁里两个 id）',
      catalog.models.some((m) => m.id === 'qwen-local-7b') && catalog.models.some((m) => m.id === 'qwen-local-14b'),
      catalog.models.map((m) => m.id).join(','),
    );
    check(
      '目录条目全部标注来源为 kernel',
      catalog.models.every((m) => m.source === 'kernel'),
    );
    check('目录带上核对时间戳', typeof catalog.checkedAt === 'number' && catalog.checkedAt > 0);

    const status = await runOnce('run-1', 'qwen-local-7b', '把 "custom endpoint ok" 写入 CUSTOM.md');
    check('run 完成', status === 'completed', `status=${status}`);
    check(
      '自定义模型名真的到达端点',
      stub.requests.length > 0 && stub.requests[0].model === 'qwen-local-7b',
      `requests=${stub.requests.length} model=${stub.requests[0]?.model}`,
    );
    // 打印成一行便于留痕，但把插件清单折叠掉 —— 它有 80 多项，会把整行淹掉。
    const extraBrief = { ...(stub.requests[0]?.extra ?? {}) };
    if (extraBrief.dsh_plugin_packages) {
      extraBrief.dsh_plugin_packages = `(共 ${extraBrief.dsh_plugin_packages.packages.length} 项，已折叠)`;
    }
    console.log(`  端点收到的请求字段（除 messages/tools）: ${JSON.stringify(extraBrief)}`);
    // 真帧发现：推理档位是**请求体里的顶层字段** `reasoning_effort`（默认 high，
    // 同时带 `thinking: {type:'enabled'}`）。所以「设了档位」这件事可以直接在
    // 端点侧观察 —— 不必只信内核回的那句 ok。
    check(
      '内核默认档位真的出现在请求里（reasoning_effort=high）',
      stub.requests[0]?.extra?.reasoning_effort === 'high',
      String(stub.requests[0]?.extra?.reasoning_effort),
    );
    check(
      '端点请求未夹带官方模型名',
      stub.requests.every((r) => r.model === 'qwen-local-7b'),
    );
    check(
      '工具落盘经自定义端点完成',
      fs.existsSync(targetFile) && fs.readFileSync(targetFile, 'utf8').includes('custom endpoint ok'),
    );

    // ── 中途换模型：同一会话（sess-1 → 同一个 ACP 会话）再跑一轮 ──
    // 这正是修掉的那个静默失效：以前模型只在建会话时设一次，第二轮的 model
    // 只改了事件流里的记录，端点收到的还是旧模型。
    const before = stub.requests.length;
    const second = await runOnce('run-2', 'qwen-local-14b', '再写一次 CUSTOM.md');
    check('换模型后第二轮完成', second === 'completed', `status=${second}`);
    const secondReqs = stub.requests.slice(before);
    check(
      '同一会话中途换模型真的生效（端点收到新模型名）',
      secondReqs.length > 0 && secondReqs.every((r) => r.model === 'qwen-local-14b'),
      `第二轮 ${secondReqs.length} 次请求 model=${[...new Set(secondReqs.map((r) => r.model))].join(',')}`,
    );

    // ── 中途换推理档位：同样只能靠端点请求来证 ──
    // 会话复用，档位也只在建会话时设一次的话，这一轮的 reasoning_effort 就不会变。
    const beforeEffort = stub.requests.length;
    const third = await runOnce('run-3', 'qwen-local-14b', '再写一次 CUSTOM.md', 'max');
    check('换推理档位后第三轮完成', third === 'completed', `status=${third}`);
    const effortReqs = stub.requests.slice(beforeEffort);
    check(
      '推理档位真的传到了端点（reasoning_effort=max）',
      effortReqs.length > 0 && effortReqs.every((r) => r.extra?.reasoning_effort === 'max'),
      `第三轮 ${effortReqs.length} 次请求 reasoning_effort=${[...new Set(effortReqs.map((r) => r.extra?.reasoning_effort))].join(',')}`,
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
