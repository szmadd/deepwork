/**
 * 模型路由与端点降级（FR-10.2 后半）验证。
 *
 * 两件事，各自的可验物完全不同：
 *  1. **端点不可达的如实提示** —— 可验物是「提示里说的定性对不对、依据在不在」。
 *     这里用**本机假端点**制造六种失败（真发 HTTP，不是桩），
 *     因为「分类正确」这件事只有打真实网络栈才算验过。
 *  2. **按会话模式指定模型** —— 可验物是「新建会话拿到的 model 是哪个」。
 *     这是有明确真值的一件事，不需要主观判断。
 *
 * ── 为什么分类要单独测 ────────────────────────────────────────────────
 * 这条提示最容易犯的错是**把「连上了但配置不对」说成「不可达」**：
 * 用户会去查网络和服务进程，而真正要改的是 key 或地址后缀。
 * 所以下面既断言「是什么」，也断言「不是别的」。
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const requireDist = (rel) => require(path.join(ROOT, 'packages/core-host/dist', rel));
const protocolDist = (name) => require(path.join(ROOT, 'packages/protocol/dist', name));

/**
 * 假端点：一个进程内的真 HTTP 服务，行为由 `setMode` 切换。
 *
 * 与 pip-test 的假索引不同，这里**不需要独立子进程** —— 那个坑来自 `spawnSync`
 * 阻塞事件循环；`testEndpoint` 走的是异步 fetch，同进程起服务器不会自杀。
 */
