'use strict';

/**
 * 浏览器自动化（M2-H）测试 —— 用**真实系统浏览器**驱动一个真实页面。
 *
 *   npm run test:browser
 *
 * 为什么不用假 CDP：这一层的全部风险都在真实浏览器上 —— 调试端口要不要
 * --user-data-dir、握手行到底长什么样、页面域命令要不要先附着 session、
 * 无界面模式能不能截图。用一个自己写的假协议对手，这些一条都测不到，
 * 只会在真机上以「偶发失败」的形式出现。
 *
 * 八组断言：
 *   1. 契约层：工具名的两套写法（本地点号 / MCP 下划线）、风险档、动作表；
 *   2. patch 层：内置 MCP 条目的形状、入口文件真实存在（否则内核拉起必失败）；
 *   3. 风险分档：经 mapUpdateToEvent 取证 riskOfTool 对 browser_* 的分级；
 *   4. 真实浏览器动作：导航 / 读文本 / 点击 / 输入（含提交）/ 求值 / 截图；
 *   5. 审批链：模型侧工具必须过审批，拒绝时**不执行**；
 *   6. 单实例与清理：跨进程复用同一个浏览器、收尾杀掉整棵进程树；
 *   7. MCP 协议端到端：真跑 dist/cli/browser-mcp.js 的 initialize/tools/* ；
 *   8. 接线取证：RPC 白名单、壳层通道常量、CLI 入口文件。
 *
 * 系统里没有 Edge / Chrome 时优雅 SKIP（退出码 0）：能力缺失不等于回归，
 * 但会打印明确的 SKIP 原因 —— 不能让它悄悄变成「测试通过」。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-browser-'));
process.env.DEEPWORK_HOME = home;

const {
  BROWSER_ACTIONS,
  BROWSER_CONTENT_LIMIT,
  BROWSER_MCP_SERVER_NAME,
  BROWSER_SHOTS_DIR,
  BROWSER_TOOL_RISK,
  browserMcpToolName,
  browserToolName,
} = require('../packages/protocol/dist/browser');
const { IPC } = require('../packages/protocol/dist/rpc');
const { buildBrowserMcpPatch, buildRuntimePatch, serializeRuntimePatchYaml } = require('../packages/core-host/dist/mcp/patch');
const { BrowserManager } = require('../packages/core-host/dist/browser/manager');
const { findBrowserExecutable } = require('../packages/core-host/dist/browser/cdp');
const { ToolRegistry, createToolContext, ALLOW_ALL, DENY_ALL } = require('../packages/core-host/dist/tools/registry');
const { registerBuiltinTools } = require('../packages/core-host/dist/tools/builtin');
const { DeepworkHost } = require('../packages/core-host/dist/host');
const { buildHandlers } = require('../packages/core-host/dist/rpc/stdio-server');
const { mapUpdateToEvent } = require('../packages/core-host/dist/adapter/harness-sidecar');

const root = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function skippable(name, ok, detail) {
  results.push({ name, ok, skip: !ok });
  console.log(`  [${ok ? 'PASS' : 'SKIP'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * 断言「这个调用以某句文案失败」。
 *
 * 关键词必须真的出现在异常里才算通过 —— 早期版本写成「只要能捕获到异常就返回 true」，
 * 于是断言永远成立、失败信息也永远看不见，这类假通过比失败更难发现。
 */
async function throwsWith(fn, keyword) {
  try {
    await fn();
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes(keyword)) return true;
    console.log(`      （异常文案不含「${keyword}」：${message.slice(0, 120)}）`);
    return false;
  }
  console.log(`      （没有抛出异常，期望包含「${keyword}」）`);
  return false;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** fixture 页面：带 meta charset（中文不乱码的前提）、按钮、表单、待写入区 */
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>深边浏览器 fixture</title></head>
<body>
  <h1 id="title">深边浏览器测试页</h1>
  <p id="text">中文内容：一二三</p>
  <button id="btn" onclick="document.getElementById('out').textContent='已点击'">点我</button>
  <div id="out">未点击</div>
  <form id="form" onsubmit="event.preventDefault(); document.getElementById('result').textContent='提交:'+document.getElementById('name').value;">
    <input id="name" type="text">
    <button id="submit" type="submit">提交</button>
  </form>
  <div id="result">未提交</div>
