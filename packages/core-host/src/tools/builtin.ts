import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import {
  BROWSER_ACTIONS,
  BROWSER_TOOL_RISK,
  OFFICE_DOCX_TOOL,
  OFFICE_READ_TOOL,
  OFFICE_TOOL_RISK,
  OFFICE_XLSX_TOOL,
  browserToolName,
  officeNativeExtensionList,
  type BrowserAction,
  type FileDiff,
} from '@deepwork/protocol';
import type { BrowserManager } from '../browser/manager';
import { applySelectedHunks, buildFileDiff, selectionStat, splitLines } from '../diff';
import { buildDocx } from '../office/docx';
import { formatBytes, readOfficeDocument, textViewOfBytes } from '../office/read';
import { buildXlsx, rowsFromMarkdownTable, type CellValue } from '../office/xlsx';
import { isInsideWorkspace } from '../security/guard';
import { IGNORED_DIRS } from '../workspace/tree';
import { truncate, type ToolContext, type ToolExecution, type ToolRegistry } from './registry';

/**
 * 内置工具集。
 *
 * 这些是「模型能对真实环境做什么」的边界，所有工具都必须经过 ctx.guard 与工作区边界检查。
 * 注意：这里的实现取代了 Harness 自带工具的位置，仅用于 Mock 适配器与端到端演示；
 * 接入真实 Harness 后，工具由内核侧提供，本文件退化为「本地兜底工具」。
 *
 * ── 写类工具的统一纪律（fs.write / fs.edit）──
 *  1. 先预检（preview）：读旧内容、算出新内容、生成差异，**不落盘**；
 *  2. 预检结果进 ctx.cache，handler 复用同一份快照 —— 保证用户看到的差异就是实际写入的内容；
 *  3. 差异随审批请求一起送达 UI，用户「看过差异」之后才授权；
 *  4. 授权通过才真正 writeFile。
 * 任何一步跳过，审批就退化成「点一下按钮」，安全叙事也就不成立了。
 */

const MAX_READ_BYTES = 200_000;
/** 超过该体积的文件不做行级差异预览（仍会走审批，只是看不到 diff） */
const MAX_DIFF_BYTES = 2_000_000;

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`缺少必需参数: ${key}`);
  }
  return value;
}

function resolveInWorkspace(target: string, ctx: ToolContext): string {
  const abs = path.resolve(ctx.workspace, target);
  if (!isInsideWorkspace(abs, ctx.workspace)) {
    throw new Error(`路径越出工作区边界，已拒绝: ${abs}`);
  }
  return abs;
}

/** 统一的展示路径：相对工作区、/ 分隔 */
function displayPath(abs: string, ctx: ToolContext): string {
  return path.relative(ctx.workspace, abs).split(path.sep).join('/');
}

async function listDir(dir: string, depth: number, prefix: string, out: string[]): Promise<void> {
  if (depth < 0) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const ignored = new Set(IGNORED_DIRS);
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const rel = path.join(prefix, entry.name);
    out.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory() && depth > 0) {
      await listDir(path.join(dir, entry.name), depth - 1, rel, out);
    }
  }
}

// ── 写类工具的预检 ────────────────────────────────────────────

interface WritePlan {
  tool: 'fs.write' | 'fs.edit';
  abs: string;
  rel: string;
  /** 旧内容；null 表示文件此前不存在，或体积超限未读取 */
  before: string | null;
  after: string;
  created: boolean;
  /** null 表示无法生成差异（体积超限或二进制），此时审批仍会执行，只是看不到 diff */
  diff: FileDiff | null;
}

const PLAN_KEY = 'write.plan';

type ReadOutcome = { text: string | null; tooLarge: boolean; missing: boolean };

/**
 * 读旧内容。
 *
 * 「文件不存在」与「文件太大读不了」必须分开表示 —— 两者都返回 null 的话，
 * 一个 3MB 的既有文件会被渲染成「全新文件、全部新增」，
 * 那是最坏的一类错误：用户看着一份假差异点了允许。
 */
