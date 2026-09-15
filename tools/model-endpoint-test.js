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
 *      （requests[0].model === 'qwen-local-7b'）、推理档位真的进了请求体，以及
 *      **内核上报的上下文容量 = 我们在补丁里给该模型填的 contextWindow**
 *      —— 「配置写了但内核还在用旧值」只能靠这类端到端观察抓出来。dsh 缺席时优雅 SKIP。
 *   5. RPC 三方一致性（静态）：stdio-server 注册的方法、Electron 主进程白名单、
 *      protocol RpcContract 必须互相咬合 —— 内网现场出现过「契约注册了 models.refresh、
 *      白名单没有」，渲染层每次核对都被「方法未授权」顶回来。
 *   6. 开跑前模型守卫与端点连通性测试（2026-09-15 内网问题的两个修复）：
 *      目录查无此模型时 run 在宿主侧直接失败（错误带可选模型清单），
 *      不再把请求发给端点换一句 "Model not found"；testEndpoint 对本地 stub
 *      断言请求真的到达、key 透传、各失败形态的可行动文案。
 *
 * 前置条件（很关键）：替身端点必须回 `usage` 帧。dsh 的 llm 适配器会带
 * `stream_options.include_usage=true` 去请求它，而内核**只在拿到 usage 时才产生
 * `usage_update`**。替身不回 usage 时，「内核不上报上下文占用」这个结论是假的：
 * 2026-09-14 就是这么被误导过一次（先修替身，真帧才出现）。
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
  /**
   * 两个 contextWindow 刻意取两个**互不相同、且都不是默认值**的数。
   *
   * 理由：本段要靠「内核报的 size」反证「用户填的 contextWindow 真的到了内核」。
   * 若两个模型填同一个值，或填成默认值 131072，那么「换模型后 size 跟着变」
   * 与「size 一直是我们填的那个常量」无法区分 —— 断言会在错的实现上通过。
   */
  const ctx7b = 111_111;
  const ctx14b = 222_222;
  const override = modelEndpointOverride({
    kind: 'custom',
    baseUrl: stub.url,
    model: 'qwen-local-7b',
    contextWindow: ctx7b,
  });
  /**
   * 再塞一个模型进补丁。
   *
   * 为什么需要第二个：本段要验的是「同一会话中途换模型」——
   * 补丁里只注册一个模型时，换模型这个动作在内核侧无值可设，
   * 测试会退化成「什么都没验还全绿」。两个模型都指向同一个 stub，
   * 所以「请求里的 model 变了」只可能来自我们真的换成功了。
   */
  override.config.models.push({ id: 'qwen-local-14b', name: 'qwen-local-14b', contextWindow: ctx14b });
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

    // ── 上下文占用：内核报的容量，来源就是我们填的 contextWindow ──
    //
    // 这条链此前是断的，而且断得看不见：内核一直在报（ACP `usage_update`），
    // 我们的适配器没有对应分支，于是「上下文占用」这项能力在界面上从来不存在。
    // 发现它靠的是先修替身端点（原先不回 usage 帧 ⇒ 内核压根没用量可报 ⇒ 报不出来）。
    const ctxEvents = events.filter((e) => e.type === 'context.usage');
    const sizesOfRun = (runId) => [...new Set(ctxEvents.filter((e) => e.runId === runId).map((e) => e.size))];
    check(
      '真实内核上报了上下文占用（usage_update 已接线）',
      ctxEvents.length > 0,
      `${ctxEvents.length} 条，size=${[...new Set(ctxEvents.map((e) => e.size))].join('/')}`,
    );
    check(
      '占用为正且不超过容量',
      ctxEvents.every((e) => e.used > 0 && e.used <= e.size),
      JSON.stringify(ctxEvents.at(-1)),
    );
    check(
      'run-1（qwen-local-7b）：容量 = 补丁里给它填的 contextWindow',
      sizesOfRun('run-1').length === 1 && sizesOfRun('run-1')[0] === ctx7b,
      `size=${sizesOfRun('run-1').join('/')} 期望=${ctx7b}`,
    );
    check(
      'run-2（换到 qwen-local-14b）：容量跟着变成它自己的 contextWindow',
      sizesOfRun('run-2').length === 1 && sizesOfRun('run-2')[0] === ctx14b,
      `size=${sizesOfRun('run-2').join('/')} 期望=${ctx14b}`,
    );
    check(
      '容量不是常量：两轮的 size 确实不同（否则上面两条等于没验）',
      sizesOfRun('run-1')[0] !== sizesOfRun('run-2')[0],
    );
    check(
      '同一个 run 内 size 恒定（容量不随对话变化）',
      ctxEvents
        .filter((e) => e.runId === 'run-2')
        .every((e) => e.size === ctx14b),
    );
  } finally {
    await adapter.stop().catch(() => undefined);
    await stub.close();
  }
}

