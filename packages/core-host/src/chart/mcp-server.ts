import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {
  APP_NAME,
  CHART_EXTENSION,
  CHART_MCP_TOOL,
  chartInputJsonSchema,
  chartToolDescription,
} from '@deepwork/protocol';
import { isInsideWorkspace } from '../security/guard';
import { ensureExtension, requireString } from '../tools/args';
import { createLogger } from '../logger';
import { chartOutputText, planChart } from './plan';

const log = createLogger('chart:mcp');

/**
 * 图表能力的 MCP 服务（stdio 传输）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 宿主工具注册表（tools/builtin.ts）**只在 mock 适配器下被执行**。真实内核（dsh）
 * 有它自己的一套模型可见工具，我们在注册表里注册什么它都看不见 —— 只做注册表的话，
 * 「模型能画图」在开发期完全正常，切到真实内核就没了，而且没有任何报错。
 * 内核原生支持 MCP（M2-G 已验证），所以正统路径是把它做成 MCP 服务、
 * 由宿主写进内核 `--patch`。与浏览器能力完全同构（见 browser/mcp-server.ts）。
 *
 * ── 协议范围 ────────────────────────────────────────────────────────
 * 只实现与工具调用有关的最小集合：initialize / notifications.initialized /
 * tools/list / tools/call / ping。不声明没实现的能力 ——
 * 声明了却不响应，客户端会在它以为可用的路径上永久等待。
 *
 * ── 边界必须自己守 ──────────────────────────────────────────────────
 * 本进程是内核拉起的**独立进程**，不走宿主的工具通道，所以：
 *  1. 工作区边界由这里自己校验（`isInsideWorkspace`）—— 不能假设内核会替我们守；
 *  2. 审批由内核的 `session/request_permission` 负责（`mcp__` 前缀工具在宿主侧
 *     至少是 confirm 档）。**这里不重复弹审批**，也不假装自己弹过：
 *     两个进程各弹一次会让同一件事问两遍。
 *
 * ── stdout 纪律 ─────────────────────────────────────────────────────
 * stdio 传输下 stdout 只允许出现协议消息，一行一条 JSON。日志一律走 stderr。
 * 一句 console.log 就会让客户端 JSON 解析崩掉，而症状是「内核启动 MCP 服务失败」，
 * 与打印的那句话毫无关系。
 */

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'deepwork-chart';
const SERVER_VERSION = '0.1.0';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

/**
 * 工作区根目录。
 *
 * 由宿主写进补丁的 env（`DEEPWORK_WORKSPACE`）给出 —— 它与内核自己被启动时
 * 拿到的 workspace 是同一个值（host.ts 的 `this.workspace`），
 * 所以「内核能写到哪」与「图表写到哪」是同一个边界。
 * 缺省回落到进程 cwd，方便手工调试。
 */
function workspaceRoot(): string {
  const fromEnv = process.env.DEEPWORK_WORKSPACE;
  return path.resolve(fromEnv && fromEnv.trim() ? fromEnv : process.cwd());
}

/** 落盘：与宿主侧的写工具同一条纪律（边界 → 无变化短路 → 写 → 如实回执） */
async function renderChart(args: Record<string, unknown>): Promise<string> {
  const root = workspaceRoot();
  const abs = ensureExtension(
    path.resolve(root, requireString(args, 'path')),
    'chart.render',
    CHART_EXTENSION,
  );
  if (!isInsideWorkspace(abs, root)) {
    throw new Error(`路径越出工作区边界，已拒绝: ${abs}（工作区：${root}）`);
  }

  const plan = planChart(args);
  const rel = path.relative(root, abs).split(path.sep).join('/');

  let existing: Buffer | null = null;
  try {
    existing = await fs.readFile(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // 逐字节相同 = 图表没变。不落盘、不改 mtime，回执如实说「未写入」
  if (existing && existing.equals(plan.bytes)) {
    return `${rel} 的图表内容无变化，未写入（${plan.summary}）`;
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, plan.bytes);
  return chartOutputText(plan, existing ? '已更新' : '已新建', rel);
}

export function startChartMcpServer(): { stop: () => Promise<void> } {
  const tools = [
    {
      name: CHART_MCP_TOOL,
      description: `${chartToolDescription()}。需要在工作区内落一个 HTML 文件，调用前会请你确认`,
      inputSchema: chartInputJsonSchema(),
    },
  ];

  const rl = readline.createInterface({ input: process.stdin });
  const write = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: JsonRpcMessage['id'], result: unknown) => write({ jsonrpc: '2.0', id, result });
  const replyError = (id: JsonRpcMessage['id'], code: number, message: string) =>
    write({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (message: JsonRpcMessage): Promise<void> => {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
        reply(id, {
          protocolVersion: requested ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: APP_NAME },
        });
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        log.info('客户端已初始化');
        return;
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list':
        if (!isNotification) reply(id, { tools });
        return;
      case 'tools/call': {
        const call = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        const toolName = call?.name ?? '';
        if (toolName !== CHART_MCP_TOOL) {
          replyError(id, -32602, `未知工具: ${toolName}`);
          return;
        }
        try {
          const text = await renderChart(call?.arguments ?? {});
          reply(id, { content: [{ type: 'text', text }] });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn(`工具 ${toolName} 执行失败`, message);
          // 业务失败按规范走 isError 内容，而不是 JSON-RPC error：
          // 后者在多数客户端里被当成连接故障，模型连错误文本都看不到 ——
          // 而图表的失败绝大多数是「数据不合规」，模型看到原文就能自己改
          reply(id, { content: [{ type: 'text', text: `画图失败：${message}` }], isError: true });
        }
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, `未实现的方法: ${String(method)}`);
        log.warn(`收到未实现的方法：${String(method)}`);
    }
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      replyError(null, -32700, 'JSON 解析失败');
      return;
    }
    void handle(message);
  });

  const stop = async () => {
    rl.close();
  };

  rl.on('close', () => void stop().finally(() => process.exit(0)));
  process.on('SIGTERM', () => void stop().finally(() => process.exit(0)));
  process.on('SIGINT', () => void stop().finally(() => process.exit(0)));

  log.info(`图表 MCP 服务已就绪（工作区 ${workspaceRoot()}）`);
  return { stop };
}
