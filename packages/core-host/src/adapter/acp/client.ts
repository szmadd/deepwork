import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from '../../logger';
import type {
  AcpInitializeParams,
  AcpInitializeResult,
} from './protocol';

const log = createLogger('acp');

/**
 * ACP over stdio 的客户端。
 *
 * 职责边界：只管传输（分帧、配对、路由），不做任何语义映射 ——
 * 语义映射住在 harness-sidecar.ts，内核换协议时只需换这一层。
 */

export interface AcpRequestHandlers {
  /**
   * 内核主动调用客户端（Agent → Client 请求）。
   * 返回 result；抛错则回 JSON-RPC error。
   */
  handleRequest(method: string, params: unknown): Promise<unknown>;
  /** 内核发出的通知（如 session/update）。 */
  handleNotification(method: string, params: unknown): void;
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** 单个请求超时，默认 30s。prompt 这类长轮次由调用方另给超时。 */
  requestTimeoutMs?: number;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AcpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpProtocolError';
  }
}

export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private stderrBuffer = '';

  constructor(
    private readonly options: AcpClientOptions,
    private readonly handlers: AcpRequestHandlers,
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    const { command, args, cwd, env } = this.options;
    log.info(`启动 ACP agent: ${command} ${args.join(' ')} (cwd=${cwd})`);
    this.child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // stdout 只走协议，stderr 才是诊断。两者绝不能混。
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdoutChunk(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => this.onStderrChunk(chunk));
    this.child.on('exit', (code) => {
      this.options.onExit?.(code);
      this.failAllPending(new AcpProtocolError(`agent 进程退出，code=${code}`));
    });
    this.child.on('error', (error) => {
      this.failAllPending(new AcpProtocolError(`agent 进程错误: ${error.message}`));
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.failAllPending(new AcpProtocolError('客户端已关闭'));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  /** 关闭 stdin 通常等价于「协议结束」，比 kill 更礼貌。 */
  closeStdin(): void {
    this.child?.stdin.end();
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.child) return Promise.reject(new AcpProtocolError('agent 未启动'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpProtocolError(`${method} 超时（${timeout}ms）`));
      }, timeout);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.child?.stdin.write(`${payload}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(params: AcpInitializeParams): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>('initialize', params);
  }

  // ── 传输层 ──────────────────────────────────────────────────────────────

  private onStdoutChunk(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) void this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private async handleLine(line: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // 协议流里出现非 JSON，是 agent 侧的严重问题 —— 但不能让宿主崩掉，
      // 记下来让排查的人看得见。
      log.warn(`协议流中出现非 JSON 行（已忽略）: ${line.slice(0, 200)}`);
      return;
    }

    const id = typeof message.id === 'number' ? message.id : null;
    const method = typeof message.method === 'string' ? message.method : null;

    // 响应：有 id、无 method
    if (id !== null && method === null) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = message.error as { message?: string; code?: number };
        pending.reject(
          new AcpProtocolError(`ACP 错误 ${error.code ?? ''}: ${error.message ?? '未知错误'}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // 通知：无 id、有 method
    if (id === null && method !== null) {
      try {
        this.handlers.handleNotification(method, message.params);
      } catch (error) {
        log.error(`处理通知 ${method} 出错`, String(error));
      }
      return;
    }

    // 反向请求：有 id、有 method
    if (id !== null && method !== null) {
      try {
        const result = await this.handlers.handleRequest(method, message.params);
        this.send({ jsonrpc: '2.0', id, result });
      } catch (error) {
        const message2 = error instanceof Error ? error.message : String(error);
        this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: message2 } });
      }
    }
  }

  private onStderrChunk(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf8');
    let index = this.stderrBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stderrBuffer.slice(0, index).trim();
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      if (line) {
        log.debug(`[agent stderr] ${line}`);
        this.options.onStderr?.(line);
      }
      index = this.stderrBuffer.indexOf('\n');
    }
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.child?.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      log.warn(`回送响应失败: ${String(error)}`);
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