function startFakeEndpoint() {
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    if (mode === 'not-found') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    if (mode === 'auth') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid api key"}');
      return;
    }
    if (mode === 'bad') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    if (mode === 'not-json') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>hello</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] }));
  });
  return {
    server,
    setMode: (next) => {
      mode = next;
    },
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 拿一个**确定没人监听**的端口：先占住、拿到号、再放掉。 */
async function closedPort() {
  const server = http.createServer(() => undefined);
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ── 1) 失败分类 ──────────────────────────────────────────────────────

async function classifySection() {
  section('1) 失败分类：每一层原因都有自己的 kind（真发 HTTP，不是桩）');
  const { testEndpoint } = requireDist('models/endpoint-test.js');
  const fake = startFakeEndpoint();
  const port = await fake.listen();
  const base = `http://127.0.0.1:${port}/v1`;

  try {
    const ok = await testEndpoint({ baseUrl: base });
    check(
      '通的端点：ok=true、kind 不带（没有失败就不该有失败分类）',
      ok.ok === true && ok.kind === undefined && ok.models.includes('m1'),
      JSON.stringify(ok),
    );

    fake.setMode('not-found');
    const notFound = await testEndpoint({ baseUrl: base });
    check(
      '404 → kind=not-found（这是「地址少了 /v1」，不是「不可达」）',
      notFound.kind === 'not-found' && notFound.httpStatus === 404,
      JSON.stringify(notFound),
    );

    fake.setMode('auth');
    const auth = await testEndpoint({ baseUrl: base });
    check(
      '401 → kind=auth（这是「key 不对」，不是「不可达」）',
      auth.kind === 'auth' && auth.httpStatus === 401,
      JSON.stringify(auth),
    );

    fake.setMode('bad');
    const bad = await testEndpoint({ baseUrl: base });
    check(
      '500 → kind=bad-response',
      bad.kind === 'bad-response' && bad.httpStatus === 500,
      JSON.stringify(bad),
    );

    fake.setMode('not-json');
    const notJson = await testEndpoint({ baseUrl: base });
    check(
      '200 但不是 JSON → kind=not-json（它不是 OpenAI 兼容端点）',
      notJson.kind === 'not-json',
      JSON.stringify(notJson),
    );

    fake.setMode('ok');
    const invalidUrl = await testEndpoint({ baseUrl: '127.0.0.1:8000/v1' });
    check(
      '地址不合规 → kind=invalid-url（连请求都没发，不该说成网络问题）',
      invalidUrl.kind === 'invalid-url' && invalidUrl.latencyMs === 0,
      JSON.stringify(invalidUrl),
    );

    const dead = await closedPort();
    const unreachable = await testEndpoint({ baseUrl: `http://127.0.0.1:${dead}/v1` });
    check(
      '端口没人听 → kind=unreachable（唯一真该说「不可达」的那一类）',
      unreachable.kind === 'unreachable',
      JSON.stringify(unreachable),
    );

    // 这一条是「不许有失败没分类」：漏一个 kind 的后果是提示退回成「原因未知」
    const all = [ok, notFound, auth, bad, notJson, invalidUrl, unreachable];
    check(
      '每一个失败都带 kind（不许有「分类漏了」的失败）',
      all.every((result) => result.ok || typeof result.kind === 'string'),
      all.map((r) => `${r.ok ? 'ok' : r.kind}`).join(' / '),
    );
  } finally {
    await fake.close();
  }
}

// ── 2) 缓存与提示措辞 ────────────────────────────────────────────────

function noticeSection() {
  section('2) 可达性缓存与提示措辞');
  const { isReachabilityFresh, endpointProbeNotice, REACHABILITY_TTL_MS } = requireDist(
    'models/reachability.js',
  );

  const custom = { kind: 'custom', baseUrl: 'http://10.0.0.5:8000/v1', model: 'qwen' };
  const other = { kind: 'custom', baseUrl: 'http://10.0.0.9:8000/v1', model: 'qwen' };
  const official = { kind: 'official' };
  const now = 1_700_000_000_000;
  const bad = { ok: false, latencyMs: 3, models: [], kind: 'unreachable', error: '连接被拒绝：端点服务未在监听。' };
  const record = { fingerprint: 'custom:http://10.0.0.5:8000/v1', checkedAt: now - 1_000, result: bad };

  check('同一端点 + 没过期 → 可用于提示', isReachabilityFresh(record, custom, now) === true);
  check('换了端点 → 旧的可用性结论作废', isReachabilityFresh(record, other, now) === false);
  check(
    '官方端点与自定义端点的结论不通用',
    isReachabilityFresh(record, official, now) === false &&
      isReachabilityFresh({ ...record, fingerprint: 'official' }, official, now) === true,
  );
  check(
    `超过新鲜期（${REACHABILITY_TTL_MS / 1000}s）→ 不再拿它提示`,
    isReachabilityFresh(record, custom, now + REACHABILITY_TTL_MS + 1) === false,
  );
  check(
    '时钟回拨（age 为负）按不可信处理 —— 宁可不说',
    isReachabilityFresh(record, custom, now - 60_000) === false,
  );

  check(
    '官方端点不下可达性结论（没配 key 时必然 401，那会把「没填 key」说成「端点有问题」）',
    endpointProbeNotice({ endpoint: official, record: { ...record, fingerprint: 'official' }, now }) === null,
  );
  check('从没探过 → 不说（不知道 ≠ 有问题）', endpointProbeNotice({ endpoint: custom, record: null, now }) === null);
  check(
    '探测是通的 → 不说',
    endpointProbeNotice({
      endpoint: custom,
      record: { ...record, result: { ok: true, latencyMs: 5, models: [] } },
      now,
    }) === null,
  );
  check(
    '结论过期 → 不说（宁可不说，也不拿过期结论误导排障）',
    endpointProbeNotice({ endpoint: custom, record, now: now + REACHABILITY_TTL_MS + 1 }) === null,
  );

  const unreachableNotice = endpointProbeNotice({ endpoint: custom, record, now });
  check(
    '不可达：说「端点不可达」，且**不说**「连上了」（两者下一步动作完全不同）',
    unreachableNotice !== null &&
      unreachableNotice.message.includes('端点不可达') &&
      !unreachableNotice.message.includes('连上了') &&
      unreachableNotice.message.includes('10.0.0.5:8000'),
    JSON.stringify(unreachableNotice),
  );
  check(
    '提示里带依据（探测时刻 + 「不是此刻的实时状态」）',
    typeof unreachableNotice.basis === 'string' &&
      unreachableNotice.basis.includes('不是此刻的实时状态'),
    unreachableNotice?.basis,
  );
  check(
    '提示里写明「这一轮仍会照常发出请求」（只提示不拦，必须让用户知道）',
    unreachableNotice.remedy.includes('仍会照常') && unreachableNotice.remedy.includes('/models'),
    unreachableNotice?.remedy,
  );
  check('提示等级是 warn（不是 error —— 它不中断这一轮）', unreachableNotice.level === 'warn');

  const authNotice = endpointProbeNotice({
    endpoint: custom,
    record: { ...record, result: { ...bad, kind: 'auth', error: '端点拒绝了凭据（401/403）：key 无效或未授权。' } },
    now,
  });
  check(
    '可比达但凭据被拒：明确说「连上了」，不混进「不可达」',
    authNotice.message.includes('连上了') &&
      authNotice.message.includes('凭据被拒') &&
      !authNotice.message.includes('端点不可达'),
    authNotice?.message,
  );

  const notFoundNotice = endpointProbeNotice({
    endpoint: custom,
    record: { ...record, result: { ...bad, kind: 'not-found', error: '服务在线，但 /models 返回 404。' } },
    now,
  });
  check(
    '可比达但路径不对：说「地址路径不对」（用户要改的是后缀，不是网络）',
    notFoundNotice.message.includes('连上了') && notFoundNotice.message.includes('地址路径不对'),
    notFoundNotice?.message,
  );
}

// ── 3) 宿主：开跑时真的发出提示 ──────────────────────────────────────

async function waitFor(predicate, timeoutMs = 5_000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function hostNoticeSection() {
  section('3) 宿主：开跑时真的发出这条提示（调用点哨兵）');
  const { DeepworkHost } = requireDist('host.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-routing-home-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-routing-ws-'));
  process.env.DEEPWORK_HOME = home;

  const deadPort = await closedPort();
  const deadUrl = `http://127.0.0.1:${deadPort}/v1`;

  const host = new DeepworkHost({ scheduler: { tickMs: 60_000 } });
  try {
    await host.start(workspace);
    // 配置一个必然连不上的自定义端点
    host.setConfig({
      modelEndpoint: { kind: 'custom', baseUrl: deadUrl, model: 'm1' },
      defaultModel: 'm1',
    });
    // 用户主动点一次「测试连接」—— 这是缓存最可信的来源，也让这一节完全确定
    const probe = await host.testModelEndpoint({ baseUrl: deadUrl });
    check('设置页的「测试连接」本身拿到了不可达结论', probe.ok === false && probe.kind === 'unreachable', JSON.stringify(probe));

    const session = host.createSession({ workspace, title: '路由验证' });
    const { runId } = await host.send({ sessionId: session.id, text: '随便说一句' });
    check('这一轮拿到了 runId（提示不中断流程）', typeof runId === 'string' && runId.length > 0);

    const events = host.sessionEvents(session.id);
    const notice = events.find((event) => event.type === 'run.notice');
    check(
      '事件流里出现了 run.notice（宿主真的调了它，而不只是函数写对了）',
      Boolean(notice),
      events.map((e) => e.type).join(' / '),
    );
    check(
      '提示内容说明了不可达与地址，并带依据',
      Boolean(notice) &&
        notice.message.includes(deadUrl.replace(/\/v1$/, '')) &&
        typeof notice.basis === 'string' &&
        notice.level === 'warn',
      JSON.stringify(notice),
    );
    check(
      '它**不是** run.failed —— 端点探不通不拦这一轮（/models 不是强制面）',
      events.every((event) => event.type !== 'run.failed'),
      events.map((e) => e.type).join(' / '),
    );

    // 端点换成一个通的：旧结论必须立刻作废，不能拿它去提示新地址
    const fake = startFakeEndpoint();
    const port = await fake.listen();
    try {
      host.setConfig({
        modelEndpoint: { kind: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm1' },
      });
      const session2 = host.createSession({ workspace, title: '换地址后' });
      await host.send({ sessionId: session2.id, text: '再说一句' });
      const events2 = host.sessionEvents(session2.id);
      check(
        '换了端点之后不再用旧结论提示（旧的「那个地址不通」与新地址无关）',
        events2.every((event) => event.type !== 'run.notice'),
        events2.map((e) => e.type).join(' / '),
      );
    } finally {
      await fake.close();
    }
  } finally {
    try {
      await host.stop();
    } catch {
      /* 宿主可能本来就没起成 */
    }
    for (const dir of [home, workspace]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        console.log(`  [注意] 临时目录未清理干净：${error.message}`);
      }
    }
  }
}

// ── 4) 按会话模式路由模型 ────────────────────────────────────────────

async function modeRoutingSection() {
  section('4) 按会话模式指定模型（快模型 / 推理模型分工）');
  const { DeepworkHost } = requireDist('host.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-routing-home2-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-routing-ws2-'));
  process.env.DEEPWORK_HOME = home;

  const host = new DeepworkHost({ scheduler: { tickMs: 60_000 } });
  try {
    await host.start(workspace);
    host.setConfig({
      defaultModel: 'def-model',
      // ptc 故意配成空白串：那是「没配」，不是「配了一个空模型名」
      modeModels: { minimal: 'fast-x', ptc: '   ', creative: '  big-y  ' },
    });

    check(
      '配了映射的模式用映射的模型',
      host.createSession({ workspace, mode: 'minimal' }).model === 'fast-x',
      host.createSession({ workspace, mode: 'minimal' }).model,
    );
    check(
      '配成空白串 = 没配 → 落回默认模型（空串不是模型 id，让它穿透会变成查无此模型的请求）',
      host.createSession({ workspace, mode: 'ptc' }).model === 'def-model',
      host.createSession({ workspace, mode: 'ptc' }).model,
    );
    check(
      '没配映射的模式落回默认模型',
      host.createSession({ workspace, mode: 'standard' }).model === 'def-model',
      host.createSession({ workspace, mode: 'standard' }).model,
    );
    check(
      '映射值两端的空白被去掉（模型 id 前后带空格进不了内核）',
      host.createSession({ workspace, mode: 'creative' }).model === 'big-y',
      host.createSession({ workspace, mode: 'creative' }).model,
    );
    check(
      '调用方显式指定的模型压过映射（显式动作比规则硬）',
      host.createSession({ workspace, mode: 'minimal', model: 'explicit-z' }).model === 'explicit-z',
      host.createSession({ workspace, mode: 'minimal', model: 'explicit-z' }).model,
    );

    // 会话会带着映射出来的模型跑：run.started.model 是这件事的出口
    const session = host.createSession({ workspace, mode: 'minimal' });
    await host.send({ sessionId: session.id, text: '一句话', model: '' });
    const started = await waitFor(() =>
      host.sessionEvents(session.id).find((event) => event.type === 'run.started'),
    );
    check(
      '空串模型按「未指定」处理，本轮用的是会话的模型（不是空模型名）',
      started !== null && started.model === 'fast-x',
      JSON.stringify(started?.model),
    );
  } finally {
    try {
      await host.stop();
    } catch {
      /* 忽略 */
    }
    for (const dir of [home, workspace]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        console.log(`  [注意] 临时目录未清理干净：${error.message}`);
      }
    }
  }
}

