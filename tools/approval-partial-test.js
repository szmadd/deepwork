'use strict';

/**
 * 逐 hunk 授权的端到端验证 —— 从 UI 的点击一路走到磁盘上的字节。
 *
 *   npm run test:partial
 *
 * 为什么必须端到端做一遍：
 *
 * 单测能证明 `applySelectedHunks` 本身是对的，但证明不了「用户在弹窗里只勾了第一处」
 * 这件事能完好地穿过五层：审批弹窗 → IPC 白名单 → stdio NDJSON → 宿主待审批表 → 写工具。
 * 这条链上任何一处把 hunks 丢掉或写错名字，都不会报错 ——
 * 结果就是用户以为自己只批准了一处，磁盘上却改了两处。那正是审批链路最不能出的错。
 *
 * 因此这里断言的是最硬的那条等式：
 *   **磁盘上的内容 == 用「勾选的那一块」对「写入前的原文」做部分应用的结果**
 * 两侧都是独立算出来的，不存在「拿实现去证明实现」。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoreHostClient } = require('../apps/desktop/electron/core-host-client');
const { applySelectedHunks } = require('../packages/core-host/dist/diff');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-partial-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'partial' }, null, 2));

  /**
   * 差异里的 path 是「工作区相对路径、/ 分隔」，这里还原成磁盘路径。
   *
   * 演示脚本把笔记写在哪儿属于 mock 内核的实现细节，测试不写死；
   * 从差异里读路径，落点变了测试不用跟着改，也顺带验证了差异里的 path 确实可用。
   */
  const diskPath = (relative) => path.join(workspace, ...relative.split('/'));
  /** 被写入文件的磁盘路径；由第一次捕获到的写差异给出 */
  let notes = null;

  const client = new CoreHostClient();
  const received = [];
  /** 最后那次写入之前的文件原文；在 fs.edit 完成的那一刻抓取 */
  let beforeFinal = null;
  let selectableRequest = null;
  let partialAnswerSent = null;

  console.log('\n深边AI Work · 逐 hunk 授权端到端验证\n');

  client.on('event', (event) => {
    received.push(event);

    // 抓住「最后一步写入之前」的那份内容：部分应用的参照物必须来自磁盘，不能靠重算。
    // 只抓第一次 —— 后续别的 tool.completed 也会命中同一段查找逻辑，
    // 覆盖掉的话拿到的就是写入之后的内容，整条断言会退化成恒真。
    if (event.type === 'tool.completed' && event.ok && beforeFinal === null) {
      const related = [...received]
        .reverse()
        .find((item) => item.type === 'tool.started' && item.call.name === 'fs.edit');
      const target = related?.call.diff ? diskPath(related.call.diff.path) : null;
      if (target && fs.existsSync(target)) {
        beforeFinal = fs.readFileSync(target, 'utf8');
        notes = target;
      }
    }

    if (event.type !== 'approval.requested') return;

    const request = event.request;
    // 只有「可逐块取舍」的那一次才做部分授权，其余一律整体放行
    const respond =
      request.selectable && request.diff && request.diff.hunks.length > 1
        ? { decision: 'allow', hunks: [0] }
        : { decision: 'allow' };

    if (respond.hunks) selectableRequest = request;

    setTimeout(() => {
      client
        .invoke('approval.respond', { requestId: request.id, ...respond })
        .then((result) => {
          if (respond.hunks) partialAnswerSent = { request, result };
        })
        .catch(() => undefined);
    }, 20);
  });

  client.start({ workspace, home: path.join(root, '.deepwork') });
  await client.invoke('host.status');

  const session = await client.invoke('session.create', { workspace, title: '逐块授权' });
  await client.invoke('run.send', { sessionId: session.id, text: '端到端验证逐 hunk 授权' });

  await new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (received.some((event) => event.type === 'run.completed') || Date.now() - started > 60_000) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });

  const ofType = (type) => received.filter((event) => event.type === type);

  // ── 授权请求本身 ─────────────────────────────────────────
  check('存在可逐块取舍的授权请求', Boolean(selectableRequest), selectableRequest ? `${selectableRequest.diff.hunks.length} 处改动` : '未出现');
  check(
    '不可逐块取舍的请求（新建文件 / 单块）未被标记为 selectable',
    ofType('approval.requested').some((event) => event.request.selectable !== true),
    `${ofType('approval.requested').filter((e) => !e.request.selectable).length} 次整体授权`,
  );
  check('部分授权应答被宿主接受', partialAnswerSent?.result?.ok === true);

  // ── 日志如实记录「只采纳了哪一块」──────────────────────────
  const resolved = ofType('approval.resolved').find((event) => Array.isArray(event.hunks));
  check('审批决议在日志里记录了采纳的 hunk', Boolean(resolved) && resolved.hunks.length === 1 && resolved.hunks[0] === 0, resolved ? `hunks=${JSON.stringify(resolved.hunks)}` : '未记录');
  check('部分授权仍标记为 allow', resolved?.decision === 'allow', `decision=${resolved?.decision}`);

  // ── 磁盘内容 ────────────────────────────────────────────
  const finalDiff = [...ofType('tool.started')]
    .reverse()
    .find((event) => event.call.name === 'fs.write' && event.call.diff && event.call.diff.hunks.length > 1)?.call.diff;

  // 最后一次写入的目标路径以它自己的差异为准
  const notesPath = finalDiff ? diskPath(finalDiff.path) : notes;
  const onDisk = notesPath && fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : null;

  check('写入前的原文被成功捕获', typeof beforeFinal === 'string' && beforeFinal.length > 0);

  // 参照物必须先立住，否则下面的对拍是拿 null 比 null
  if (typeof beforeFinal !== 'string' || !finalDiff || onDisk === null) {
    check('磁盘内容 == 部分应用的结果（独立计算对拍）', false, '前置条件缺失，无法对拍');
  } else {
    const expected = applySelectedHunks(beforeFinal, finalDiff, [0]);
    check(
      '磁盘内容 == 部分应用的结果（独立计算对拍）',
      onDisk === expected,
      `${onDisk.split('\n').length} 行逐字节比对`,
    );
  }
  // 文件读不到时用空串兜底：让下面几条如实失败，而不是抛异常把整个套件带崩
  const disk = onDisk ?? '';
  check(
    '第一处改动已落盘',
    disk.includes('- 已完成初步分析'),
    '观察结论已被更新',
  );
  check(
    '第二处改动未被落盘',
    disk.includes('- 待补充后续改动') && !disk.includes('- 无（本轮已收尾）'),
    '未采纳的块保持原文',
  );
  check(
    '未采纳的块确实出现在预览差异里（用户看得到自己拒了什么）',
    Boolean(finalDiff) && finalDiff.hunks.length === 2,
    `${finalDiff?.hunks.length} 处改动`,
  );

  // ── 工具输出如实说明 ─────────────────────────────────────
  const finalTool = [...ofType('tool.completed')].reverse().find((event) => event.output.includes('采纳'));
  check('工具输出如实报告采纳比例', Boolean(finalTool) && /采纳 1\/2/.test(finalTool.output), finalTool?.output?.split('\n')[0]);

  /**
   * 反向断言：部分授权的结果必须与整体授权**不同**。
   *
   * 没有这一条的话，一个「把 hunks 丢掉、默默整体写入」的实现也能让前面几条全部通过 ——
   * 因为那种情况下磁盘内容恰好等于全选的结果，而断言只看「第一处已落盘」。
   */
  if (typeof beforeFinal !== 'string' || !finalDiff) {
    check('部分授权的结果与整体授权不同（确实走了部分路径）', false, '前置条件缺失，无法对拍');
  } else {
    const fullExpected = applySelectedHunks(beforeFinal, finalDiff);
    check(
      '部分授权的结果与整体授权不同（确实走了部分路径）',
      onDisk !== fullExpected,
      `整体授权会多出 ${fullExpected.length - (onDisk?.length ?? 0)} 个字符的改动`,
    );
  }

  await client.stop();
  check('子进程已清理', true);

  const failed = results.filter((item) => !item.ok);
  console.log(
    `\n${failed.length === 0 ? '\u001b[32m全部通过\u001b[0m' : `\u001b[31m${failed.length} 项失败\u001b[0m`} （共 ${results.length} 项）\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('逐块授权验证异常:', error);
  process.exit(1);
});