async function readMaybe(abs: string, rel: string): Promise<ReadOutcome> {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { text: null, tooLarge: false, missing: true };
    }
    throw new Error(`无法访问 ${rel}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isDirectory()) throw new Error(`${rel} 是目录，不能作为文件写入`);
  if (stat.size > MAX_DIFF_BYTES) return { text: null, tooLarge: true, missing: false };
  return { text: await fs.readFile(abs, 'utf8'), tooLarge: false, missing: false };
}

/** 构造预检结果。抛出的异常会作为工具失败原因直接回给模型，措辞必须可行动。 */
async function buildWritePlan(
  tool: 'fs.write' | 'fs.edit',
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<WritePlan> {
  const abs = resolveInWorkspace(requireString(args, 'path'), ctx);
  const rel = displayPath(abs, ctx);
  const previous = await readMaybe(abs, rel);
  const created = previous.missing;

  let after: string;

  if (tool === 'fs.write') {
    after = requireString(args, 'content');
  } else {
    const oldString = requireString(args, 'old_string');
    if (typeof args.new_string !== 'string') {
      throw new Error('缺少必需参数: new_string（如需删除该段内容，请显式传空字符串）');
    }
    const newString = args.new_string;
    const replaceAll = args.replace_all === true;

    if (previous.missing) throw new Error(`${rel} 不存在，无法编辑（可改用 fs.write 新建）`);
    if (previous.text === null) throw new Error(`${rel} 体积超出读取上限，无法安全编辑`);
    if (oldString === newString) throw new Error('old_string 与 new_string 相同，无需修改');

    const occurrences = countOccurrences(previous.text, oldString);
    if (occurrences === 0) {
      throw new Error(`在 ${rel} 中未找到 old_string，请先读取文件确认原文（注意缩进与空行必须完全一致）`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string 在 ${rel} 中出现 ${occurrences} 次，不唯一。` +
          `请扩大上下文使其唯一，或显式传 replace_all: true 替换全部`,
      );
    }

    after = replaceAll
      ? previous.text.split(oldString).join(newString)
      : previous.text.replace(oldString, newString);
  }

  // 体积超限时不给差异（null），而不是伪造一份「全新增」
  const diff = previous.tooLarge ? null : buildFileDiff({ path: rel, oldText: previous.text, newText: after });

  return { tool, abs, rel, before: previous.text, after, created, diff };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 取预检结果，同一轮工具执行内只算一次 */