// ══════════════════════════════════════════════════════════
// 5. RPC 三方一致性（静态）：宿主注册 ⊆ 主进程白名单 ⊆ 契约
// ══════════════════════════════════════════════════════════
console.log('\n── RPC 三方一致性 ──');

function consistencySection() {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  // stdio-server 的处理器表：缩进四格的 '方法名': 注册行
  const stdio = new Set(
    [...read('packages/core-host/src/rpc/stdio-server.ts').matchAll(/^ {4}'([a-z][a-z0-9]*\.[a-z0-9.]+)':/gm)]
      .map((m) => m[1]),
  );
  // main.js 的白名单：缩进两格的 '方法名', 条目行
  const whitelist = new Set(
    [...read('apps/desktop/electron/main.js').matchAll(/^ {2}'([a-z][a-z0-9]*\.[a-z0-9.]+)',$/gm)]
      .map((m) => m[1]),
  );
  // RpcContract 的方法键
  const contract = new Set(
    [...read('packages/protocol/src/rpc.ts').matchAll(/^ {2}'([a-z][a-z0-9]*\.[a-z0-9.]+)': \{/gm)]
      .map((m) => m[1]),
  );

  const missingFromWhitelist = [...stdio].filter((m) => !whitelist.has(m));
  check(
    '宿主注册的方法全部进了主进程白名单（models.refresh 漏配是内网现场的实际故障）',
    missingFromWhitelist.length === 0,
    missingFromWhitelist.join(', ') || `共 ${stdio.size} 个方法`,
  );
  const missingFromContract = [...stdio].filter((m) => !contract.has(m));
  check(
    '宿主注册的方法全部在 RpcContract 里有契约',
    missingFromContract.length === 0,
    missingFromContract.join(', ') || `共 ${stdio.size} 个方法`,
  );
  const whitelistOutsideContract = [...whitelist].filter((m) => !contract.has(m));
  check(
    '白名单不含契约之外的方法',
    whitelistOutsideContract.length === 0,
    whitelistOutsideContract.join(', ') || `共 ${whitelist.size} 个方法`,
  );
}

// ══════════════════════════════════════════════════════════
// 6. 开跑前模型守卫 + 端点连通性测试
// ══════════════════════════════════════════════════════════
console.log('\n── 模型守卫与连通性测试 ──');

async function guardSection() {
  const workspace = path.join(root, 'workspace-guard');
  fs.mkdirSync(workspace, { recursive: true });
  const host = new DeepworkHost();
  const events = [];
  host.onEvent((event) => events.push(event));
  await host.start(workspace);

  // 目录已知（mock 只公布 mock-echo）时，带着官方模型名的会话必须在宿主侧被拦下 ——
  // 内网现场的形状：每一轮都被端点回 "Model not found"，四层原因共用一个症状。
  await host.modelCatalog();
  const blocked = host.createSession({ workspace, title: 'blocked', model: 'deepseek-v4-flash' });
  const before = events.length;
  const { runId } = host.send({ sessionId: blocked.id, text: '你好' });
  await new Promise((resolve) => setImmediate(resolve));
  const failure = events.slice(before).find((event) => event.type === 'run.failed' && event.runId === runId);
  check(
    '目录查无此模型时 run 在宿主侧直接失败（不发请求）',
    Boolean(failure),
    failure?.message ?? '（没有 run.failed 事件）',
  );
  check(
    '守卫错误带可选模型清单与改法（可行动，不是端点字符串）',
    Boolean(failure?.message.includes('mock-echo') && failure?.message.includes('默认模型')),
    failure?.message ?? '',
  );
  check(
    '被守卫拦下的 run 不产生 tool.started（请求没发出去）',
    !events.slice(before).some((event) => event.type === 'tool.started' && event.runId === runId),
  );
  check(
    '会话状态落为 failed',
    host.listSessions().find((s) => s.id === blocked.id)?.status === 'failed',
  );

  // 目录为空（从未核对上）时不拦：那是「不知道」不是「不匹配」，让请求照常走。
  const fresh = new DeepworkHost();
  const freshEvents = [];
  fresh.onEvent((event) => freshEvents.push(event));
  const freshWorkspace = path.join(root, 'workspace-guard-fresh');
  fs.mkdirSync(freshWorkspace, { recursive: true });
  await fresh.start(freshWorkspace);
  const free = fresh.createSession({ workspace: freshWorkspace, title: 'free', model: 'whatever-model' });
  const freeRun = fresh.send({ sessionId: free.id, text: '你好' });
  check(
    '目录为空时守卫不拦（不知道 ≠ 不匹配）',
    !freshEvents.some((event) => event.type === 'run.failed' && event.runId === freeRun.runId),
  );
  await fresh.stop();
  await host.stop();
}

async function endpointTestSection() {
  const http = require('node:http');
  const { testEndpoint } = require('../packages/core-host/dist/models/endpoint-test');

  const seen = { auth: null, path: null };
  const server = http.createServer((req, res) => {
    seen.path = req.url;
    if (req.url === '/v1/models') {
      seen.auth = req.headers.authorization ?? null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen-local-7b' }, { id: 'qwen-local-14b' }] }));
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const ok = await testEndpoint({ baseUrl: `http://127.0.0.1:${port}/v1/`, apiKey: 'sk-stub-key' });
    check('testEndpoint 连通成功并拿回端点模型清单',
      ok.ok === true && ok.models.join('/') === 'qwen-local-7b/qwen-local-14b', JSON.stringify(ok.models));
    check('testEndpoint 把 key 透传进 Authorization 头（请求真的到达了端点）',
      seen.auth === 'Bearer sk-stub-key', String(seen.auth));
    check('baseUrl 尾部斜杠被规范化', seen.path === '/v1/models', String(seen.path));
    check('返回带 HTTP 状态与延迟', ok.httpStatus === 200 && ok.latencyMs >= 0);

    const wrongPrefix = await testEndpoint({ baseUrl: `http://127.0.0.1:${port}` });
    check('少了 /v1 时给出可行动的 404 提示',
      wrongPrefix.ok === false && wrongPrefix.httpStatus === 404 && wrongPrefix.error.includes('/v1'),
      wrongPrefix.error);

    // 拿一个「真实但已关闭」的端口：直接写死小端口号会被 undici 以 'bad port'
    // 拦在连接前，测不到 ECONNREFUSED 这层翻译。
    const closedPort = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });
    const refused = await testEndpoint({ baseUrl: `http://127.0.0.1:${closedPort}/v1` });
    check('服务未监听时给出「连接被拒绝」的可行动提示',
      refused.ok === false && refused.error.includes('连接被拒绝'), refused.error);

    const malformed = await testEndpoint({ baseUrl: 'not-a-url' });
    check('非法地址在发请求前拦下', malformed.ok === false && malformed.error.includes('http'));

    // host 链路：未显式传 key 时用已存的 custom key
    const workspace = path.join(root, 'workspace-test');
    fs.mkdirSync(workspace, { recursive: true });
    const host = new DeepworkHost();
    await host.start(workspace);
    host.setConfig({ modelEndpoint: { kind: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qwen-local-7b' } });
    host.setModelApiKey('sk-saved-cccc');
    seen.auth = null;
    const viaHost = await host.testModelEndpoint({ baseUrl: `http://127.0.0.1:${port}/v1` });
    check('host.testModelEndpoint 未显式传 key 时用已存的 custom key',
      viaHost.ok === true && seen.auth === 'Bearer sk-saved-cccc', String(seen.auth));
    check('testModelEndpoint 结果不含 key 明文（可安全回渲染层）',
      !JSON.stringify(viaHost).includes('sk-saved-cccc'));
    await host.stop();
  } finally {
    server.close();
  }
}

async function endpointRestartSection() {
  const {
    endpointRestartMessage,
    endpointRoutingFingerprint,
  } = require('../packages/core-host/dist/models/endpoint');

  // ── 指纹：只有决定「请求发到哪里」的字段算数 ──────────────────────
  check('官方端点的指纹是 official', endpointRoutingFingerprint({ kind: 'official' }) === 'official');
  check(
    '自定义端点的指纹带地址',
    endpointRoutingFingerprint({ kind: 'custom', baseUrl: 'http://10.0.0.9:8000/v1', model: 'm' })
      === 'custom:http://10.0.0.9:8000/v1',
  );
  // 归一化必须与 modelEndpointOverride 一致，否则「同一条地址的两种写法」会被判成改过端点
  check(
    '末尾斜杠不影响指纹（与补丁里的归一化同一口径）',
    endpointRoutingFingerprint({ kind: 'custom', baseUrl: 'http://10.0.0.9:8000/v1//', model: 'm' })
      === 'custom:http://10.0.0.9:8000/v1',
  );
  check(
    '换模型 / 改 contextWindow 不算端点变更（改的是别的东西）',
    endpointRoutingFingerprint({ kind: 'custom', baseUrl: 'http://a/v1', model: 'x' })
      === endpointRoutingFingerprint({ kind: 'custom', baseUrl: 'http://a/v1', model: 'y', contextWindow: 4096 }),
  );

  // ── 判定：什么该拦、什么不该拦 ────────────────────────────────────
  const custom = { kind: 'custom', baseUrl: 'http://10.0.0.9:8000/v1', model: 'qwen-local-7b' };
  const blocked = endpointRestartMessage({ adapterKind: 'harness', running: 'official', configured: custom });
  check('harness：内核按官方起来、配置改成内网端点 → 拦', Boolean(blocked), blocked ?? '');
  check(
    '拦下的理由说清了「差别 + 改法」（可行动，不是一句失败）',
    Boolean(blocked && blocked.includes('10.0.0.9:8000/v1') && blocked.includes('重启内核')
      && blocked.includes('一直')),
    blocked ?? '',
  );
  check(
    'harness：核内就是当前配置的端点 → 不拦',
    endpointRestartMessage({
      adapterKind: 'harness',
      running: 'custom:http://10.0.0.9:8000/v1',
      configured: custom,
    }) === null,
  );
  check(
    'harness：不知道内核带着什么（没起过）→ 不拦（不知道 ≠ 不匹配）',
    endpointRestartMessage({ adapterKind: 'harness', running: null, configured: custom }) === null,
  );
  // mock 内核不发任何模型请求，拦它只会制造假失败
  check(
    'mock 内核不参与判定（端点对它没有意义）',
    endpointRestartMessage({ adapterKind: 'mock', running: 'official', configured: custom }) === null,
  );

  // ── 走一遍真实路径：status 的两个值 + send() 的守卫 ───────────────
  const workspace = path.join(root, 'workspace-endpoint-restart');
  fs.mkdirSync(workspace, { recursive: true });
  const host = new DeepworkHost();
  const events = [];
  host.onEvent((event) => events.push(event));
  await host.start(workspace);

  const st0 = host.status();
  check(
    'status 同时给出「内核启动时的端点」与「配置里的端点」，未改时两者相等',
    st0.kernelEndpoint === 'official' && st0.configEndpoint === 'official',
    `${st0.kernelEndpoint} / ${st0.configEndpoint}`,
  );

  // 改了端点但先不重启：两个值必须分叉 —— 界面横幅靠的就是这一对
  host.setConfig({ modelEndpoint: custom });
  const st1 = host.status();
  check(
    '端点改了没重启：kernelEndpoint 留在旧值、configEndpoint 是新的',
    st1.kernelEndpoint === 'official' && st1.configEndpoint === 'custom:http://10.0.0.9:8000/v1',
    `${st1.kernelEndpoint} / ${st1.configEndpoint}`,
  );

  /*
   * send() 的守卫用 harness 形态的替身来验。
   *
   * 本节要证的是「send() 里那次判定确实接上了」—— 判定函数本身上面已经逐条验过，
   * 但「函数对」与「调用点在」是两件事：白名单漏 models.refresh 那次就是后者出问题。
   * 真内核的链路另有 realDshSection 与 guardSection 覆盖，这里把 adapter 换成
   * 只回答 kind 的替身，是因为 mock 按设计不参与端点判定（它不发模型请求）。
   */
  const realAdapter = host.adapter;
  // 替身只需回答 kind 与让 run 正常返回：守卫命中时根本不会走到 run
  const harnessStub = { kind: 'harness', version: 'stub', capabilities: () => [], run: async () => 'completed', stop: async () => undefined };
  host.adapter = harnessStub;
  const before = events.length;
  const { runId } = host.send({ sessionId: host.createSession({ workspace, title: 'stale-endpoint' }).id, text: '你好' });
  await new Promise((resolve) => setImmediate(resolve));
  const failure = events.slice(before).find((event) => event.type === 'run.failed' && event.runId === runId);
  check(
    'harness + 端点待重启：run 在宿主侧直接失败（不发请求）',
    Boolean(failure) && failure.message.includes('重启内核'),
    failure?.message ?? '（没有 run.failed 事件）',
  );
  check(
    '该 run 可重试（重启内核后原样再发即可，不是终态错误）',
    failure?.retryable === true,
    String(failure?.retryable),
  );

  // 重启之后判定必须放行：漏更新这一笔，界面会一直说「不一致」，而用户已经重启过了
  host.adapter = realAdapter;
  await host.restartKernel();
  const st2 = host.status();
  check(
    '重启内核后 kernelEndpoint 跟上配置（不再误报不一致）',
    st2.kernelEndpoint === st2.configEndpoint && st2.kernelEndpoint === 'custom:http://10.0.0.9:8000/v1',
    `${st2.kernelEndpoint} / ${st2.configEndpoint}`,
  );
  const after = events.length;
  host.adapter = harnessStub;
  const clearRun = host.send({ sessionId: host.createSession({ workspace, title: 'fresh-endpoint' }).id, text: '你好' });
  await new Promise((resolve) => setImmediate(resolve));
  check(
    '重启之后同一句话不再被端点守卫拦下',
    !events.slice(after).some((event) => event.type === 'run.failed' && event.runId === clearRun.runId),
  );
  host.adapter = realAdapter;
  await host.stop();
}

async function main() {
  await hostSection();
  consistencySection();
  await guardSection();
  await endpointRestartSection();
  await endpointTestSection();
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
