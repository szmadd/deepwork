import readline from 'node:readline';
import {
  RPC_ERROR,
  type AgentEvent,
  type AgentMode,
  type ApprovalDecision,
  type ConnectorConfig,
  type GuardPolicy,
  type MemoryLayer,
  type RpcMethod,
  type RpcRequest,
  type ScheduleSpec,
} from '@deepwork/protocol';
import type { DeepworkHost } from '../host';
import { createLogger } from '../logger';

const log = createLogger('rpc');

/**
 * stdio JSON-RPC 服务。
 *
 * 协议：NDJSON —— 一行一个 JSON 消息。
 *   入站：RpcRequest
 *   出站：RpcResponse（有 id）或 RpcNotification（无 id，method='event' | 'terminal'）
 *
 * 纪律：stdout 只允许出现协议消息。日志一律走 stderr（见 logger.ts）。
 */

type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

type Outbound =
  | { jsonrpc: '2.0'; id: number; result: unknown }
  | { jsonrpc: '2.0'; id: number; error: { code: number; message: string; data?: unknown } }
  | { jsonrpc: '2.0'; method: 'event'; params: AgentEvent }
  | { jsonrpc: '2.0'; method: 'terminal'; params: unknown };

export function buildHandlers(host: DeepworkHost): Record<RpcMethod, Handler> {
  return {
    'host.status': () => host.status(),
    'config.get': () => host.getConfig(),
    'config.set': (p) => host.setConfig((p.patch ?? {}) as Parameters<DeepworkHost['setConfig']>[0]),
    'guard.get': () => host.getGuard(),
    'guard.set': (p) => host.setGuard((p.policy ?? {}) as Partial<GuardPolicy>),
    // 模型目录是异步的：权威来源是内核 session/new 真帧，取帧要真的问一次内核。
    // 返回 Promise 由调用方 await（RPC 派发本来就是异步的）。
    'models.list': () => host.modelCatalog(false),
    'models.refresh': () => host.modelCatalog(true),
    'models.testEndpoint': (p) =>
      host.testModelEndpoint({
        baseUrl: String(p.baseUrl ?? ''),
        apiKey: typeof p.apiKey === 'string' && p.apiKey.trim() ? p.apiKey : undefined,
      }),
    'model.apiKey.status': () => host.modelApiKeyStatus(),
    'model.apiKey.set': (p) => host.setModelApiKey(String(p.key ?? '')),
    'model.apiKey.clear': () => host.clearModelApiKey(),
    'session.list': () => host.listSessions(),
    'session.create': (p) =>
      host.createSession({
        workspace: String(p.workspace ?? process.cwd()),
        title: typeof p.title === 'string' ? p.title : undefined,
        mode: p.mode as AgentMode | undefined,
        model: typeof p.model === 'string' ? p.model : undefined,
      }),
    'session.rename': (p) => host.renameSession(String(p.sessionId), String(p.title)),
    'session.delete': (p) => host.deleteSession(String(p.sessionId)),
    'session.events': (p) => host.sessionEvents(String(p.sessionId)),
    'session.fork': (p) =>
      host.forkSession(String(p.sessionId), typeof p.atSeq === 'number' ? p.atSeq : undefined),
    'run.send': (p) =>
      host.send({
        sessionId: String(p.sessionId),
        text: String(p.text ?? ''),
        mode: p.mode as AgentMode | undefined,
        model: typeof p.model === 'string' ? p.model : undefined,
        attachments: Array.isArray(p.attachments) ? (p.attachments as string[]) : undefined,
      }),
    'run.abort': (p) => host.abort(String(p.runId)),

    'fs.tree': (p) =>
      host.workspaceTree(
        String(p.sessionId),
        typeof p.path === 'string' && p.path ? p.path : undefined,
        typeof p.depth === 'number' ? p.depth : undefined,
      ),
    'fs.preview': (p) => host.previewFile(String(p.sessionId), String(p.path)),

    'terminal.open': (p) => host.openTerminal(String(p.sessionId)),
    'terminal.run': (p) => host.runTerminal(String(p.sessionId), String(p.command)),
    'terminal.write': (p) => host.writeTerminal(String(p.sessionId), String(p.data ?? '')),
    'terminal.interrupt': (p) => host.interruptTerminal(String(p.sessionId)),
    'terminal.close': (p) => host.closeTerminal(String(p.sessionId)),

    'approval.respond': (p) =>
      host.respondApproval(
        String(p.requestId),
        p.decision as ApprovalDecision,
        p.persist === true,
        Array.isArray(p.hunks) ? (p.hunks as number[]) : undefined,
      ),

    'skills.list': () => host.listSkills(),
    'skills.install': (p) => host.installSkill(String(p.source ?? '')),
    'skills.uninstall': (p) => host.uninstallSkill(String(p.name ?? '')),
    'skills.audit': (p) => host.auditSkill(String(p.source ?? '')),
    'skills.toggle': (p) =>
      host.toggleSkill(String(p.name ?? ''), p.enabled === true),

    'memory.list': (p) =>
      host.listMemories(
        typeof p.layer === 'string' ? (p.layer as MemoryLayer) : undefined,
        typeof p.workspace === 'string' ? p.workspace : undefined,
      ),
    'memory.add': (p) =>
      host.addMemory(
        p.layer as MemoryLayer,
        String(p.text ?? ''),
        typeof p.workspace === 'string' ? p.workspace : undefined,
      ),
    'memory.remove': (p) => host.removeMemory(String(p.id ?? '')),
    'memory.stats': (p) =>
      host.memoryStats(typeof p.workspace === 'string' ? p.workspace : undefined),
    'memory.setProfile': (p) => host.setMemoryProfile(String(p.text ?? '')),

    'schedule.list': () => host.listSchedules(),
    'schedule.add': (p) =>
      host.addSchedule({
        title: String(p.title ?? ''),
        prompt: String(p.prompt ?? ''),
        workspace: String(p.workspace ?? ''),
        spec: p.spec as ScheduleSpec,
      }),
    'schedule.remove': (p) => host.removeSchedule(String(p.id ?? '')),
    'schedule.toggle': (p) => host.toggleSchedule(String(p.id ?? ''), p.enabled === true),
    'schedule.runNow': (p) => host.runScheduleNow(String(p.id ?? '')),

    'connectors.list': () => host.listConnectors(),
    'connectors.add': (p) => host.addConnector(p.config as ConnectorConfig),
    'connectors.remove': (p) => host.removeConnector(String(p.name ?? '')),
    'connectors.toggle': (p) => host.toggleConnector(String(p.name ?? ''), p.enabled === true),

    'kernel.restart': () => host.restartKernel(),

    'browser.state': () => host.browserState(),
    'browser.open': (p) => host.browserOpen(String(p.url ?? '')),
    'browser.close': () => host.browserClose(),

    'usage.summary': () => host.usageSummary(),

    // 部署与运行时（§8）：体检与 Python 来源。两者都是只读查询，
    // 不改任何状态 —— 与 fs.* 同一类，界面可以放心在加载时调用。
    'runtime.preflight': (p) =>
      host.preflight(typeof p.writeDir === 'string' && p.writeDir ? p.writeDir : undefined),
    'runtime.python': () => host.pythonRuntime(),
  };
}

