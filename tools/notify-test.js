'use strict';

/**
 * 桌面通知（Notification API）测试 —— 判定规则、发文口径、链路接线。
 *
 *   npm run test:notify
 *
 * ── 这一层要钉住的核心规则只有一条 ─────────────────────────────────
 * **只在用户看不到的时候通知。**
 *
 * 它替掉了一堆「什么事件值得通知」的清单：定时触发、长跑完成、运行失败 ——
 * 全都适用同一条判据。这条规则的价值不在「省了几条 if」，而在它可判定：
 * 把「窗口可见吗」「是当前会话吗」两个事实喂进纯函数，输出就是可断言的。
 * 若非如此，「通知发错」（用户明明在看却弹了三次）只能靠人去发现，
 * 而没人会去数。
 *
 * ── 第二条要钉住的是口径 ───────────────────────────────────────────
 * `shown: true` 只表示**请求已交给系统**，不表示用户看到了 —— 专注模式、
 * 通知权限、未打包应用都可能让系统之后静默丢掉它，而没有任何 API 能回问。
 * 所以「发不出去要在界面上说出来」这件事必须在链路上真的接上，不能只是注释。
 */

const fs = require('node:fs');
const path = require('node:path');

const { notificationFor } = require('../packages/protocol/dist/notify');

const repo = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const ctx = (over) => ({ windowVisible: false, isCurrentSession: true, sessionTitle: '部署 Qwen', ...over });

// ══════════════════════════════════════════════════════════
// 1. 判定规则：只看「用户是否在看」
// ══════════════════════════════════════════════════════════
console.log('\n── 判定规则 ──');

const completed = { type: 'run.completed', runId: 'r1', status: 'completed', durationMs: 12_340 };

check(
  '窗口可见且正是当前会话 → 不打扰（用户就在看着它发生）',
  notificationFor(completed, ctx({ windowVisible: true, isCurrentSession: true })) === null,
);
check(
  '窗口可见但已切到别的会话 → 仍然通知（两个条件是「且」）',
  notificationFor(completed, ctx({ windowVisible: true, isCurrentSession: false })) !== null,
);
check(
  '窗口不可见（最小化/被盖住）→ 通知',
  notificationFor(completed, ctx({ windowVisible: false, isCurrentSession: true })) !== null,
);

// ══════════════════════════════════════════════════════════
// 2. 各类事件的措辞
// ══════════════════════════════════════════════════════════
console.log('\n── 事件覆盖与措辞 ──');

{
  const fired = notificationFor(
    { type: 'schedule.fired', runId: 'r2', sessionId: 's2', task: { title: '每日汇总' } },
    ctx(),
  );
  check('定时触发：标题带任务名、正文带会话名', fired?.title.includes('每日汇总') && fired?.body.includes('部署 Qwen'), fired?.title);
}

{
  const ok = notificationFor(completed, ctx());
  check('跑完：标题是「任务完成」并带会话名', ok?.title.includes('任务完成') && ok?.title.includes('部署 Qwen'), ok?.title);
  check('跑完：正文给出耗时', ok?.body.includes('12.3s'), ok?.body);
}

{
  const failed = notificationFor({ ...completed, status: 'failed' }, ctx());
  check('跑完但失败：标题改说「任务失败」（不能报成完成）', failed?.title.includes('任务失败'), failed?.title);
}

{
  const aborted = notificationFor({ ...completed, status: 'aborted' }, ctx());
  check(
    '中断：措辞与「完成」分开（人自己按的，不是成果）',
    aborted?.title.includes('中断') && aborted?.body.includes('中断'),
    `${aborted?.title} / ${aborted?.body}`,
  );
}

{
  const runFailed = notificationFor({ type: 'run.failed', runId: 'r3', message: '内核进程退出了', retryable: true }, ctx());
  check('运行失败：正文带上原因原文', runFailed?.title.includes('运行失败') && runFailed?.body.includes('内核进程退出了'), runFailed?.body);
}

