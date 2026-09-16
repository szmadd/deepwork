import type { FileDiff, SandboxEscalation } from '@deepwork/protocol';
import { createLogger } from '../logger';
import type { Guard } from '../security/guard';

const log = createLogger('tools');

export interface ApprovalInput {
  tool: string;
  subject: string;
  reason: string;
  /** 写文件的改动预览，会原样透传到审批弹窗 */
  diff?: FileDiff;
  /**
   * 该次授权是否支持逐 hunk 选择。
   *
   * 由工具自己判断，而不是让界面去猜：只有「存在差异、差异可拆成多个 hunk、
   * 且这次不是新建文件」时，部分授权才是有意义的。
   * 界面只管按这个开关渲染，规则不在两处各写一遍。
   */
  selectable?: boolean;
  /**
   * 模型在申请放宽沙箱档位时带上。
   *
   * 这一条与上面几项不同：它不描述「要做什么」，而描述「这次授权是哪种授权」。
   * 界面据此换说法 —— 用户要拍板的是「要不要为这一次调用放宽档位」，
   * 而不是「要不要执行这个操作」。
   */
  escalation?: SandboxEscalation;
}

/**
 * 授权结果。
 *
 * 从 boolean 升级为对象，是为了承载逐 hunk 选择；同时保留 `approved` 这个唯一主判据，
 * 让「允许与否」在任何调用点上都是一眼可读的。
 */
export interface ApprovalOutcome {
  approved: boolean;
  /** 逐 hunk 授权时被采纳的 hunk 下标；undefined 表示整体授权 */
  hunks?: number[];
}

export const ALLOW_ALL: ApprovalOutcome = { approved: true };
export const DENY_ALL: ApprovalOutcome = { approved: false };

export interface ToolContext {
  workspace: string;
  guard: Guard;
  signal?: AbortSignal;
  /** 需要用户确认时的回调，由适配层注入（走审批事件流） */
  requestApproval?: (input: ApprovalInput) => Promise<ApprovalOutcome>;
  /**
   * 单次工具执行期的缓存。
   *
   * 存在的理由：写类工具需要「先算差异、再执行」两趟。
   * 若两趟各自读取文件，不仅多一次 IO，更糟的是两趟之间文件可能被改动，
   * 导致**用户看到的差异**与**实际写下去的内容**不一致 —— 那是审批链路最不能接受的失效模式。
   * 因此预检结果必须在这里共享，两趟用同一份快照。
   */
  cache: Map<string, unknown>;
}

export function createToolContext(input: {
  workspace: string;
  guard: Guard;
  signal?: AbortSignal;
  requestApproval?: (input: ApprovalInput) => Promise<ApprovalOutcome>;
}): ToolContext {
  return { ...input, cache: new Map() };
}

export interface ToolExecution {
  ok: boolean;
  output: string;
  /** 输出是否被截断 */
  truncated?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** 参数 JSON Schema 的简化描述，供 UI 展示与模型提示词使用 */
  parameters: Record<string, string>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecution>;
  /**
   * 副作用预览钩子：在工具**真正执行之前**调用，产出「即将发生什么」。
   *
   * 只有会产生用户可见副作用的工具才需要实现（当前是写文件类）。
   * 它抛异常不阻断执行 —— 预览失败最多是「看不到差异」，
   * 而真正的问题（参数非法等）会由 handler 以同样的方式报出来，不必重复处理。
   */
  preview?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<FileDiff | null> | FileDiff | null;
}

const MAX_OUTPUT_BYTES = 60_000;

export function truncate(text: string, limit = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
  const buf = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8');
  return { text: `${buf}\n... [输出已截断，共 ${Buffer.byteLength(text, 'utf8')} 字节]`, truncated: true };
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * 生成副作用预览。返回 null 表示该工具无可见副作用，或预览不可用。
   * 返回值同时被写入 ctx.cache，供 handler 复用同一份快照。
   */
  async previewFor(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<FileDiff | null> {
    const tool = this.tools.get(name);
    if (!tool?.preview) return null;
    try {
      const diff = await tool.preview(args, ctx);
      if (diff) ctx.cache.set('preview.diff', diff);
      return diff ?? null;
    } catch (error) {
      log.warn(`工具 ${name} 预览失败`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecution> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `未知工具: ${name}` };
    }
    const startedAt = Date.now();
    try {
      const result = await tool.handler(args, ctx);
      log.debug(`工具 ${name} 完成`, { ms: Date.now() - startedAt, ok: result.ok });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`工具 ${name} 抛异常`, message);
      return { ok: false, output: `执行失败: ${message}` };
    }
  }
}
