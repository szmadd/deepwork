import type {
  AgentEventInput,
  AgentMode,
  RunStatus,
} from '@deepwork/protocol';
import type { Guard } from '../security/guard';
import type { ApprovalInput, ApprovalOutcome, ToolRegistry } from '../tools/registry';

/**
 * 适配层契约。
 *
 * 这是全项目唯一允许接触内核（Harness）的地方。上层（core-host 的 RPC 处理器、
 * Electron、UI）只认 AgentEvent 与这几个接口，内核换版本时改动被约束在本目录内。
 */

export interface RunContext {
  runId: string;
  sessionId: string;
  /** 用户本轮输入 */
  text: string;
  /**
   * 附件绝对路径。
   *
   * 刻意用「路径」而非「内容」：附件可能是 200MB 的日志，把它读进内存再传进适配层，
   * 会让每一次 run 的启动开销由「本轮对话」变成「所有附件体积之和」。
   * 需要内容的适配器自己去读，读多少、读哪一段由它按任务决定。
   */
  attachments?: string[];
  workspace: string;
  mode: AgentMode;
  model: string;
  /**
   * 技能上下文注入文本（由宿主按「已启用技能 + /显式调用」构建）。
   * 适配器必须把它放在用户输入之前交给内核，且不得改写 —— 改写会让
   * 「skill.attached 记录里说的」与「内核实际看到的」对不上。
   * 无启用技能时为 null。
   */
  skillContext: string | null;
  /**
   * 记忆上下文注入文本（由宿主按三层记忆构建：画像 / 用户级 / 工作区）。
   * 适配器必须把它放在技能块之前、用户输入之前交给内核，且不得改写 ——
   * 改写会让「memory.attached 记录里说的」与「内核实际看到的」对不上。
   * 没有任何记忆内容时为 null。
   */
  memoryContext: string | null;
  guard: Guard;
  tools: ToolRegistry;
  /** 向上发射归一化事件（由 core-host 补充 seq/ts 并落盘） */
  emit: (event: AgentEventInput) => void;
  /**
   * 请求用户审批。适配层不得绕过此回调直接执行写操作。
   * @returns 是否放行；逐 hunk 授权时同时带回被采纳的 hunk 下标
   */
  requestApproval: (input: ApprovalInput) => Promise<ApprovalOutcome>;
  signal: AbortSignal;
}

export interface HealthReport {
  ok: boolean;
  detail: string;
  /** 内核侧进程是否存活 */
  processAlive?: boolean;
}

export interface HarnessAdapter {
  readonly kind: 'mock' | 'harness';
  readonly version: string;
  /** 内核自报的能力清单，UI 据此决定按钮可用性 */
  capabilities(): string[];
  start(): Promise<HealthReport>;
  stop(): Promise<void>;
  run(ctx: RunContext): Promise<RunStatus>;
  abort(runId: string): boolean;
  health(): Promise<HealthReport>;
}

export class AdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterUnavailableError';
  }
}

/** 中断检查工具：脚本式适配器在每一步之前调用 */
export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('run aborted');
    error.name = 'AbortError';
    throw error;
  }
}