</body>
</html>
`;

function fixtureUrl() {
  const file = path.join(home, 'fixture.html');
  fs.writeFileSync(file, FIXTURE_HTML, 'utf8');
  // Windows 的 file:// 盘符前必须有斜杠；用 pathToFileURL 等价的手工拼法保持可读
  return `file:///${file.replace(/\\/g, '/')}`;
}

// ══════════════════════════════════════════════════════════
// 1. 契约层
// ══════════════════════════════════════════════════════════
console.log('\n── 契约层 ──');
{
  check('六个动作齐备', BROWSER_ACTIONS.length === 6, BROWSER_ACTIONS.join(' / '));
  check(
    '本地工具名用点号（与 fs.list 同风格）',
    browserToolName('navigate') === 'browser.navigate',
    browserToolName('navigate'),
  );
  check(
    'MCP 工具名用下划线',
    browserMcpToolName('navigate') === 'browser_navigate',
    browserMcpToolName('navigate'),
  );

  // 这是硬约束：模型 API 拒收带点的 function name，而报错与浏览器毫无关系
  const apiNamePattern = /^[A-Za-z0-9_-]{1,64}$/;
  const allMcpNames = BROWSER_ACTIONS.map((action) => browserMcpToolName(action));
  check(
    'MCP 工具名全部满足 API 的 function name 字符集',
    allMcpNames.every((name) => apiNamePattern.test(name)),
    allMcpNames.join(','),
  );
  check(
    '两套名字一一对应（点号 ↔ 下划线）',
    BROWSER_ACTIONS.every((action) => browserMcpToolName(action) === browserToolName(action).replace('.', '_')),
  );

  check('evaluate 是 danger 档（与 shell 同级）', BROWSER_TOOL_RISK.evaluate === 'danger');
  check(
    '其余五个动作是 confirm 档',
    BROWSER_ACTIONS.filter((action) => action !== 'evaluate').every(
      (action) => BROWSER_TOOL_RISK[action] === 'confirm',
    ),
  );
  check('内容截断上限是正数', BROWSER_CONTENT_LIMIT > 0, String(BROWSER_CONTENT_LIMIT));
  check(
    '内置服务名不含点号（否则与工具名撞车）',
    !BROWSER_MCP_SERVER_NAME.includes('.'),
    BROWSER_MCP_SERVER_NAME,
  );
}

