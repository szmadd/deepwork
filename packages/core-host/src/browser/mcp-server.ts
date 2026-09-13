import readline from 'node:readline';
import {
  APP_NAME,
  BROWSER_ACTIONS,
  BROWSER_CONTENT_LIMIT,
  BROWSER_TOOL_RISK,
  browserMcpToolName,
  type BrowserAction,
} from '@deepwork/protocol';
import { BrowserManager } from './manager';
import { BROWSER_ACTION_LABEL } from './actions';
import { createLogger } from '../logger';

const log = createLogger('browser:mcp');

/**
 * 浏览器能力的 MCP 服务（stdio 传输）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 宿主工具注册表（tools/builtin.ts）只在 mock 适配器下被执行：真实内核
 * （dsh）有它自己的一套模型可见工具，我们注册什么它都看不见。若只做注册表，
 * 「6 个浏览器工具」就是 mock 专属的摆设 —— 界面上有、模型永远调不到，
 * 而这一点在开发时几乎不会暴露（mock 下全都正常）。
 *
 * 内核原生支持 MCP（`dsh-mcp-client`，M2-G 已验证），所以正统路径是把浏览器
 * 能力做成一个 MCP 服务，由宿主写进内核的 `--patch`，内核自己把工具注册给模型。
 * 于是模型侧的名字是 `mcp__browser__browser_navigate` 这类，审批照旧走
 * 既有的 request_permission 链路。
 *
 * ── 协议范围 ────────────────────────────────────────────────────────
 * 只实现 MCP 里与工具调用有关的最小集合：initialize / notifications.initialized /
 * tools/list / tools/call / ping。响应里如实公布 capabilities.tools，
 * 不声明我们没实现的（resources / prompts / logging）—— 声明了却不响应，
 * 客户端会在某个它以为可用的路径上永久等待。
 *
 * ── 与宿主的协作 ────────────────────────────────────────────────────
 * 本进程与宿主是两个独立进程，共用同一个 BrowserManager 逻辑（import 同一份
 * manager.ts），靠 endpoint 文件协调出「只有一个浏览器实例」：谁先醒谁拉起，
 * 后来者复用。所以面板里看到的页面就是模型正在操作的页面。
 *
 * ── stdout 纪律 ─────────────────────────────────────────────────────
 * stdio 传输下 stdout 只允许出现协议消息，一行一条 JSON。日志一律走 stderr
 * （见 logger.ts）—— 一句 console.log 就会让客户端的 JSON 解析崩掉，
 * 而症状是「内核启动 MCP 服务失败」，与打印的那句话毫无关系。
 */

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'deepwork-browser';
const SERVER_VERSION = '0.1.0';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

/** 每个工具的入参 schema（JSON Schema 最小子集）与说明 */
interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function toolSpecs(): McpToolSpec[] {
  const riskNote = (action: BrowserAction) =>
    BROWSER_TOOL_RISK[action] === 'danger' ? '（高风险动作，需人工确认）' : '（需人工确认）';

  return [
    {
      name: browserMcpToolName('navigate'),
      description: `在受管浏览器里打开一个网址并等待页面加载。${riskNote('navigate')}`,
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http/https/file/data 协议的完整 URL' } },
        required: ['url'],
      },
    },
    {
      name: browserMcpToolName('content'),
      description: `读取当前页面的可读文本（最多 ${BROWSER_CONTENT_LIMIT} 字符，超出会标注截断）。${riskNote('content')}`,
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string', description: '可选：只读某个 CSS 选择器命中的元素' } },
      },
    },
    {
      name: browserMcpToolName('click'),
      description: `点击页面上某个 CSS 选择器命中的元素。${riskNote('click')}`,
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS 选择器' } },
        required: ['selector'],
      },
    },
    {
      name: browserMcpToolName('type'),
      description: `向输入框输入文本（走原生 setter，React 等受控组件同样生效）。${riskNote('type')}`,
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器' },
          text: { type: 'string', description: '要输入的文本' },
          submit: { type: 'boolean', description: '是否随后提交所在表单，默认 false' },
        },
        required: ['selector', 'text'],
      },
    },
    {
      name: browserMcpToolName('evaluate'),
      description: `在页面上下文执行一段 JavaScript 并返回结果。${riskNote('evaluate')}`,
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string', description: '要执行的表达式或语句' } },
        required: ['expression'],
      },
    },
    {
      name: browserMcpToolName('screenshot'),
      description: `对当前页面截图，返回落盘路径（PNG 字节不进对话）。${riskNote('screenshot')}`,
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '可选文件名（会做字符清洗），默认按时间戳' } },
      },
    },
  ];
}

/** 动作名反查：MCP 工具名 → 契约里的动作 */
function actionOfTool(name: string): BrowserAction | null {
  for (const action of BROWSER_ACTIONS) {
    if (browserMcpToolName(action) === name) return action;
  }
  return null;
}

/**
 * 启动 MCP stdio 服务。
 *
 * 返回一个 stop 句柄，供测试收尾（测试要能干净地关掉浏览器与读线）。
 */
export function startBrowserMcpServer(): { stop: () => Promise<void>; manager: BrowserManager } {
  const manager = new BrowserManager();
  const tools = toolSpecs();
  const rl = readline.createInterface({ input: process.stdin });

  const write = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const reply = (id: JsonRpcMessage['id'], result: unknown) => {
    write({ jsonrpc: '2.0', id, result });
  };

  const replyError = (id: JsonRpcMessage['id'], code: number, message: string) => {
    write({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const handle = async (message: JsonRpcMessage): Promise<void> => {
    const { id, method, params } = message;
    // 通知（无 id）只处理 initialized，其余忽略；规范明确通知不得有响应
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
        reply(id, {
          // 回显客户端的版本：我们只用到 tools 子集，各版本间这部分形状稳定，
          // 硬推自己的最新版反而会让只认旧版的客户端直接断开
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
        const action = actionOfTool(toolName);
        if (!action) {
          // 未知工具是协议层错误（客户端问了一个不存在的名字），不是工具业务失败
          replyError(id, -32602, `未知工具: ${toolName}`);
          return;
        }
        try {
          const outcome = await manager.run(action, (call?.arguments ?? {}) as Record<string, unknown>);
          reply(id, {
            content: [{ type: 'text', text: outcome.text }],
            // 截图路径单独回一份结构化内容，客户端不必去解析那句中文
            ...(outcome.shotPath
              ? { structuredContent: { path: outcome.shotPath, url: outcome.url, title: outcome.title } }
              : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn(`工具 ${toolName} 执行失败`, message);
          // 工具的业务失败按规范走 isError 内容，而不是 JSON-RPC error：
          // 后者在多数客户端里会被当成连接故障，模型连错误文本都看不到
          reply(id, {
            content: [{ type: 'text', text: `${BROWSER_ACTION_LABEL[action]}失败：${message}` }],
            isError: true,
          });
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
      // 解析失败时无法得知 id，按规范用 null id 报错
      replyError(null, -32700, 'JSON 解析失败');
      return;
    }
    void handle(message);
  });

  const stop = async () => {
    rl.close();
    // MCP 服务的收尾与宿主停止同一条纪律：按 endpoint 文件收掉浏览器进程树。
    // 只关连接不杀进程的话，内核退出后会留下一个没人认领的 Chromium。
    await manager.shutdown();
  };

  rl.on('close', () => {
    void stop().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => void stop().finally(() => process.exit(0)));
  process.on('SIGINT', () => void stop().finally(() => process.exit(0)));

  log.info(`浏览器 MCP 服务已就绪（工具 ${tools.length} 个）`);
  return { stop, manager };
}