async function planFor(
  tool: 'fs.write' | 'fs.edit',
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<WritePlan> {
  const cached = ctx.cache.get(PLAN_KEY) as WritePlan | undefined;
  if (cached && cached.tool === tool) return cached;
  const plan = await buildWritePlan(tool, args, ctx);
  ctx.cache.set(PLAN_KEY, plan);
  return plan;
}

/**
 * 写类工具的完整流程：预检 → 无变化短路 → 审批（带差异）→ 落盘。
 * 两个写工具共用它，是为了让安全流程只有一份实现，避免其中一个被改漏。
 */
async function runWriteTool(
  tool: 'fs.write' | 'fs.edit',
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecution> {
  let plan: WritePlan;
  try {
    plan = await planFor(tool, args, ctx);
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }

  // 内容完全没变就不落盘，也不必打扰用户（注意：新建空文件是真实变化，不能短路）
  const noop =
    plan.diff !== null &&
    !plan.created &&
    !plan.diff.binary &&
    plan.diff.added === 0 &&
    plan.diff.removed === 0;
  if (noop) {
    return { ok: true, output: `${plan.rel} 内容无变化，未写入` };
  }

  const assessment = ctx.guard.assess(`${tool} ${plan.rel}`);
  if (assessment.blocked) {
    return { ok: false, output: `写入被策略阻断：${assessment.reason}` };
  }

  /**
   * 逐 hunk 授权只在这些条件下开放：
   *  - 有差异，且差异不是二进制、没有因超限被截断（截断的差异不完整，按块授权会漏改）；
   *  - 不是新建文件（新文件的「部分采纳」会让用户得到一个半成品文件，且没有原文可回退）；
   *  - 至少两个 hunk（只有一个 hunk 时「选块」与「全选」等价，多一个开关只会添乱）。
   */
  const selectable =
    plan.diff !== null &&
    !plan.diff.binary &&
    !plan.diff.truncated &&
    !plan.created &&
    plan.diff.hunks.length > 1;

  let content = plan.after;
  let partialNote = '';

  if (assessment.risk !== 'safe' && ctx.requestApproval) {
    const outcome = await ctx.requestApproval({
      tool,
      subject: plan.rel,
      reason: plan.diff
        ? assessment.reason
        : `${assessment.reason}（文件体积超出差异预览上限，无法展示改动内容）`,
      diff: plan.diff ?? undefined,
      selectable,
    });
    if (!outcome.approved) return { ok: false, output: `用户拒绝了本次写入，${plan.rel} 未被修改` };

    if (outcome.hunks !== undefined) {
      if (!selectable || plan.diff === null || plan.before === null) {
        // 界面本不该在不可选时给出 hunk 选择；真发生了就整体拒绝，
        // 而不是「尽力而为」地挑几块写下去 —— 写文件的授权语义必须可预测。
        return { ok: false, output: `本次授权不支持逐块选择，已放弃写入 ${plan.rel}` };
      }
      const accepted = new Set(outcome.hunks);
      if (accepted.size === 0) {
        return { ok: false, output: `用户未采纳任何改动，${plan.rel} 未被修改` };
      }
      if (accepted.size < plan.diff.hunks.length) {
        try {
          content = applySelectedHunks(plan.before, plan.diff, outcome.hunks);
        } catch (error) {
          return {
            ok: false,
            output: `部分应用失败，${plan.rel} 未被修改：${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const stat = selectionStat(plan.diff, outcome.hunks);
        partialNote = `，采纳 ${accepted.size}/${plan.diff.hunks.length} 处（+${stat.added} −${stat.removed}）`;
      }
    }
  }

  await fs.mkdir(path.dirname(plan.abs), { recursive: true });
  await fs.writeFile(plan.abs, content, 'utf8');

  const lines = splitLines(content).length;
  const stat =
    plan.diff && partialNote === '' ? `（+${plan.diff.added} −${plan.diff.removed}）` : '';
  const verb = plan.created ? '已新建' : '已更新';
  return { ok: true, output: `${verb} ${plan.rel}${stat}${partialNote}，共 ${lines} 行` };
}

// ── 工具注册 ──────────────────────────────────────────────────

/**
 * 注册内置工具。
 *
 * `deps.browser` 存在才注册六个浏览器工具 —— 它们的行为由**进程级**的浏览器
 * 管理器承载（拉起浏览器、共享 endpoint 文件），没有它就只是一组永远报
 * 「浏览器未接线」的空壳。工具清单会进系统提示词，把不可用的工具摆给模型
 * 看，等于让它去撞一堵已知的墙。
 */
export function registerBuiltinTools(registry: ToolRegistry, deps?: { browser?: BrowserManager }): void {
  registry.register({
    name: 'fs.list',
    description: '列出工作区内的文件与目录',
    parameters: { path: 'string，相对工作区的路径，默认 .', depth: 'number，递归层数，默认 2' },
    handler: async (args, ctx): Promise<ToolExecution> => {
      const rel = typeof args.path === 'string' && args.path ? args.path : '.';
      const target = resolveInWorkspace(rel, ctx);
      const depth = typeof args.depth === 'number' ? args.depth : 2;
      const out: string[] = [];
      await listDir(target, depth, '', out);
      const text = out.length ? out.slice(0, 400).join('\n') : '(空目录)';
      const { text: clipped, truncated } = truncate(text);
      return { ok: true, output: clipped, truncated };
    },
  });

  registry.register({
    name: 'fs.read',
    description: '读取工作区内某个文本文件的内容',
    parameters: { path: 'string，文件相对路径' },
    handler: async (args, ctx): Promise<ToolExecution> => {
      const target = resolveInWorkspace(requireString(args, 'path'), ctx);
      const stat = await fs.stat(target);
      if (stat.size > MAX_READ_BYTES) {
        return { ok: false, output: `文件过大（${stat.size} 字节），超出单次读取上限` };
      }
      const content = await fs.readFile(target, 'utf8');
      const { text, truncated } = truncate(content);
      return { ok: true, output: text, truncated };
    },
  });

  registry.register({
    name: 'fs.write',
    description: '在工作区内写入文本文件（存在则覆盖）',
    parameters: { path: 'string，文件相对路径', content: 'string，文件内容' },
    preview: async (args, ctx) => {
      try {
        return (await planFor('fs.write', args, ctx)).diff;
      } catch {
        // 预览失败不阻断：真正的问题会在执行阶段以同样的措辞报出
        return null;
      }
    },
    handler: (args, ctx) => runWriteTool('fs.write', args, ctx),
  });

  registry.register({
    name: 'fs.edit',
    description: '对工作区内的文本文件做精确字符串替换（推荐用于修改已有文件）',
    parameters: {
      path: 'string，文件相对路径',
      old_string: 'string，要被替换的原文，必须与文件内容完全一致（含缩进）',
      new_string: 'string，替换后的内容',
      replace_all: 'boolean，是否替换全部匹配，默认 false（要求 old_string 唯一）',
    },
    preview: async (args, ctx) => {
      try {
        return (await planFor('fs.edit', args, ctx)).diff;
      } catch {
        return null;
      }
    },
    handler: (args, ctx) => runWriteTool('fs.edit', args, ctx),
  });

  registry.register({
    name: 'fs.search',
    description: '在工作区内按关键字搜索文本内容',
    parameters: { query: 'string，搜索关键字', max: 'number，最大命中数，默认 40' },
    handler: async (args, ctx): Promise<ToolExecution> => {
      const query = requireString(args, 'query');
      const max = typeof args.max === 'number' ? args.max : 40;
      const hits: string[] = [];
      const files: string[] = [];
      await listDir(ctx.workspace, 4, '', files);
      for (const rel of files) {
        if (rel.endsWith('/') || hits.length >= max) continue;
        if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|exe|dll|zip|pdf)$/i.test(rel)) continue;
        try {
          const content = await fs.readFile(path.join(ctx.workspace, rel), 'utf8');
          content.split('\n').forEach((line, index) => {
            if (hits.length < max && line.toLowerCase().includes(query.toLowerCase())) {
              hits.push(`${rel}:${index + 1}: ${line.trim().slice(0, 160)}`);
            }
          });
        } catch {
          // 二进制或不可读，跳过
        }
      }
      return {
        ok: true,
        output: hits.length ? `${hits.length} 处命中:\n${hits.join('\n')}` : `未找到「${query}」`,
      };
    },
  });

  registry.register({
    name: 'shell.run',
    description: '在工作区执行 shell 命令（写操作需用户确认）',
    parameters: {
      command: 'string，完整命令行',
      timeoutMs: 'number，超时毫秒，默认 60000',
      cwd: 'string，工作区内的相对目录',
    },
    handler: async (args, ctx): Promise<ToolExecution> => {
      const command = requireString(args, 'command');
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 60_000;
      const cwd = typeof args.cwd === 'string' && args.cwd ? resolveInWorkspace(args.cwd, ctx) : ctx.workspace;

      const assessment = ctx.guard.assess(command);
      if (assessment.blocked) {
        return { ok: false, output: `命令被策略阻断：${assessment.reason}` };
      }
      if (assessment.risk !== 'safe' && ctx.requestApproval) {
        const outcome = await ctx.requestApproval({
          tool: 'shell.run',
          subject: command,
          reason: assessment.reason,
        });
        if (!outcome.approved) return { ok: false, output: '用户拒绝了本次命令执行' };
      }

      return new Promise<ToolExecution>((resolve) => {
        exec(
          command,
          { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
            const { text, truncated } = truncate(combined || '(无输出)');
            if (error) {
              const killed = (error as { killed?: boolean }).killed;
              resolve({
                ok: false,
                output: killed ? `命令超时（${timeoutMs}ms）被终止\n${text}` : `${text}\n[退出异常] ${error.message}`,
                truncated,
              });
              return;
            }
            resolve({ ok: true, output: text, truncated });
          },
        );
      });
    },
  });

  registry.register({
    name: 'web.search',
    description: '联网检索（需要配置 DEEPWORK_SEARCH_URL，否则返回未配置提示）',
    parameters: { query: 'string，检索词' },
    handler: async (args): Promise<ToolExecution> => {
      const query = requireString(args, 'query');
      const endpoint = process.env.DEEPWORK_SEARCH_URL;
      if (!endpoint) {
        return {
          ok: false,
          output: `未配置检索服务（环境变量 DEEPWORK_SEARCH_URL 为空），无法检索「${query}」。这是预期行为，避免在无凭据时伪造检索结果。`,
        };
      }
      try {
        const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) return { ok: false, output: `检索服务返回 ${response.status}` };
        const body = await response.text();
        const { text, truncated } = truncate(body);
        return { ok: true, output: text, truncated };
      } catch (error) {
        return { ok: false, output: `检索失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  if (deps?.browser) registerBrowserTools(registry, deps.browser);
  registerOfficeTools(registry);
}

// ── 浏览器工具（六个动作）──────────────────────────────────────

/**
 * 工具声明。
 *
 * 六个动作共用一个注册循环（而不是六段几乎相同的 register 调用）：
 * 它们的差别只有「叫什么、要哪些参数、审批时怎么描述」，多写五遍的结果
 * 必然是其中一两处忘了改（例如加了参数却没写进 parameters，
 * 模型按提示词调用时会一直缺参）。
 */
const BROWSER_TOOL_SPECS: Record<
  BrowserAction,
  {
    description: string;
    parameters: Record<string, string>;
    /** 审批弹窗里的「对什么操作」；取不到参数时给一句人话而不是抛错 */
    subject: (args: Record<string, unknown>) => string;
    reason: string;
  }
> = {
  navigate: {
    description: '在受管浏览器中打开一个网址（浏览器未启动时会自动拉起）',
    parameters: { url: 'string，完整 URL（http/https/file/data）' },
    subject: (args) => (typeof args.url === 'string' && args.url ? args.url : '(未提供 URL)'),
    reason: '将访问外部网页',
  },
  content: {
    description: '读取当前页面的可读文本（可只读某个 CSS 选择器命中的元素）',
    parameters: { selector: 'string，可选，CSS 选择器' },
    subject: (args) => (typeof args.selector === 'string' && args.selector ? args.selector : '(整页)'),
    reason: '将读取页面内容',
  },
  click: {
    description: '点击页面中某个 CSS 选择器命中的元素',
    parameters: { selector: 'string，CSS 选择器' },
    subject: (args) => (typeof args.selector === 'string' ? args.selector : '(未提供选择器)'),
    reason: '将点击页面元素（可能改变远端页面状态）',
  },
  type: {
    description: '向页面上的输入框输入文本，可选提交所在表单',
    parameters: {
      selector: 'string，CSS 选择器',
      text: 'string，要输入的文本',
      submit: 'boolean，是否提交所在表单，默认 false',
    },
    subject: (args) => (typeof args.selector === 'string' ? args.selector : '(未提供选择器)'),
    reason: '将向页面输入文本（可能改变远端页面状态）',
  },
  evaluate: {
    description: '在页面上下文执行一段 JavaScript 并返回结果（高风险）',
    parameters: { expression: 'string，要执行的表达式或语句' },
    subject: () => '页面上下文脚本',
    reason: '将在页面里执行脚本，与执行 shell 同级',
  },
  screenshot: {
    description: '对当前页面截图并把 PNG 保存到磁盘（返回路径）',
    parameters: { name: 'string，可选文件名，默认按时间戳' },
    subject: () => '当前页面',
    reason: '将对当前页面截图',
  },
};

function registerBrowserTools(registry: ToolRegistry, browser: BrowserManager): void {
  for (const action of BROWSER_ACTIONS) {
    const spec = BROWSER_TOOL_SPECS[action];
    registry.register({
      name: browserToolName(action),
      description: spec.description,
      parameters: spec.parameters,
      handler: async (args, ctx): Promise<ToolExecution> => {
        // 风险档取自契约层的 BROWSER_TOOL_RISK：面板提示语与这里的审批判断
        // 必须是同一份表，否则会出现「界面说只是打开网页、审批按危险操作拦」
        const risk = BROWSER_TOOL_RISK[action];
        if (risk !== 'safe' && ctx.requestApproval) {
          const outcome = await ctx.requestApproval({
            tool: browserToolName(action),
            subject: spec.subject(args),
            reason: spec.reason,
          });
          if (!outcome.approved) {
            return { ok: false, output: `用户拒绝了本次操作（${spec.subject(args)}），浏览器未执行任何动作` };
          }
        }

        try {
          const result = await browser.run(action, args);
          return { ok: true, output: result.text, truncated: result.truncated };
        } catch (error) {
          // 失败如实报出：浏览器的问题大多是「元素没找到 / 页面还没渲染完」，
          // 把原文给模型，它通常能自己改选择器重试；换成笼统的「操作失败」就不能了
          return { ok: false, output: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  }
}

// ── Office 文档工具（M2-I）────────────────────────────────────

/**
 * 三个工具与普通写工具（fs.write / fs.edit）最大的不同：
 *
 * 产物是**二进制包**，而批注纪律要求「用户批准之前必须看见内容」——
 * 二进制没法做行级差异。这里的选择是：差异展示**文档的文本视图**
 * （docx 抽段落、xlsx 抽单元格），即「这份文档将要变成什么」。
 *
 * 它没有骗人：视图就是文档的全部可读内容的逐字反映，只是行号对应的不是
 * 二进制偏移。审批理由里会写明「差异展示的是文档文本视图」，避免误解。
 * 反过来，只给一句「二进制文件，不做行级差异展示」，等于把审批降级成
 * 「点一下按钮」—— 那正是这套安全叙事里最不能接受的一环。
 *
 * 生成 → 抽取这条回路也是**唯一**能让审批看到内容的方式，
 * 而读取器（含 OFD）本来就要写，两件事共用一份实现。
 */
const OFFICE_WRITE_TOOLS = [OFFICE_DOCX_TOOL, OFFICE_XLSX_TOOL] as const;
type OfficeWriteTool = (typeof OFFICE_WRITE_TOOLS)[number];

/** 与写工具的 'write.plan' 分开，避免两个预检结果互相覆盖 */
const OFFICE_PLAN_KEY = 'office.plan';

interface OfficeWritePlan {
  tool: OfficeWriteTool;
  kind: 'docx' | 'xlsx';
  abs: string;
  rel: string;
  bytes: Buffer;
  created: boolean;
  /** 旧文件的文本视图；null 表示文件不存在，或旧文件解析不出来 */
  before: string | null;
  /** 目标文件已存在但解析不出内容（超限或格式不认识） */
  beforeUnreadable: boolean;
  diff: FileDiff | null;
  summary: string;
}

/**
 * 扩展名对齐。
 *
 * 无扩展名 → 补上（模型常写 `报告` 而不是 `报告.docx`，补全符合意图）；
 * 但**给了别的扩展名就报错**（`office.docx` 写 `报告.txt` 会得到一个
 * 「名字说它是文本、内容其实是 Word 包」的文件，那是最糟糕的产物）。
 */
function ensureExtension(abs: string, tool: string, expected: string): string {
  const ext = path.extname(abs);
  if (!ext) return `${abs}${expected}`;
  if (ext.toLowerCase() === expected) return abs;
  throw new Error(
    `${tool} 的 path 必须以 ${expected} 结尾（收到的是「${ext}」）—— 名字与内容不符的文件会误导之后所有读它的人`,
  );
}

/** 单元格取值：对象/数组用 JSON 落地，总比丢掉内容好 */
function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function normalizeRows(input: unknown): CellValue[][] {
  if (typeof input === 'string') {
    const parsed = rowsFromMarkdownTable(input);
    if (parsed.length === 0) {
      // 「传了一段文字但解析不出表格」与「传了个对象」是两种错误，得分别说 ——
      // 笼统报一句「rows 不合法」，模型不知道是该改格式还是该补内容
      throw new Error(
        'rows 是一段解析不出表格的文本（Markdown 管道表格至少要有一行含「|」的表头），也可以直接传二维数组',
      );
    }
    return parsed;
  }
  if (!Array.isArray(input)) {
    throw new Error('rows 需要是二维数组（数组的数组），或一段 Markdown 管道表格');
  }
  return input.map((row) => (Array.isArray(row) ? row.map(toCellValue) : [toCellValue(row)]));
}

async function buildOfficePlan(
  tool: OfficeWriteTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<OfficeWritePlan> {
  const kind = tool === OFFICE_DOCX_TOOL ? 'docx' : 'xlsx';
  const abs = ensureExtension(resolveInWorkspace(requireString(args, 'path'), ctx), tool, `.${kind}`);
  const rel = displayPath(abs, ctx);

  let bytes: Buffer;
  let summary: string;
  if (kind === 'docx') {
    const built = buildDocx({
      title: typeof args.title === 'string' && args.title ? args.title : undefined,
      markdown: requireString(args, 'content'),
    });
    bytes = built.bytes;
    summary = built.summary;
  } else {
    const built = buildXlsx({
      rows: normalizeRows(args.rows),
      sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
      header: args.header !== false,
    });
    bytes = built.bytes;
    summary = built.summary;
  }

  // 旧文件读一次，同时服务于两件事：判断「内容是否真的变了」与生成内容视图差异
  let exists = false;
  let before: string | null = null;
  let beforeUnreadable = false;
  try {
    const stat = await fs.stat(abs);
    exists = true;
    if (stat.isDirectory()) throw new Error(`${rel} 是目录，不能作为文件写入`);
    if (stat.size > MAX_DIFF_BYTES) {
      beforeUnreadable = true;
    } else {
      const view = textViewOfBytes(await fs.readFile(abs), kind);
      if (view.ok) before = view.text;
      else beforeUnreadable = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const after = textViewOfBytes(bytes, kind);
  const diff =
    after.ok && !beforeUnreadable
      ? buildFileDiff({ path: rel, oldText: before, newText: after.text })
      : null;

  return { tool, kind, abs, rel, bytes, created: !exists, before, beforeUnreadable, diff, summary };
}

async function planForOffice(
  tool: OfficeWriteTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<OfficeWritePlan> {
  const cached = ctx.cache.get(OFFICE_PLAN_KEY) as OfficeWritePlan | undefined;
  if (cached && cached.tool === tool) return cached;
  const plan = await buildOfficePlan(tool, args, ctx);
  ctx.cache.set(OFFICE_PLAN_KEY, plan);
  return plan;
}

async function runOfficeWrite(
  tool: OfficeWriteTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecution> {
  let plan: OfficeWritePlan;
  try {
    plan = await planForOffice(tool, args, ctx);
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }

  // 文本视图逐字相同 = 文档内容没变。此时不落盘、不打扰用户：
  // 重复生成同一份文档（模型重试、或用户再点一次）不该产生一次写入与一次审批。
  const unchanged = plan.diff !== null && !plan.created && plan.diff.added === 0 && plan.diff.removed === 0;
  if (unchanged) return { ok: true, output: `${plan.rel} 的文档内容无变化，未写入` };

  const assessment = ctx.guard.assess(`${tool} ${plan.rel}`);
  if (assessment.blocked) return { ok: false, output: `写入被策略阻断：${assessment.reason}` };

  const risk = OFFICE_TOOL_RISK[tool];
  if (risk !== 'safe' && ctx.requestApproval) {
    const detail = `内容：${plan.summary}，${formatBytes(plan.bytes.length)}`;
    const note = plan.diff
      ? '；下方差异是文档的文本视图'
      : plan.beforeUnreadable
        ? '；旧文件无法解析，不展示差异'
        : '；无法生成内容视图';
    const outcome = await ctx.requestApproval({
      tool,
      subject: plan.rel,
      reason: `${assessment.reason}（${detail}${note}）`,
      diff: plan.diff ?? undefined,
    });
    if (!outcome.approved) return { ok: false, output: `用户拒绝了本次写入，${plan.rel} 未被修改` };
  }

  await fs.mkdir(path.dirname(plan.abs), { recursive: true });
  // 注意写的是预检时算好的字节（同一份快照）：审批里展示的内容与实际落盘的
  // 内容是同一批字节，不会出现「批准的是 A、写下去的是 B」
  await fs.writeFile(plan.abs, plan.bytes);

  const verb = plan.created ? '已新建' : '已更新';
  return { ok: true, output: `${verb} ${plan.rel}（${formatBytes(plan.bytes.length)}，${plan.summary}）` };
}

/**
 * 注册 Office 工具。
 *
 * 与浏览器工具不同，这里**没有** deps 开关：文档读写不需要进程级资源
 * （不像浏览器要拉一个真实进程），永远可用 —— 把可用的工具注册完是默认行为，
 * 只有「依赖外部条件才成立」的能力才需要条件注册。
 */
function registerOfficeTools(registry: ToolRegistry): void {
  registry.register({
    name: OFFICE_DOCX_TOOL,
    description: '在工作区生成 Word 文档（.docx）。正文用 Markdown 子集书写：标题/段落/有序与无序列表/引用/代码块/管道表格/分隔线',
    parameters: {
      path: 'string，相对工作区的路径（.docx 结尾；无扩展名会自动补上）',
      content: 'string，文档正文（Markdown 子集）',
      title: 'string，可选，文档标题（会成为首行的 Title 样式并写入文档属性）',
    },
    preview: async (args, ctx) => {
      try {
        return (await planForOffice(OFFICE_DOCX_TOOL, args, ctx)).diff;
      } catch {
        return null; // 预览失败不阻断：真正的问题会在执行阶段以同样的措辞报出
      }
    },
    handler: (args, ctx) => runOfficeWrite(OFFICE_DOCX_TOOL, args, ctx),
  });

  registry.register({
    name: OFFICE_XLSX_TOOL,
    description: '在工作区生成 Excel 工作簿（.xlsx）。数据传二维数组，或直接传一段 Markdown 管道表格',
    parameters: {
      path: 'string，相对工作区的路径（.xlsx 结尾；无扩展名会自动补上）',
      rows: '二维数组（数组的数组，单元格可为字符串/数字/布尔），或 Markdown 管道表格字符串',
      sheet: 'string，可选，工作表名（非法字符会被清洗，最长 31 字符）',
      header: 'boolean，可选，首行是否为表头（加粗并冻结首行），默认 true',
    },
    preview: async (args, ctx) => {
      try {
        return (await planForOffice(OFFICE_XLSX_TOOL, args, ctx)).diff;
      } catch {
        return null;
      }
    },
    handler: (args, ctx) => runOfficeWrite(OFFICE_XLSX_TOOL, args, ctx),
  });

  registry.register({
    name: OFFICE_READ_TOOL,
    description:
      `读取工作区内的文档并提取文本：原生解析 ${officeNativeExtensionList()}（OFD 为国标版式文档），` +
      '其余常见纯文本扩展名按文本读取',
    parameters: { path: 'string，文件相对路径' },
    handler: async (args, ctx): Promise<ToolExecution> => {
      try {
        const abs = resolveInWorkspace(requireString(args, 'path'), ctx);
        const outcome = await readOfficeDocument(abs, displayPath(abs, ctx));
        const body = outcome.text.trim() || '（文档里没有正文文本）';
        const { text, truncated } = truncate(`${outcome.path}（${outcome.summary}）\n${'─'.repeat(20)}\n${body}`);
        return { ok: true, output: text, truncated: truncated || outcome.truncated };
      } catch (error) {
        // 解析失败的原因必须原样给模型：「不支持的格式」与「文件损坏」是两种处置方式
        return { ok: false, output: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}

