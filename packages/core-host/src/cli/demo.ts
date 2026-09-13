/**
 * 端到端演示脚本 —— 不依赖 Electron，纯 Node 跑通「会话 → 工具 → 审批 → 事件流 → 落盘」全链路。
 *
 *   npm run demo -w @deepwork/core-host
 *   DEMO_DENY=1 npm run demo     # 演示拒绝审批的分支
 *
 * 这个脚本是 CI 与本地验证的第一道防线：UI 出问题不代表内核链路出问题，反之亦然。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, FileDiff } from '@deepwork/protocol';
import { applyDiff, splitLines } from '../diff';
import { DeepworkHost } from '../host';

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  magenta: '\u001b[35m',
};

interface DemoStats {
  tools: number;
  approvals: number;
  approvalsAllowed: number;
  events: number;
  sessionEvents: number;
  sessions: number;
  /** 带副作用预览（文件差异）的工具调用次数 */
  diffs: number;
}

function seedWorkspace(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo-project', version: '1.0.0', private: true }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    '# Demo Project\n\n这是一个用于验证深边AI Work 内核链路的示例工程。\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'index.ts'),
    'export function greet(name: string): string {\n  return `hello, ${name}`;\n}\n',
    'utf8',
  );
}

async function main(): Promise<void> {
  // 所有环境变量在构造宿主之前落定：SessionStore / Guard 的路径解析发生在运行时，
  // 因此在 main() 里设置是安全的，同时避免污染真实用户主目录。
  const demoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-demo-'));
  process.env.DEEPWORK_HOME = path.join(demoRoot, '.deepwork');
  process.env.DEEPWORK_WORKSPACE = path.join(demoRoot, 'workspace');
  process.env.DEEPWORK_ADAPTER = process.env.DEEPWORK_ADAPTER ?? 'mock';

  const workspace = process.env.DEEPWORK_WORKSPACE as string;
  seedWorkspace(workspace);

  console.log(`${C.bold}深边AI Work · 内核链路演示${C.reset}`);
  console.log(`${C.dim}数据目录 ${process.env.DEEPWORK_HOME}${C.reset}`);
  console.log(`${C.dim}工作区   ${workspace}${C.reset}\n`);

  const host = new DeepworkHost();
  const stats: DemoStats = {
    tools: 0,
    approvals: 0,
    approvalsAllowed: 0,
    events: 0,
    sessionEvents: 0,
    sessions: 0,
    diffs: 0,
  };

  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = () => resolve();
  });

  host.onEvent((event: AgentEvent) => {
    stats.events += 1;
    if (isSessionScoped(event)) stats.sessionEvents += 1;
    render(event, stats, host);
    if (event.type === 'run.completed' || event.type === 'run.failed') {
      setTimeout(() => finish?.(), 150);
    }
  });

  const status = await host.start(workspace);
  console.log(`${C.dim}内核 adapter=${status.adapter} version=${status.version}${C.reset}\n`);

  const session = host.createSession({ workspace, title: '链路演示' });
  stats.sessions = host.listSessions().length;

  const prompt = process.argv.slice(2).join(' ') || '看一下这个工程，确认运行时环境，并把本轮的运行笔记写好。';
  console.log(`${C.bold}${C.cyan}用户 ›${C.reset} ${prompt}\n`);

  host.send({ sessionId: session.id, text: prompt });

  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 60_000))]);

  const events = host.sessionEvents(session.id);
  console.log(`\n${C.bold}── 校验 ──────────────────────────${C.reset}`);
  console.log(`事件总数        ${stats.events}（含宿主级事件 ${stats.events - stats.sessionEvents}）`);
  console.log(
    `会话内事件      ${stats.sessionEvents}`,
  );
  console.log(
    `落盘事件数      ${events.length}${
      events.length === stats.sessionEvents
        ? ` ${C.green}一致${C.reset}`
        : ` ${C.red}不一致（会话日志丢失 ${stats.sessionEvents - events.length} 条）${C.reset}`
    }`,
  );
  console.log(`工具调用        ${stats.tools}`);
  console.log(`差异预览        ${stats.diffs} 次`);
  console.log(`审批请求        ${stats.approvals}（放行 ${stats.approvalsAllowed}）`);
  console.log(`会话数          ${stats.sessions}`);

  // seq 是宿主级全局序号，不保证从 1 开始；此处只校验「相对连续」
  const seqOk =
    events.length === 0 ||
    events.every((event, index) => event.seq === (events[0]?.seq ?? 0) + index);
  console.log(`事件序号连续    ${seqOk ? `${C.green}是${C.reset}` : `${C.red}否${C.reset}`}`);

  verifyDiffChain(events, workspace, stats, C);

  const logFile = path.join(process.env.DEEPWORK_HOME as string, 'sessions', session.id, 'events.jsonl');
  console.log(`会话日志        ${C.dim}${logFile}${C.reset}`);

  await host.stop();
  console.log(`\n${C.green}演示结束${C.reset}`);
  process.exit(0);
}