// ── 5) 界面接线（读源码） ────────────────────────────────────────────

function uiWiringSection() {
  section('5) 界面接线（读源码）');
  const settings = fs.readFileSync(
    path.join(ROOT, 'apps/desktop/src/components/SettingsPanel.tsx'),
    'utf8',
  );
  const chat = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/components/ChatStream.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/styles.css'), 'utf8');

  check(
    '设置页有「按模式指定模型」的入口，且写的是「留空跟随默认」这一语义',
    settings.includes('config.modeModels') &&
      settings.includes('跟随默认模型') &&
      settings.includes('新建会话'),
    '检查 SettingsPanel.tsx',
  );
  check(
    '对话流把 remedy 与 basis 分开渲染（不折进主句，否则用户会跳过整段）',
    chat.includes('notice-remedy') && chat.includes('notice-basis'),
    '检查 ChatStream.tsx',
  );
  check(
    '依据那一行有独立样式（它是「这条结论有多新」的唯一线索）',
    /\.notice-basis[\s\S]{0,120}?font-size/.test(css),
    '检查 styles.css',
  );
  check(
    '契约层的 notice 项带 remedy / basis 字段（界面才有东西可渲染）',
    fs
      .readFileSync(path.join(ROOT, 'packages/protocol/src/reduce.ts'), 'utf8')
      .includes('basis?: string'),
    '检查 reduce.ts 的 TimelineItem',
  );
}

async function main() {
  console.log('模型路由与端点降级验证（FR-10.2 后半）');
  await classifySection();
  noticeSection();
  await hostNoticeSection();
  await modeRoutingSection();
  uiWiringSection();

  console.log(`\n通过 ${passed} 项 / 失败 ${failed} 项`);
  if (failed > 0) console.log(`失败项：${failures.join('、')}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
