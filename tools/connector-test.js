'use strict';

/**
 * 连接器管理（MCP）测试 —— 「清单怎么管」与「补丁怎么生成」如何被证明。
 *
 *   npm run test:connectors
 *
 * 三层各自独立断言：
 *   1. patch 纯函数：生成的对象形状与 dsh-mcp-client 源码取证的形状对拍
 *      （insert 条目 / 包名 / config 键：transport/serverName/command/args/env）、
 *      停用的排除、空清单返回 null、YAML 序列化结构正确；
 *   2. store 层：增删启停持久化、重名拒绝、非法名称拒绝（清单主键即工具名前缀）；
 *   3. host 链路 + RPC 接线：connectors.* 四个方法注册可用、kernel.restart
 *      在 mock 下真实完成一次适配器重启、空清单时补丁**不含连接器条目**、
 *      riskOfTool 对 mcp__ 前缀工具名的分级（经 mapUpdateToEvent 取证）。
 *
 * 注意「空清单不生成补丁文件」这条断言在 M2-H 之后不再成立：内置浏览器 MCP 服务
 * 常驻注入（与 fs / shell 一样始终对模型可见），补丁文件因此总会被写出来。
 * 断言据此改为看**内容**（有没有连接器条目），而不是看文件是否存在 —— 后者写死了
 * 「补丁文件只可能由连接器产生」这个实现细节，新增任何一个内置补丁贡献者都会让它变红，
 * 而它想守的语义（空清单不产生连接器插件）其实没被破坏。
 *
 * 真实内核链路由 tools/real-dsh-mcp-test.js 负责（dsh 缺席时优雅 SKIP）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-connectors-'));

const { buildConnectorPatch, serializeConnectorPatchYaml } = require('../packages/core-host/dist/mcp/patch');
const { ConnectorStore } = require('../packages/core-host/dist/mcp/store');
const { DeepworkHost } = require('../packages/core-host/dist/host');
const { buildHandlers } = require('../packages/core-host/dist/rpc/stdio-server');
const { mapUpdateToEvent } = require('../packages/core-host/dist/adapter/harness-sidecar');
const { validateConnectorConfig, connectorStateOf } = require('../packages/protocol/dist/mcp');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function throwsWith(fn, keyword) {
  try {
    fn();
  } catch (error) {
    return String(error instanceof Error ? error.message : error).includes(keyword);
  }
  return false;
}

// ══════════════════════════════════════════════════════════
// 1. patch 纯函数：形状与 dsh-mcp-client 源码对拍
// ══════════════════════════════════════════════════════════
console.log('\n── patch 纯函数 ──');

{
  const enabled = { name: 'fake', command: 'node', args: ['server.js'], env: { API_KEY: 'k1' }, enabled: true };
  const patch = buildConnectorPatch([enabled]);

  check('启用连接器生成一个 insert 补丁', Array.isArray(patch) && patch.length === 1 && Array.isArray(patch[0].insert));
  const entry = patch[0].insert[0];
  check('条目 name 是 dsh-mcp-client 包名', entry.name === '@deepseek-ai/dsh-mcp-client', entry.name);
  check('条目 id 由连接器名派生且稳定', entry.id === 'deepwork-connector-fake', entry.id);
  // config 键集合与 lib/index.js 的 zod Config（stdio 分支）对齐
  check('config 形状：transport/serverName/command/args/env',
    entry.config.transport === 'stdio'
      && entry.config.serverName === 'fake'
      && entry.config.command === 'node'
      && JSON.stringify(entry.config.args) === JSON.stringify(['server.js'])
      && entry.config.env?.API_KEY === 'k1');
  check('config 不含多余键（形状受控）',
    JSON.stringify(Object.keys(entry.config).sort()) === JSON.stringify(['args', 'command', 'env', 'serverName', 'transport']));

  // 停用排除
  const mixed = buildConnectorPatch([enabled, { name: 'off', command: 'x', enabled: false }]);
  check('停用的连接器不进补丁', mixed[0].insert.length === 1 && mixed[0].insert[0].config.serverName === 'fake');

  // 空清单与全停用都返回 null
  check('空清单返回 null（不传 --patch）', buildConnectorPatch([]) === null);
  check('全部停用返回 null', buildConnectorPatch([{ name: 'off', command: 'x', enabled: false }]) === null);

  // 可选键缺省时不出现在补丁里（让内核侧默认值生效）
  const minimal = buildConnectorPatch([{ name: 'mini', command: 'srv', enabled: true }])[0].insert[0];
  check('无 args/env 时补丁不带这两个键', !('args' in minimal.config) && !('env' in minimal.config));

  // YAML 序列化：结构行齐全、标量全部双引号（JSON 转义是 YAML 双引号的子集）
  const yaml = serializeConnectorPatchYaml(patch);
  check('YAML 顶层是 insert 补丁', yaml.includes('- insert:'));
  check('YAML 含包名与 id', yaml.includes('name: "@deepseek-ai/dsh-mcp-client"') && yaml.includes('id: "deepwork-connector-fake"'));
  check('YAML 含 config 全部键',
    ['transport: "stdio"', 'serverName: "fake"', 'command: "node"', 'args:', '- "server.js"', 'env:', '"API_KEY": "k1"']
      .every((line) => yaml.includes(line)), yaml);
  // Windows 路径的反斜杠必须被转义成 YAML 双引号内的合法形式
  const win = serializeConnectorPatchYaml(buildConnectorPatch([{ name: 'w', command: 'C:\\bin\\srv.exe', enabled: true }]));
  check('Windows 路径反斜杠被正确转义', win.includes('"C:\\\\bin\\\\srv.exe"'), win.trim().split('\n').pop());
}

// ══════════════════════════════════════════════════════════
// 2. store 层：持久化与校验
// ══════════════════════════════════════════════════════════
console.log('\n── 连接器存储 ──');

{
  const storeHome = path.join(root, 'store-home');
  const store = new ConnectorStore(storeHome);

  const added = store.add({ name: 'fs-tools', command: 'npx', args: ['-y', '@mcp/fs'], enabled: true });
  check('新增返回 ConnectorState（kernelManaged + note）',
    added.kernelManaged === true && added.note.includes('重启') || added.note.includes('启动'));
  check('note 如实说明工具名前缀', added.note.includes('mcp__fs-tools__'), added.note);

  const reread = new ConnectorStore(storeHome).list();
  check('落盘后可被新实例读回', reread.length === 1 && reread[0].name === 'fs-tools' && reread[0].enabled === true);

  check('重名被拒绝（名称即工具名前缀）', throwsWith(() => store.add({ name: 'fs-tools', command: 'x', enabled: true }), '已存在'));
  check('非法名称被拒绝（大写）', throwsWith(() => store.add({ name: 'Bad', command: 'x', enabled: true }), '名称'));
  check('非法名称被拒绝（路径分隔符）', throwsWith(() => store.add({ name: 'a/b', command: 'x', enabled: true }), '名称'));
  check('空命令被拒绝', throwsWith(() => store.add({ name: 'ok-name', command: '  ', enabled: true }), '命令'));

  const off = store.toggle('fs-tools', false);
  check('停用生效且 note 变化', off.config.enabled === false && off.note.includes('已停用'));
  check('停用也持久化', new ConnectorStore(storeHome).get('fs-tools').enabled === false);
  check('启停不存在的连接器返回 null', store.toggle('nope', true) === null);

  check('删除生效', store.remove('fs-tools') === true && store.list().length === 0);
  check('删除不存在的连接器返回 false', store.remove('nope') === false);

  // 契约共享纯函数
  check('validateConnectorConfig 合法返回 null', validateConnectorConfig({ name: 'a-1', command: 'x', enabled: true }) === null);
  check('connectorStateOf 停用态文案', connectorStateOf({ name: 'a', command: 'x', enabled: false }).note.includes('已停用'));
}

// ══════════════════════════════════════════════════════════
// 3. host 链路 + RPC 接线 + 风险分级
// ══════════════════════════════════════════════════════════
console.log('\n── host 链路与 RPC ──');

async function hostSection() {
  const hostHome = path.join(root, 'host-home');
  const wsHost = path.join(root, 'ws-host');
  fs.mkdirSync(wsHost, { recursive: true });
  process.env.DEEPWORK_HOME = hostHome;

  const host = new DeepworkHost({ scheduler: { tickMs: 60_000 } });
  await host.start(wsHost);

  // 空清单：补丁文件里不该出现连接器条目。
  // 不断言「文件不存在」——内置浏览器服务常驻注入，补丁文件总会被写出来（见文件头注释）。
  const patchFile = path.join(hostHome, 'runtime', 'kernel.patch.yml');
  const emptyPatchText = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  check('空清单启动：补丁不含任何连接器条目', !emptyPatchText.includes('deepwork-connector-'));

  const handlers = buildHandlers(host);
  const names = ['connectors.list', 'connectors.add', 'connectors.remove', 'connectors.toggle', 'kernel.restart'];
  check('connectors.* 与 kernel.restart 全部注册', names.every((name) => typeof handlers[name] === 'function'));

  const added = await handlers['connectors.add']({ config: { name: 'demo', command: 'node', args: ['s.js'], enabled: true } });
  check('connectors.add 返回状态', added?.config?.name === 'demo' && added.kernelManaged === true);
  const listed = await handlers['connectors.list']({});
  check('connectors.list 读回', listed.some((item) => item.config.name === 'demo'));
  const toggled = await handlers['connectors.toggle']({ name: 'demo', enabled: false });
  check('connectors.toggle 停用生效', toggled?.config?.enabled === false);
  let toggleErr = null;
  try {
    await handlers['connectors.toggle']({ name: 'nope', enabled: true });
  } catch (e) {
    toggleErr = e;
  }
  check('启停不存在的连接器抛错', String(toggleErr?.message ?? '').includes('不存在'));

  // 重新启用后重启内核：补丁文件生成且内容指向该连接器（mock 内核也会走完整重建路径）
  await handlers['connectors.toggle']({ name: 'demo', enabled: true });
  const status = await handlers['kernel.restart']({});
  check('kernel.restart 返回宿主状态', Boolean(status?.adapter) && Boolean(status?.workspace), `adapter=${status?.adapter}`);
  check('重启后补丁文件生成且指向该连接器',
    fs.existsSync(patchFile) && fs.readFileSync(patchFile, 'utf8').includes('serverName: "demo"'));

  // 删除连接器后再次重启：连接器条目被清理，内置浏览器服务保留
  const removed = await handlers['connectors.remove']({ name: 'demo' });
  check('connectors.remove 删除生效', removed?.ok === true);
  await handlers['kernel.restart']({});
  const clearedPatchText = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  check('清单清空后重启：连接器条目被清理', !clearedPatchText.includes('deepwork-connector-'));
  check('清空连接器不影响内置浏览器服务', clearedPatchText.includes('deepwork-browser'));

  await host.stop();

  // ── 风险分级（经 mapUpdateToEvent 取证：riskOfTool 的对外可见效果）──
  const riskOf = (title) =>
    mapUpdateToEvent({ sessionUpdate: 'tool_call', toolCallId: 'c1', title, kind: 'other', rawInput: {} }, 'r1')?.call?.risk;
  check('mcp__ 普通工具（echo/search）为 confirm 档',
    riskOf('mcp__fake__echo') === 'confirm' && riskOf('mcp__github__search') === 'confirm');
  check('mcp__ 写类工具（含 create/delete/write 名）至少 confirm',
    riskOf('mcp__github__create_issue') === 'confirm' && riskOf('mcp__fs__delete_file') === 'confirm');
  check('mcp__ 危险语义（shell/exec）升 danger', riskOf('mcp__ops__shell_exec') === 'danger');
  check('既有内置工具分级不受影响',
    riskOf('write') === 'confirm' && riskOf('read') === 'safe' && riskOf('pwsh') === 'danger');
}

async function main() {
  await hostSection();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n连接器管理测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