type ToolStartedEvent = Extract<AgentEvent, { type: 'tool.started' }>;

/** 与会话日志的落盘口径保持一致：只有会话级事件才会写进 events.jsonl */
function isSessionScoped(event: AgentEvent): boolean {
  if (event.type === 'session.created' || event.type === 'session.updated') return true;
  return 'runId' in event;
}

/**
 * 差异链路校验 —— 本轮功能的验收核心。
 *
 * 要证的命题只有一句：**用户看到的那份差异，还原出来就是磁盘上的实际内容**。
 * 任何一环脱节（预览用了旧快照、审批看着 A 却写了 B、diff 引擎算错行），
 * 这条断言都会失败。因此它比「diff 生成了没有」有意义得多。
 */
function verifyDiffChain(
  events: AgentEvent[],
  workspace: string,
  stats: DemoStats,
  palette: typeof C,
): void {
  const started = events.filter((event): event is ToolStartedEvent => event.type === 'tool.started');
  const writeCall = started.find((event) => event.call.name === 'fs.write' && event.call.diff);
  const editCall = started.find((event) => event.call.name === 'fs.edit' && event.call.diff);

  console.log(`\n${palette.bold}── 差异链路 ───────────────────────${palette.reset}`);

  if (!writeCall?.call.diff) {
    console.log(`差异预览        ${palette.dim}未产出（本次运行没有写操作）${palette.reset}`);
    return;
  }

  const w = writeCall.call.diff;
  // 落点从契约数据（diff.path）取，不写死实现细节 —— 写工具挪落点时，
  // 这条断言仍应成立，而不是拿一个不存在的路径继续对拍
  const target = path.resolve(workspace, w.path);
  console.log(
    `写操作 A        fs.write ${w.path} ${palette.green}+${w.added}${palette.reset} ${palette.red}−${w.removed}${palette.reset}${w.created ? ` ${palette.dim}(新建)${palette.reset}` : ''}`,
  );
  if (editCall?.call.diff) {
    const e = editCall.call.diff;
    console.log(
      `写操作 B        fs.edit  ${e.path} ${palette.green}+${e.added}${palette.reset} ${palette.red}−${e.removed}${palette.reset}`,
    );
  }

  // 拒绝分支：应当没有任何内容落盘，文件甚至不该存在
  if (stats.approvals > 0 && stats.approvalsAllowed === 0) {
    const exists = fs.existsSync(target);
    console.log(
      `拒绝生效        ${exists ? `${palette.red}否：文件仍被创建${palette.reset}` : `${palette.green}是：文件未被创建${palette.reset}`}`,
    );
    return;
  }

  // 还原必须按顺序应用本轮**全部**写/改差异（同一个文件可能被写多次 ——
  // 演示脚本的收尾就是第二次 fs.write），只套头两份会让「一致」停在中间态
  const ops = started.filter(
    (event) =>
      (event.call.name === 'fs.write' || event.call.name === 'fs.edit') &&
      event.call.diff &&
      event.call.diff.path === w.path,
  );
  let rebuilt = '';
  for (const op of ops) rebuilt = applyDiff(rebuilt, op.call.diff!);

  const actual = fs.existsSync(target) ? splitLines(fs.readFileSync(target, 'utf8')).join('\n') : null;
  const consistent = actual === rebuilt;
  console.log(
    `差异还原        ${
      consistent
        ? `${palette.green}一致${palette.reset} —— 两份差异还原出的内容与磁盘实际内容逐行相同（${splitLines(rebuilt).length} 行）`
        : `${palette.red}不一致${palette.reset} —— 预览与实际落盘脱节`
    }`,
  );
}