// ══════════════════════════════════════════════════════════
// 2. patch 层
// ══════════════════════════════════════════════════════════
console.log('\n── 内置 MCP 服务的补丁 ──');
{
  const entryFile = path.join(root, 'packages', 'core-host', 'dist', 'cli', 'browser-mcp.js');
  const patch = buildBrowserMcpPatch({
    command: process.execPath,
    entry: entryFile,
    env: { DEEPWORK_HOME: home },
  });
  const entry = patch.insert[0];

  check('补丁是一个 insert 条目', Array.isArray(patch.insert) && patch.insert.length === 1);
  check('条目 name 是内核依赖闭包内的 MCP 客户端包名', entry.name === '@deepseek-ai/dsh-mcp-client', entry.name);
  check('serverName 与契约层一致', entry.config.serverName === BROWSER_MCP_SERVER_NAME);
  check('传输是 stdio', entry.config.transport === 'stdio');
  check('args 指向 MCP 服务入口', entry.config.args[0] === entryFile);

  // 最重要的一条：补丁里写的入口必须真实存在。写错的话内核会拉起失败，
  // 而症状是「模型看不到 browser_* 工具」——与 patch 文件本身毫无关联的表象。
  check('入口文件在磁盘上真实存在（否则内核拉起必失败）', fs.existsSync(entryFile), entryFile);
  check(
    'env 带 DEEPWORK_HOME（两进程共用一个 home 才能共用浏览器）',
    entry.config.env.DEEPWORK_HOME === home,
  );

  const merged = buildRuntimePatch(
    [{ name: 'fake', command: 'node', args: [], enabled: true }],
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek', config: {} },
    patch,
  );
  check('合并补丁含三项（连接器 + 端点覆盖 + 浏览器）', Array.isArray(merged) && merged.length === 3);
  check('浏览器条目在最后（出问题时先怀疑内置项）', merged[merged.length - 1].insert?.[0]?.id === 'deepwork-browser');

  const yaml = serializeRuntimePatchYaml(merged);
  check('YAML 含浏览器条目的关键字段', yaml.includes('serverName: "deepwork_browser"') && yaml.includes('transport: "stdio"'));
  check('YAML 里的入口路径带引号（Windows 反斜杠必须被转义）', /args:\n\s+- "[A-Za-z]:\\\\/.test(yaml));
}

// ══════════════════════════════════════════════════════════
// 3. 风险分档（经内核事件映射取证）
// ══════════════════════════════════════════════════════════
console.log('\n── 内核侧风险分档 ──');
{
  const riskOf = (title) =>
    mapUpdateToEvent({ sessionUpdate: 'tool_call', toolCallId: 'c1', title, kind: 'other', rawInput: {} }, 'r1')?.call
      ?.risk;

  const mcpPrefix = `mcp__${BROWSER_MCP_SERVER_NAME}__`;
  check('browser_navigate 为 confirm 档', riskOf(`${mcpPrefix}browser_navigate`) === 'confirm');
  check('browser_click 为 confirm 档', riskOf(`${mcpPrefix}browser_click`) === 'confirm');
  check(
    'browser_evaluate 升 danger 档（与契约层的 BROWSER_TOOL_RISK 一致）',
    riskOf(`${mcpPrefix}browser_evaluate`) === 'danger',
  );
  check('截图与读取仍为 confirm 档', riskOf(`${mcpPrefix}browser_screenshot`) === 'confirm');
}

// ══════════════════════════════════════════════════════════
// 4-7. 真实浏览器（无浏览器时整体 SKIP）
// ══════════════════════════════════════════════════════════
async function browserSection() {
  const executable = findBrowserExecutable();
  if (!executable) {
    skippable('真实浏览器链路（导航/点击/输入/求值/截图/审批/清理）', false, '系统里没有 Edge 或 Chrome');
    skippable('MCP 协议端到端', false, '同上');
    return;
  }
  console.log(`\n── 真实浏览器动作（${executable}）──`);

  const manager = new BrowserManager();
  const fixture = fixtureUrl();

  // ── 导航与读取 ──
  const nav = await manager.run('navigate', { url: fixture });
  check('导航返回成功的文案与标题', nav.text.includes('已打开') && nav.title === '深边浏览器 fixture', nav.title);

  const content = await manager.run('content', {});
  // 中文必须原样读回：这条断言是 data: URL 缺 charset 那次乱码的回归哨兵
  check('读到页面文本且中文无乱码', content.text.includes('深边浏览器测试页') && content.text.includes('中文内容：一二三'));
  check('返回结构里带当前 url 与标题', typeof content.url === 'string' && content.url.startsWith('file://'));

  const scoped = await manager.run('content', { selector: '#text' });
  check('限定选择器只读该元素', scoped.text.trim() === '中文内容：一二三', JSON.stringify(scoped.text.trim()));

  // ── 点击 ──
  await manager.run('click', { selector: '#btn' });
  const afterClick = await manager.run('content', { selector: '#out' });
  check('点击后页面状态真的变了', afterClick.text.includes('已点击'), afterClick.text.trim());

  // ── 输入（原生 setter）──
  await manager.run('type', { selector: '#name', text: '中文输入' });
  const typed = await manager.run('evaluate', { expression: "document.getElementById('name').value" });
  check('输入生效且是原生 setter（受控组件同路径）', typed.text === '中文输入', typed.text);

  // ── 输入并提交 ──
  await manager.run('type', { selector: '#name', text: '提交用', submit: true });
  const submitted = await manager.run('content', { selector: '#result' });
  check('submit 真的提交了表单', submitted.text.includes('提交:提交用'), submitted.text.trim());

  // ── 求值 ──
  const sum = await manager.run('evaluate', { expression: '1 + 1' });
  check('求值返回标量', sum.text === '2', sum.text);
  const objectValue = await manager.run('evaluate', { expression: '({ a: 1, b: [2, 3] })' });
  check('求值返回结构化值时按 JSON 呈现', objectValue.text.includes('"a": 1') && objectValue.text.includes('"b"'), objectValue.text.replace(/\s+/g, ' '));
  check(
    '页面脚本抛异常会被如实报出（不是静默成功）',
    await throwsWith(() => manager.run('evaluate', { expression: 'null.x' }), '页面脚本抛出异常'),
  );
  check(
    '选择器没命中会报「未找到元素」',
    await throwsWith(() => manager.run('click', { selector: '#nope' }), '未找到元素'),
  );
  check(
    '不支持的 URL 协议被拒',
    await throwsWith(() => manager.run('navigate', { url: 'javascript:alert(1)' }), '不支持的 URL 协议'),
  );

  // ── 截图 ──
  const shot = await manager.run('screenshot', { name: 'shot-ok.png' });
  const shotBytes = fs.readFileSync(shot.shotPath);
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  check('截图文件落盘', fs.existsSync(shot.shotPath), shot.shotPath);
  check('截图的头 8 字节是 PNG magic', shotBytes.subarray(0, 8).equals(PNG_MAGIC), shotBytes.subarray(0, 8).toString('hex'));
  check('PNG 字节不进工具正文（只给路径）', !shot.text.includes('data:image'), shot.text.slice(0, 60));
  check('截图落在 home 的 browser-shots 目录内', path.dirname(shot.shotPath) === path.join(home, BROWSER_SHOTS_DIR));

  // 目录穿越：名字里带 .. 与路径分隔符时必须被清洗，否则就是「写文件到任意位置」
  const escaped = await manager.run('screenshot', { name: '../../../evil.png' });
  check(
    '截图名字里的目录穿越被清洗（仍落在截图目录内）',
    path.dirname(escaped.shotPath) === path.join(home, BROWSER_SHOTS_DIR),
    path.basename(escaped.shotPath),
  );

  // ── 状态 ──
  const state = manager.state();
  check('状态报告运行中且带 pid/端口/可执行文件', state.running && state.pid > 0 && state.port > 0 && Boolean(state.executable));
  check('状态里的截图张数 ≥ 2', state.shotCount >= 2, String(state.shotCount));

  // ══════════════════════════════════════════════════════════
  // 5. 审批链：模型侧动作必须过审批
  // ══════════════════════════════════════════════════════════
  console.log('\n── 审批链（模型侧工具）──');
  {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, { browser: manager });
    const toolNames = registry.list().map((tool) => tool.name);
    check(
      '六个浏览器工具已注册进工具表',
      BROWSER_ACTIONS.every((action) => toolNames.includes(browserToolName(action))),
      toolNames.filter((name) => name.startsWith('browser.')).join(','),
    );

    const calls = [];
    const makeCtx = (outcome) =>
      createToolContext({
        workspace: home,
        guard: { assess: () => ({ risk: 'confirm', reason: 'test', blocked: false }) },
        requestApproval: async (input) => {
          calls.push(input);
          return outcome;
        },
      });

    // 拒绝：必须不执行（用「导航到另一个页面」验证页面没被改）
    const before = await manager.run('content', { selector: '#result' });
    const denied = await registry.execute(
      browserToolName('navigate'),
      { url: `file:///${path.join(home, 'another.html').replace(/\\/g, '/')}` },
      makeCtx(DENY_ALL),
    );
    const after = await manager.run('content', { selector: '#result' });
    check('拒绝时工具返回失败并说明原因', denied.ok === false && denied.output.includes('拒绝'), denied.output.slice(0, 40));
    check('拒绝时页面没有被改动（动作真的没执行）', after.text === before.text);
    check('审批请求带工具名与主题', calls[0]?.tool === 'browser.navigate' && calls[0]?.subject.includes('another.html'));

    // 允许：正常执行
    const allowed = await registry.execute(browserToolName('content'), {}, makeCtx(ALLOW_ALL));
    check('允许时正常执行', allowed.ok === true && allowed.output.includes('深边浏览器测试页'));
    check('读取类动作同样过审批（无豁免）', calls[1]?.tool === 'browser.content');

    // 无审批回调时不再询问（与既有写工具同一约定：没有回调即无审批能力）
    const noApproval = await registry.execute(
      browserToolName('content'),
      {},
      createToolContext({ workspace: home, guard: { assess: () => ({ risk: 'confirm', reason: 't', blocked: false }) } }),
    );
    check('没有审批回调时按既有约定不询问', noApproval.ok === true);
  }

  // ══════════════════════════════════════════════════════════
  // 6. 单实例复用 + MCP 端到端
  // ══════════════════════════════════════════════════════════
  console.log('\n── 跨进程复用与 MCP 协议 ──');
  {
    // 第二个 manager（模拟另一个进程）应当复用而不是另拉一个：拿到的页面
    // 必须是第一个 manager 打开的那一页，而不是一张 about:blank 白纸。
    const second = new BrowserManager();
    const shared = await second.run('content', { selector: '#title' });
    check('第二个管理器复用同一个浏览器（看到同一页）', shared.text.trim() === '深边浏览器测试页', shared.text.trim());
    check('复用时 pid 与首个管理器一致', second.state().pid === manager.state().pid);
    await second.shutdown(); // 借用方退出不应杀掉别人的浏览器
    check('借用方退出后浏览器仍在（不越权杀别人的进程）', isPidAlive(manager.state().pid));
    check('借用方退出后连接已断开（状态仍报运行中，进程由持有方负责）', manager.state().running === true);
  }

  {
    const entry = path.join(root, 'packages', 'core-host', 'dist', 'cli', 'browser-mcp.js');
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, DEEPWORK_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => lines.push(line));
    let stderrText = '';
    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString('utf8');
    });

    const call = async (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      // 等这一条的响应（按 id 匹配）；超时给一个明确的失败而不是无限挂起
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const found = lines
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .find((item) => item && item.id === message.id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      throw new Error(`MCP 响应超时（id=${message.id}）；stderr 片段：${stderrText.slice(-200)}`);
    };

    const init = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-test', version: '0' } },
    });
    check('initialize 回显协议版本并公布 tools 能力', init.result?.protocolVersion === '2025-06-18' && Boolean(init.result?.capabilities?.tools));
    check('initialize 公布服务名', init.result?.serverInfo?.name === 'deepwork-browser', init.result?.serverInfo?.name);

    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = (list.result?.tools ?? []).map((tool) => tool.name);
    check(
      'tools/list 列出六个工具且名字是下划线形式',
      listed.length === 6 && listed.every((name) => /^browser_[a-z]+$/.test(name)),
      listed.join(','),
    );
    check(
      '每个工具都带了入参 schema',
      (list.result?.tools ?? []).every((tool) => tool.inputSchema?.type === 'object'),
    );

    const ping = await call({ jsonrpc: '2.0', id: 3, method: 'ping' });
    check('ping 返回空结果对象', ping.result !== undefined && !ping.error);

    // 关键：MCP 服务与宿主是两个进程，这里验证它复用了同一个浏览器
    // （若它自己拉了一个新实例，读到的会是 about:blank，而不是宿主打开的这一页）
    const remoteContent = await call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'browser_content', arguments: { selector: '#title' } },
    });
    check(
      'MCP 服务读到的是宿主正在用的那一页（跨进程共享同一实例）',
      remoteContent.result?.content?.[0]?.text?.trim() === '深边浏览器测试页',
      JSON.stringify(remoteContent.result?.content?.[0]?.text),
    );

    const remoteNav = await call({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url: fixture } },
    });
    check('MCP 侧导航成功', String(remoteNav.result?.content?.[0]?.text ?? '').includes('已打开'));
    const hostSide = await manager.run('content', { selector: '#title' });
    check('宿主机侧立刻看到 MCP 侧导航的结果（同一实例的另一面）', hostSide.text.trim() === '深边浏览器测试页');

    const badTool = await call({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'browser_nope', arguments: {} },
    });
    check('未知工具是协议层错误（-32602）', badTool.error?.code === -32602, String(badTool.error?.code));

    const failing = await call({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'browser_click', arguments: { selector: '#nope' } },
    });
    check(
      '工具业务失败走 isError 内容而不是 JSON-RPC error',
      failing.result?.isError === true && !failing.error,
      JSON.stringify(failing.result?.content?.[0]?.text ?? '').slice(0, 60),
    );

    const unknownMethod = await call({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
    check('未实现的方法是协议层错误（-32601）', unknownMethod.error?.code === -32601, String(unknownMethod.error?.code));

    // 关 stdin → 服务应自行收尾退出（否则内核退出后会留下一个孤儿 MCP 进程）
    child.stdin.end();
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    check('stdin 关闭后 MCP 服务自行退出', exited);
  }

  // ══════════════════════════════════════════════════════════
  // 进程清理
  // ══════════════════════════════════════════════════════════
  const pid = manager.state().pid;
  await manager.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check('宿主停止后浏览器进程树被终止', !isPidAlive(pid), `pid=${pid}`);
  check('停止后端点文件被清理', !fs.existsSync(path.join(home, 'browser-endpoint.json')));
  check('停止后状态如实报未运行', manager.state().running === false);
}