/**
 * 启动 stdio 服务。
 *
 * @param gate 宿主就绪的信号。通道会**先于**宿主启动建立（否则启动期发出的
 *             host.ready 会丢失），但请求要等 gate resolve 之后才处理 ——
 *             不然客户端可能在内核还没初始化完时就把调用打进来。
 *             缺省表示宿主已就绪。
 */
export function startStdioServer(host: DeepworkHost, gate?: Promise<unknown>): void {
  const handlers = buildHandlers(host);

  const send = (message: Outbound) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  host.onEvent((event) => send({ jsonrpc: '2.0', method: 'event', params: event }));
  host.onTerminal((chunk) => send({ jsonrpc: '2.0', method: 'terminal', params: chunk }));

  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: RpcRequest;
    try {
      request = JSON.parse(trimmed) as RpcRequest;
    } catch {
      send({ jsonrpc: '2.0', id: 0, error: { code: RPC_ERROR.PARSE, message: 'JSON 解析失败' } });
      return;
    }

    const handler = handlers[request.method];
    if (!handler) {
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: `未知方法: ${request.method}` },
      });
      return;
    }

    void (async () => {
      if (gate) await gate;
      try {
        const result = await handler((request.params ?? {}) as Record<string, unknown>);
        send({ jsonrpc: '2.0', id: request.id, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`方法 ${request.method} 执行失败`, message);
        send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: RPC_ERROR.INTERNAL, message },
        });
      }
    })();
  });

  const shutdown = () => {
    log.info('收到关闭信号，正在停止内核');
    void host.stop().finally(() => process.exit(0));
  };

  rl.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  log.info('stdio JSON-RPC 服务已就绪');
}