/**
 * 在终端里渲染一份迷你差异。
 *
 * 这不是为了好看：终端是最朴素的消费者，如果差异数据在这里都能正确渲染，
 * 说明它确实是自洽的结构化数据，而不是某种只对某个 UI 组件成立的中间态。
 */
function renderMiniDiff(diff: FileDiff, indent = ''): void {
  if (diff.binary) {
    console.log(`${indent}${C.dim}（二进制文件，不做行级差异）${C.reset}`);
    return;
  }

  const stat = `${diff.created ? '新建 ' : ''}+${diff.added} −${diff.removed}${diff.truncated ? '（已截断）' : ''}`;
  console.log(`${indent}${C.dim}${diff.path}  ${stat}${C.reset}`);

  const limit = 30;
  let shown = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (shown >= limit) {
        console.log(`${indent}${C.dim}… 差异过长，仅显示前 ${limit} 行${C.reset}`);
        return;
      }
      const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      const paint = line.kind === 'add' ? C.green : line.kind === 'remove' ? C.red : C.dim;
      console.log(`${indent}${paint}${sign}${line.text}${C.reset}`);
      shown += 1;
    }
  }
}

function render(event: AgentEvent, stats: DemoStats, host: DeepworkHost): void {
  switch (event.type) {
    case 'host.ready':
      console.log(`${C.dim}[宿主就绪] adapter=${event.adapter} caps=${event.capabilities.join(',')}${C.reset}`);
      break;
    case 'run.started':
      console.log(`${C.dim}[运行开始] mode=${event.mode} model=${event.model}${C.reset}`);
      break;
    case 'reasoning.delta':
      process.stdout.write(`${C.dim}${event.text}${C.reset}`);
      break;
    case 'message.delta':
      process.stdout.write(event.text);
      break;
    case 'message.completed':
      process.stdout.write('\n');
      break;
    case 'tool.started':
      stats.tools += 1;
      console.log(
        `\n${C.magenta}⚙ 调用工具${C.reset} ${C.bold}${event.call.name}${C.reset} ${C.dim}${event.call.summary}${C.reset}`,
      );
      if (event.call.diff) {
        stats.diffs += 1;
        renderMiniDiff(event.call.diff);
      }
      break;
    case 'tool.completed': {
      const head = event.output.split('\n').slice(0, 3).join('\n    ');
      console.log(
        `  ${event.ok ? C.green : C.red}${event.ok ? '✓' : '✗'}${C.reset} ${C.dim}${event.durationMs}ms${C.reset}\n    ${head}`,
      );
      break;
    }
    case 'approval.requested': {
      stats.approvals += 1;
      console.log(
        `\n${C.yellow}⚠ 需要审批${C.reset} ${event.request.tool}: ${C.bold}${event.request.subject}${C.reset}\n  ${C.dim}${event.request.reason}${C.reset}`,
      );
      if (event.request.diff) {
        console.log(`  ${C.dim}审批弹窗中展示的差异：${C.reset}`);
        renderMiniDiff(event.request.diff, '  ');
      }
      const deny = process.env.DEMO_DENY === '1';
      const decision = deny ? 'deny' : 'allow';
      console.log(`  ${C.dim}（自动${deny ? '拒绝' : '放行'} —— 真实 UI 中此处弹窗等待用户点击）${C.reset}`);
      if (!deny) stats.approvalsAllowed += 1;
      setTimeout(() => host.respondApproval(event.request.id, decision), 60);
      break;
    }
    case 'usage':
      console.log(
        `\n${C.dim}[用量] prompt=${event.usage.promptTokens} completion=${event.usage.completionTokens} 花费=¥${event.usage.costCny}${C.reset}`,
      );
      break;
    case 'run.completed':
      console.log(
        `\n${C.dim}[运行结束] status=${event.status} 耗时=${event.durationMs}ms${C.reset}`,
      );
      break;
    case 'run.failed':
      console.log(`\n${C.red}[运行失败] ${event.message}${C.reset}`);
      break;
    case 'session.updated':
    case 'session.created':
    case 'user.message':
      break;
    default:
      console.log(`${C.dim}[${event.type}]${C.reset}`);
  }
}

void main().catch((error: unknown) => {
  console.error(`${C.red}演示失败:${C.reset}`, error);
  process.exit(1);
});