// ══════════════════════════════════════════════════════════
// 8. 接线取证（RPC / 壳层 / CLI）
// ══════════════════════════════════════════════════════════
function wiringSection() {
  console.log('\n── 接线取证 ──');
  {
    const handlers = buildHandlers(new DeepworkHost());
    check(
      'RPC 注册了 browser.state / open / close',
      ['browser.state', 'browser.open', 'browser.close'].every((method) => typeof handlers[method] === 'function'),
    );

    // 六个可写动作**不能**出现在 RPC 层：那是模型侧的入口，必须过审批。
    // 混进来就等于给出一条绕过审批的旁路。
    const contractSource = fs.readFileSync(path.join(root, 'packages', 'protocol', 'src', 'rpc.ts'), 'utf8');
    check(
      '契约层没有 browser.click / type / evaluate 这类 RPC 方法',
      !/'browser\.(click|type|evaluate|content|navigate|screenshot)'\s*:/.test(contractSource),
    );

    const mainSource = fs.readFileSync(path.join(root, 'apps', 'desktop', 'electron', 'main.js'), 'utf8');
    check(
      '壳层白名单放行了三个面板方法',
      ['browser.state', 'browser.open', 'browser.close'].every((method) => mainSource.includes(`'${method}'`)),
    );
    check(
      '壳层通道常量与契约层一致',
      mainSource.includes(`'${IPC.BROWSER_SHOTS}'`) && mainSource.includes(`'${IPC.BROWSER_SHOT_READ}'`),
    );
    check(
      '壳层截图目录规则与 core-host 一致（都用 DEEPWORK_HOME）',
      mainSource.includes("process.env.DEEPWORK_HOME") && mainSource.includes('browser-shots'),
    );

    const preloadSource = fs.readFileSync(path.join(root, 'apps', 'desktop', 'electron', 'preload.js'), 'utf8');
    check(
      'preload 暴露了截图清单与读取',
      preloadSource.includes('browserShots:') && preloadSource.includes('browserShotRead:'),
    );

    check(
      'CLI 入口产物存在（patch 里引用的就是它）',
      fs.existsSync(path.join(root, 'packages', 'core-host', 'dist', 'cli', 'browser-mcp.js')),
    );
  }
}

async function main() {
  await browserSection();
  wiringSection();

  const hard = results.filter((item) => !item.ok && !item.skip);
  const skipped = results.filter((item) => item.skip);
  console.log(`\n浏览器自动化测试：${results.length - hard.length}/${results.length} 通过${skipped.length ? `（${skipped.length} 项 SKIP）` : ''}`);
  if (hard.length > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error);
    process.exit(1);
  })
  .finally(() => {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      // 浏览器 profile 可能还被占用；临时目录留在系统临时区不影响结果
    }
  });
