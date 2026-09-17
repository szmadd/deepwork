import path from 'node:path';
import readline from 'node:readline';
import {
  APP_NAME,
  MEMORY_MCP_READ_TOOL,
  MEMORY_MCP_SERVER_NAME,
  MEMORY_MCP_WRITE_TOOL,
  memoryReadInputJsonSchema,
  memoryReadToolDescription,
  memoryWriteInputJsonSchema,
  memoryWriteToolDescription,
} from '@deepwork/protocol';
import { createLogger } from '../logger';
import { homeDir } from '../paths';
import { MemoryStore } from './store';
import { runMemoryRead, runMemoryWrite } from './tools';

const log = createLogger('memory:mcp');

/**
 * 记忆能力的 MCP 服务（stdio 传输）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * M2-E 收口时三层记忆只覆盖了两条写入路径：UI 面板显式写入、宿主在 run 结束后
 * 追加当日日志。**内核在对话中自主沉淀记忆**依赖工具通道，当时未通（M2-G 才把
 * MCP 通道打通）。本服务就是把这条通道接上的那一节：内核按宿主写进 `--patch`
 * 的条目以 stdio 拉起本进程，模型从此能看到 memory_write / memory_read。
 *
 * ── 边界与审批 ──────────────────────────────────────────────────────
 *  1. 本进程是独立进程：它自己 new 一个 MemoryStore（走 DEEPWORK_HOME），
 *     直接读写磁盘上的记忆文件。这与宿主是**同一个事实来源**（都是那批文件），
 *     所以「模型写的」与「面板显示的」不会分叉 —— 面板每次打开都重新读盘。
 *  2. 工作区来自 `DEEPWORK_WORKSPACE`（宿主写进补丁的 env，与内核自己的边界同值）。
 *     缺了它，工作区层记忆会落到本进程的 cwd —— 那是另一回事。
 *  3. **这里不弹审批。** 记忆写入是「自主沉淀」这件事本身，每次弹窗就等于没有
 *     自主；而目标是可预期的：一层有硬字符预算、写入在面板里可见可删。
 *     审批链路的最终归属仍在内核（session/request_permission），本服务不重复实现。
 *
 * ── stdout 纪律 ─────────────────────────────────────────────────────
 * stdio 传输下 stdout 只允许出现协议消息，一行一条 JSON。日志一律走 stderr。
 */

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = MEMORY_MCP_SERVER_NAME;
const SERVER_VERSION = '0.1.0';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

/**
 * 工作区根目录，来自补丁 env。
 * 缺省回落到进程 cwd，方便手工调试 —— 但不该在真实链路里发生，届时工作区层
 * 记忆会写到别处，且不报错。
 */
function workspaceRoot(): string {
  const fromEnv = process.env.DEEPWORK_WORKSPACE;
  return path.resolve(fromEnv && fromEnv.trim() ? fromEnv : process.cwd());
}

export function startMemoryMcpServer(): { stop: () => Promise<void> } {
  // store 与宿主同源：都按 DEEPWORK_HOME 定位 <home>/memory
  const store = new MemoryStore(homeDir());
  const tools = [
    {
      name: MEMORY_MCP_WRITE_TOOL,
      description: memoryWriteToolDescription(),
      inputSchema: memoryWriteInputJsonSchema(),
    },
    {
      name: MEMORY_MCP_READ_TOOL,
      description: memoryReadToolDescription(),
      inputSchema: memoryReadInputJsonSchema(),
    },
  ];

  const rl = readline.createInterface({ input: process.stdin });
  const write = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: JsonRpcMessage['id'], result: unknown) => write({ jsonrpc: '2.0', id, result });
  const replyError = (id: JsonRpcMessage['id'], code: number, message: string) =>
    write({ jsonrpc: '2.0', id, error: { code, message } });

  const callTool = (name: string, args: Record<string, unknown>): string => {
    if (name === MEMORY_MCP_WRITE_TOOL) return runMemoryWrite(store, args, workspaceRoot());
    if (name === MEMORY_MCP_READ_TOOL) return runMemoryRead(store, args, workspaceRoot());
    throw new Error(`未知工具: ${name}`);
  };

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
        if (toolName !== MEMORY_MCP_WRITE_TOOL && toolName !== MEMORY_MCP_READ_TOOL) {
          replyError(id, -32602, `未知工具: ${toolName}`);
          return;
        }
        try {
          const text = callTool(toolName, call?.arguments ?? {});
          reply(id, { content: [{ type: 'text', text }] });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          log.warn(`工具 ${toolName} 执行失败`, text);
          // 业务失败按规范走 isError 内容，而不是 JSON-RPC error：后者在多数客户端
          // 里被当成连接故障，模型连错误文本都看不到 —— 而记忆写入的失败（预算超限、
          // layer 传错）恰恰是模型看到原文就能自己改的那一类
          reply(id, { content: [{ type: 'text', text: `记忆操作失败：${text}` }], isError: true });
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

  log.info(`记忆 MCP 服务已就绪（记忆目录 ${store.memoryDir()}，工作区 ${workspaceRoot()}）`);
  return { stop };
}
