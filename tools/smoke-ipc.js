'use strict';

/**
 * IPC 冒烟测试 —— 不启动 Electron，直接验证「壳层 ↔ core-host」这条 stdio 链路。
 *
 * 它加载的就是 Electron 主进程使用的那份 core-host-client（同一段代码），
 * 因此能覆盖：子进程解析、NDJSON 分帧、请求响应配对、事件推送、审批回环、退出清理。
 *
 * 另外覆盖一件容易出事但不容易发现的事：**差异经过 JSON 序列化跨进程后是否还完整**。
 * 结构化差异的价值全在字段上（行号、kind、hunk 边界），掉一个字段 UI 不会报错，
 * 只会安静地显示错的东西 —— 所以这里必须用还原结果与磁盘内容对拍。
 *
 *   npm run smoke
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoreHostClient } = require('../apps/desktop/electron/core-host-client');
const { applyDiff, splitLines } = require('../packages/core-host/dist/diff');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-smoke-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'smoke', version: '1.0.0' }, null, 2),
  );

  const client = new CoreHostClient();
  const received = [];
  let approvals = 0;
  let resolved = 0;

  client.on('event', (event) => {
    received.push(event);
    // 每一次审批都要应答：写操作链路里每一步都会发审批，
    // 只放行第一个会让后续步骤一直等到超时，流程再也走不完
    if (event.type === 'approval.requested') {
      approvals += 1;
      setTimeout(() => {
        client
          .invoke('approval.respond', { requestId: event.request.id, decision: 'allow' })
          .catch(() => undefined);
      }, 20);
    }
    if (event.type === 'approval.resolved') resolved += 1;
  });

  console.log('\n深边AI Work · IPC 冒烟测试\n');

  client.start({ workspace, home: path.join(root, '.deepwork') });
  check('子进程启动', true, `运行时 ${client.runtimeSource}`);

  const status = await client.invoke('host.status');
  check('host.status 返回合法结构', typeof status?.adapter === 'string', `adapter=${status?.adapter}`);
  check('默认工作区已透传', status.workspace === workspace, status.workspace);

  const models = await client.invoke('models.list');
  check('models.list 非空', Array.isArray(models) && models.length > 0, `${models.length} 个模型`);

  const guard = await client.invoke('guard.get');
  check('guard.get 返回策略', typeof guard?.mode === 'string', `mode=${guard?.mode}`);

  // 设置读写往返：设置面板的每一次改动都要经过这条路径，字段丢了不会报错、只会安静失效
  const config = await client.invoke('config.get');
  check(
    'config.get 返回完整配置',
    typeof config?.defaultMode === 'string' && typeof config.terminalBufferLimit === 'number',
    `defaultMode=${config?.defaultMode} buffer=${config?.terminalBufferLimit}`,
  );
  const patched = await client.invoke('config.set', { patch: { treeDepth: 5 } });
  check('config.set 生效并回读', patched.treeDepth === 5, `treeDepth=${patched.treeDepth}`);
  check('未涉及的字段被保留', patched.defaultMode === config.defaultMode);
  await client.invoke('config.set', { patch: { treeDepth: config.treeDepth } });

  const session = await client.invoke('session.create', { workspace, title: '冒烟' });
  check('session.create 成功', typeof session?.id === 'string', session?.id);

  const sessions = await client.invoke('session.list');
  check('session.list 包含新会话', sessions.some((item) => item.id === session.id));

  const { runId } = await client.invoke('run.send', { sessionId: session.id, text: '冒烟测试' });
  check('run.send 立即返回 runId', typeof runId === 'string', runId);

  await new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (received.some((event) => event.type === 'run.completed') || Date.now() - started > 60_000) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });

  const has = (type) => received.some((event) => event.type === type);
  const ofType = (type) => received.filter((event) => event.type === type);

  check('收到 run.started', has('run.started'));
  check('收到流式 message.delta', has('message.delta'));
  check('收到工具调用事件', has('tool.started') && has('tool.completed'));
  check('审批回环闭合', approvals > 0 && resolved === approvals, `${approvals} 次请求 / ${resolved} 次决议`);
  check('收到 run.completed', has('run.completed'));

  // ── 差异链路（跨进程序列化后仍然完整）─────────────────────
  const previewCalls = ofType('tool.started').filter((event) => event.call.diff);
  check('工具卡片携带差异预览', previewCalls.length >= 2, `${previewCalls.length} 次`);

  const approvalDiffs = ofType('approval.requested').filter((event) => event.request.diff);
  check('审批请求携带差异', approvalDiffs.length >= 1, `${approvalDiffs.length} 次`);

  /**
   * 差异链：新建 → 精确替换 → 补全。
   *
   * 第三段（补全）是这一轮新加的，它把差异切成两个 hunk，
   * 因此这条链同时验证了「跨进程后 hunk 边界仍然完整」——
   * hunk 边界一旦在序列化中错位，逐块授权就会应用错行，而且静默无提示。
   */
  const writeCalls = ofType('tool.started').filter(
    (event) => event.call.name === 'fs.write' && event.call.diff,
  );
  const createCall = writeCalls.find((event) => event.call.diff.created);
  const finalCall = writeCalls.find(
    (event) => !event.call.diff.created && event.call.diff.hunks.length > 1,
  );
  const editCall = ofType('tool.started').find((event) => event.call.name === 'fs.edit' && event.call.diff);

  let rebuilt = createCall ? applyDiff('', createCall.call.diff) : null;
  if (rebuilt !== null && editCall) rebuilt = applyDiff(rebuilt, editCall.call.diff);
  if (rebuilt !== null && finalCall) rebuilt = applyDiff(rebuilt, finalCall.call.diff);

  /**
   * 目标路径从差异自身取，不在测试里写死。
   *
   * 演示内核把笔记写在哪儿是它的实现细节，写死了测试就变成「改一次演示脚本要回来改一次断言」；
   * 而差异里本来就有 path，用它才是「照着契约验」而不是「照着实现验」。
   */
  const notesRel = (finalCall ?? editCall ?? createCall)?.call.diff.path;
  const onDisk = notesRel
    ? splitLines(fs.readFileSync(path.join(workspace, ...notesRel.split('/')), 'utf8')).join('\n')
    : null;
  check(
    '差异经 IPC 后仍可还原',
    rebuilt !== null && onDisk !== null && rebuilt === onDisk,
    rebuilt === null
      ? '未捕获到写操作差异'
      : onDisk === null
        ? '差异里没有路径，无法定位磁盘文件'
        : `${splitLines(rebuilt).length} 行与磁盘一致（跨越 ${[createCall, editCall, finalCall].filter(Boolean).length} 次写入）`,
  );
  check(
    '写工具差异计数正确',
    Boolean(createCall) && createCall.call.diff.added > 0 && createCall.call.diff.created === true,
    createCall ? `+${createCall.call.diff.added} −${createCall.call.diff.removed}` : '未捕获',
  );
  check(
    '多 hunk 差异经 IPC 后切分正确',
    Boolean(finalCall) && finalCall.call.diff.hunks.length === 2,
    finalCall ? `${finalCall.call.diff.hunks.length} 块 · hunk 边界 ${JSON.stringify(finalCall.call.diff.hunks.map((h) => h.oldStart))}` : '未捕获',
  );
  check(
    '可逐块取舍的差异被标记为 selectable',
    ofType('approval.requested').some((event) => event.request.selectable === true),
    `${ofType('approval.requested').filter((event) => event.request.selectable).length} 次可选块`,
  );

  const seqOk = received.every((event, index) => index === 0 || event.seq > received[index - 1].seq);
  check('事件序号单调递增', seqOk);

  const persisted = await client.invoke('session.events', { sessionId: session.id });
  const sessionScoped = received.filter(
    (event) => 'runId' in event || event.type === 'session.created' || event.type === 'session.updated',
  );
  check(
    '事件与会话日志条数一致',
    persisted.length === sessionScoped.length,
    `推送 ${sessionScoped.length} / 落盘 ${persisted.length}`,
  );

  await client.invoke('session.delete', { sessionId: session.id });
  const after = await client.invoke('session.list');
  check('session.delete 生效', !after.some((item) => item.id === session.id));

  await client.stop();
  check('子进程已清理', true);

  const failed = results.filter((item) => !item.ok);
  console.log(
    `\n${failed.length === 0 ? '\u001b[32m全部通过\u001b[0m' : `\u001b[31m${failed.length} 项失败\u001b[0m`} （共 ${results.length} 项）\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('冒烟测试异常:', error);
  process.exit(1);
});