{
  const info = notificationFor({ type: 'run.notice', runId: 'r4', level: 'info', message: '端点最近一次探测不可达' }, ctx());
  const warn = notificationFor({ type: 'run.notice', runId: 'r5', level: 'warn', message: '端点最近一次探测不可达' }, ctx());
  check('提示类 info 不打断（过程性播报不值得弹窗）', info === null);
  check('提示类 warn 才通知', warn !== null && warn.body.includes('不可达'), warn?.body);
}

{
  const unrelated = [
    { type: 'message.delta', runId: 'r6', text: '在做了' },
    { type: 'tool.started', runId: 'r7', call: {} },
    { type: 'approval.requested', runId: 'r8', request: {} },
    { type: 'usage', runId: 'r9' },
  ];
  check('无关事件一律不通知（判据是「看不到」，不是事件清单）', unrelated.every((event) => notificationFor(event, ctx()) === null));
}

// ══════════════════════════════════════════════════════════
// 3. 长度与边界
// ══════════════════════════════════════════════════════════
console.log('\n── 长度与边界 ──');

{
  const longTask = { type: 'schedule.fired', runId: 'r10', sessionId: 's10', task: { title: '很长的任务名'.repeat(30) } };
  const clipped = notificationFor(longTask, ctx({ sessionTitle: '很长的会话名'.repeat(30) }));
  check('标题被裁剪到上限以内', clipped.title.length <= 60, String(clipped.title.length));
  check('正文被裁剪到上限以内', clipped.body.length <= 160, String(clipped.body.length));
  check('裁剪带省略号（看得出被截过）', clipped.title.includes('…'));
}

{
  const blank = notificationFor({ type: 'run.failed', runId: 'r11', message: '', retryable: false }, ctx());
  check('空原因不产生空正文以外的错（仍给出可读标题）', Boolean(blank?.title));
  const squash = notificationFor({ type: 'run.failed', runId: 'r12', message: '多\n行\n原因', retryable: false }, ctx());
  check('正文里的换行被压成空格（通知栏是单行排版）', !squash.body.includes('\n'), squash.body);
}

// ══════════════════════════════════════════════════════════
// 4. 链路接线（读源码文本：Electron 起不来时也能验）
// ══════════════════════════════════════════════════════════
console.log('\n── 链路接线 ──');

{
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
  const main = read('apps/desktop/electron/main.js');
  check('主进程引用 Electron 的 Notification', /require\('electron'\)[\s\S]*Notification/.test(main) || main.includes(', Notification }'));
  check('主进程有独立的通知通道常量', main.includes("const CH_NOTIFY = 'deepwork:notify'"));
  check('主进程注册了该通道的 handler', main.includes('ipcMain.handle(CH_NOTIFY'));
  check(
    '主进程先问 isSupported()（不支持时明确说清楚，不让渲染层以为发出去了）',
    main.includes('Notification.isSupported()'),
  );
  check('返回值带 shown / reason 两个字段', /shown:\s*true/.test(main) && /shown:\s*false,\s*reason/.test(main));

  const preload = read('apps/desktop/electron/preload.js');
  check('preload 暴露 notify 并用同一通道常量', preload.includes('notify:') && preload.includes('CH_NOTIFY'));

  const api = read('apps/desktop/src/api.ts');
  check(
    '桥缺失时如实返回「没有通知通道」（不假装成功）',
    api.includes('当前环境没有通知通道') && api.includes("shown: false"),
  );

  const agent = read('apps/desktop/src/useAgent.ts');
  check('渲染层调用契约层的 notificationFor', agent.includes('notificationFor(event,'));
  check(
    '可见性取 document.hidden 与 document.hasFocus 两项（最小化 vs 被盖住是两回事）',
    agent.includes('!document.hidden') && agent.includes('document.hasFocus()'),
  );
  check('发不出去时写入横幅（不静默失败）', agent.includes('setNotifyWarning'));
  check('横幅是一次性告知（可关闭）', agent.includes('dismissNotifyWarning'));

  const app = read('apps/desktop/src/App.tsx');
  check(
    '横幅文案说清后果（切走时不会收到提醒）',
    app.includes('notifyWarning') && app.includes('窗口切走时不会收到提醒'),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n桌面通知测试：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
