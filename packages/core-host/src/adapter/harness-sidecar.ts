import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentEventInput, RunStatus } from '@deepwork/protocol';
import { createLogger } from '../logger';
import { applySelectedHunks, buildFileDiff } from '../diff';
import { AdapterUnavailableError, type HarnessAdapter, type HealthReport, type RunContext } from './types';
import { AcpClient } from './acp/client';
import {
  ACP_PROTOCOL_VERSION,
  textOfContent,
  type AcpConfigOption,
  type AcpConfigOptionValue,
  type AcpContentBlock,
  type AcpNewSessionResult,
  type AcpPermissionKind,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpSessionUpdate,
  type AcpToolKind,
  type AcpWrappedContent,
} from './acp/protocol';

const log = createLogger('adapter:harness');

/**
 * 真实内核适配器：把 DeepSeek Harness 作为独立子进程拉起来，用 ACP over stdio 通信。
 *
 * ── 契约已校准（2026-09-12，两轮）───────────────────────────────────────
 *  内核侧：DeepSeek Harness（dsh）0.1.5-rc.1，`dsh --profile acp` 提供的 ACP profile。
 *  协议侧：Agent Client Protocol —— JSON-RPC 2.0 over stdio，规格见
 *          https://agentclientprotocol.com/protocol
 *
 *  第一轮校准靠文档（规格站 + dsh 官方 bundle 自述 + `dsh --dump-config`），
 *  结论是「ACP over stdio，stdout 只走协议」——正确。
 *  第二轮用真实进程实测（`node tools/real-dsh-probe.js`），纠正了五处只有真跑才
 *  暴露的差异（prompt 键名、能力键名、权限参数位置、工具输出嵌套、kind 恒为 other），
 *  全部记录在 protocol.ts 与各处调用点上。**此后以实测为准。**
 *
 * ── 为什么选 ACP 而不是 headless ────────────────────────────────────────
 *  headless 只适合「跑一个任务、打印结果、退出」的批处理。本工作台需要
 *  会话创建、流式事件、中断、以及**程序化回答权限请求**。
 *
 * ── 审批网关的真实接入点（重要，与第一轮结论不同）─────────────────────
 *  第一轮以为「ACP 把 fs/write_text_file 交给客户端执行，所以内核写入天然过审批」。
 *  实测不成立：dsh 的 ACP profile **明确不支持客户端文件系统操作**
 *  （其 README 把「客户端文件系统操作」列入不支持界面，代码里也没有 fs/* 方法）。
 *  内核用的是自己的工具（`write` / `edit` / `pwsh` …），直接落盘。
 *
 *  因此真正的闸门是 **`session/request_permission`**：内核在写类工具落盘前
 *  必然向客户端申请权限（approval 策略默认 `ask`），客户端回 `reject-once`
 *  内核就不会写。**fs/* 仍然实现**（它们是规格方法，别的内核可能用），
 *  但在 dsh 下它们不是主路径，绝不能当成唯一的审批依据。
 *
 * ── 本项目的硬约束仍全部成立 ────────────────────────────────────────────
 *  1. 绝不在 Electron 主进程内运行 Harness（其要求 Node ^22.19 || >=24）；
 *  2. 内核事件必须经 mapUpdateToEvent 归一化，禁止把原生结构透传给 UI；
 *  3. 写操作必须过审批网关 —— 在 dsh 下体现为权限请求的批准/拒绝。
 */

export interface HarnessSidecarOptions {
  command?: string;
  args?: string[];
  workspace: string;
  model: string;
  /** initialize / session/new 的超时 */
  startupTimeoutMs?: number;
  /** 透传给内核子进程的环境变量。完整替换 process.env 在客户端侧的危险键。 */
  env?: Record<string, string | undefined>;
  /**
   * 运行时补丁文件（~/.deepwork/runtime/kernel.patch.yml）。
   * 由宿主按当前启用清单生成；存在即追加 `--patch <path>` 启动参数，
   * 让 dsh 的 dsh-mcp-client 插件在启动时拉起外部 MCP server。
   */
  patchFile?: string;
}

/** 默认启动命令。设置 DEEPWORK_HARNESS_CMD 可整体替换（例如指向源码构建的 dsh）。 */
function resolveCommand(): string {
  const configured = process.env.DEEPWORK_HARNESS_CMD ?? 'dsh';
  if (process.platform !== 'win32') return configured;
  // Windows 下 npm 安装的 CLI 实际是 dsh.cmd，直接 spawn('dsh') 会 ENOENT ——
  // 而 ENOENT 在这里的表现只是「内核起不来」，看不出是扩展名的问题。
  if (/[\\/]/.test(configured) || /\.(exe|cmd|bat)$/i.test(configured)) return configured;
  return `${configured}.cmd`;
}

function resolveArgs(command: string): string[] {
  const raw = process.env.DEEPWORK_HARNESS_ARGS;
  if (raw) return raw.split(/\s+/).filter(Boolean);
  // npx 走的是包名；直接可执行的 dsh 不需要前导参数
  return command === 'npx' ? ['-y', '@deepseek-ai/dsh', '--profile', 'acp'] : ['--profile', 'acp'];
}

export class HarnessSidecarAdapter implements HarnessAdapter {
  readonly kind = 'harness' as const;
  readonly version = 'acp (版本由内核 initialize 自报)';

  private client: AcpClient | null = null;
  private agentInfo = '';
  private protocolVersion = 0;
  private caps: string[] = [];
  /** 会话映射：本项目 sessionId → ACP sessionId */
  private sessions = new Map<string, string>();
  /** 当前轮次的上下文，供反向请求（权限/写文件）使用 */
  private activeRun: RunContext | null = null;
  /** 已见过的 tool_call：权限请求只带 id，要靠它还原「是哪个工具、要动什么」 */
  private toolCalls = new Map<string, { name: string; title: string; subject: string }>();
  /** 累积的助手文本，轮次结束时发 message.completed */
  private assistantText = '';
  private abortedRuns = new Set<string>();

  constructor(private readonly options: HarnessSidecarOptions) {}

  capabilities(): string[] {
    return this.caps;
  }

  async start(): Promise<HealthReport> {
    const command = this.options.command ?? resolveCommand();
    const args = [...(this.options.args ?? resolveArgs(command))];
    // 连接器补丁：插件只在启动时加载，所以它是启动参数而不是运行期指令
    if (this.options.patchFile) args.push('--patch', this.options.patchFile);

    this.client = new AcpClient(
      {
        command,
        args,
        cwd: this.options.workspace,
        env: this.options.env,
        requestTimeoutMs: this.options.startupTimeoutMs ?? 20_000,
      },
      {
        handleNotification: (method, params) => this.onNotification(method, params),
        handleRequest: (method, params) => this.onAgentRequest(method, params),
      },
    );

    let exited = false;
    try {
      this.client.start();
      // ACP 下没有「握手 JSON」这个环节，就绪与否由 initialize 的应答判定。
      const result = await this.client.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          // 规格里的键名是 `fs`。写成 fileSystem 不会被拒绝，只会静默失效 ——
          // 这种「不报错但也没生效」的错只能靠实测发现。
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
        clientInfo: { name: 'deepwork', version: '0.1.0' },
      });
      this.protocolVersion = result.protocolVersion ?? 0;
      this.agentInfo = result.agentInfo?.name ? `${result.agentInfo.name} ${result.agentInfo.version ?? ''}`.trim() : '';
      if (this.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new AdapterUnavailableError(
          `内核协议版本不匹配：我方 ${ACP_PROTOCOL_VERSION}，内核 ${this.protocolVersion}。`,
        );
      }
      this.caps = Object.keys(result.agentCapabilities ?? {});
      log.info(`ACP 握手成功：agent=${this.agentInfo || '(未自报)'} 能力=[${this.caps.join(',')}]`);
    } catch (error) {
      exited = true;
      await this.client.stop().catch(() => undefined);
      this.client = null;
      throw new AdapterUnavailableError(
        `无法通过 ACP 接入内核：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (exited) throw new AdapterUnavailableError('内核未就绪');

    return { ok: true, detail: `acp ok${this.agentInfo ? ` (${this.agentInfo})` : ''}`, processAlive: true };
  }

  async stop(): Promise<void> {
    // 先礼貌关闭每个会话（内核会 drain 更新、flush 持久化），再关进程。
    // 直接 kill 也能退出，但会留下「日志没落完」的会话，恢复时少一截。
    for (const acpSessionId of this.sessions.values()) {
      try {
        await this.client?.request('session/close', { sessionId: acpSessionId }, 5_000);
      } catch (error) {
        log.warn(`关闭内核会话失败（忽略）: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.client?.stop();
    this.client = null;
    this.sessions.clear();
  }

  abort(runId: string): boolean {
    this.abortedRuns.add(runId);
    const sessionId = [...this.sessions.values()][0];
    if (!this.client || !sessionId) return false;
    // cancel 是通知，不期待应答
    this.client.notify('session/cancel', { sessionId });
    return true;
  }

  async health(): Promise<HealthReport> {
    if (!this.client) return { ok: false, detail: '内核未启动', processAlive: false };
    return { ok: this.protocolVersion > 0, detail: 'ok', processAlive: true };
  }

  async run(ctx: RunContext): Promise<RunStatus> {
    if (!this.client) {
      ctx.emit({ type: 'run.failed', runId: ctx.runId, message: '内核未就绪，无法执行', retryable: true });
      return 'failed';
    }

    const startedAt = Date.now();
    this.activeRun = ctx;
    this.assistantText = '';
    this.toolCalls.clear();

    ctx.emit({
      type: 'run.started',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      mode: ctx.mode,
      model: ctx.model,
    });

    try {
      const acpSessionId = await this.ensureSession(ctx);

      // 实测：参数键是 `prompt` 且必须是数组。写 `content` 会被内核以
      // -32602「prompt: expected array, received undefined」明确拒绝。
      const prompt: AcpContentBlock[] = [];
      // 记忆上下文最先：内核先看到「用户是谁、偏好什么」，再看「这台机器上有什么技能」，
      // 最后才是任务本身。两块都与用户输入分开，内核能区分「宿主注入的」与「用户说的」。
      if (ctx.memoryContext) prompt.push({ type: 'text', text: ctx.memoryContext });
      // 技能上下文作为独立文本块放在用户输入之前：内核先看到「这台机器上有什么技能」，
      // 再看到任务本身。与用户输入混成一段会让内核难以区分「用户说的」与「宿主注入的」。
      if (ctx.skillContext) prompt.push({ type: 'text', text: ctx.skillContext });
      prompt.push({ type: 'text', text: ctx.text });
      for (const attachment of ctx.attachments ?? []) {
        // 资源链接要求绝对 file:// 路径，由内核自己决定读多少。
        prompt.push({ type: 'resource_link', uri: `file:///${attachment.replace(/\\/g, '/')}` });
      }

      const result = await this.client.request<AcpPromptResult>(
        'session/prompt',
        { sessionId: acpSessionId, prompt },
        // 一轮任务没有天然上限，给一个宽松但存在的超时，避免永久挂起
        30 * 60_000,
      );

      const status = this.stopReasonToStatus(result?.stopReason, ctx);

      if (this.assistantText) {
        ctx.emit({ type: 'message.completed', runId: ctx.runId, text: this.assistantText });
      }
      ctx.emit({
        type: 'run.completed',
        runId: ctx.runId,
        status,
        durationMs: Date.now() - startedAt,
      });
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('内核运行失败', message);
      ctx.emit({ type: 'run.failed', runId: ctx.runId, message, retryable: true });
      return 'failed';
    } finally {
      this.activeRun = null;
      this.abortedRuns.delete(ctx.runId);
    }
  }

  // ── 会话 ────────────────────────────────────────────────────────────────

  private async ensureSession(ctx: RunContext): Promise<string> {
    const cached = this.sessions.get(ctx.sessionId);
    if (cached) return cached;
    // cwd 必须是绝对路径：规格要求，且内核的 sandbox 也以它为工作区根 ——
    // 传相对路径的话，「越界写入」的边界会跟着错位。
    const result = await this.client!.request<AcpNewSessionResult>('session/new', {
      cwd: path.resolve(ctx.workspace),
      mcpServers: [],
    });
    if (!result?.sessionId) throw new AdapterUnavailableError('内核未返回 sessionId');
    this.sessions.set(ctx.sessionId, result.sessionId);
    await this.applyModel(ctx, result.sessionId, result.configOptions);
    return result.sessionId;
  }

  /**
   * 把本项目选定的模型告诉内核。
   *
   * 会话创建时内核公布可选模型，实测值是 JSON 字符串数组（provider + model）。
   * 匹配不上就**保持内核默认并记日志**，不让它变成一次失败 —— 模型名对不上
   * 只影响用哪个模型，不该让任务跑不起来。
   */
  private async applyModel(ctx: RunContext, acpSessionId: string, configOptions?: AcpConfigOption[]): Promise<void> {
    const option = configOptions?.find((item) => item.id === 'model');
    if (!ctx.model || !option) return;

    const candidates: AcpConfigOptionValue[] = [];
    for (const entry of option.options ?? []) {
      const group = entry as { options?: AcpConfigOptionValue[] };
      if (Array.isArray(group.options)) candidates.push(...group.options);
      else candidates.push(entry as AcpConfigOptionValue);
    }
    const hit = candidates.find(
      (item) => item.value === ctx.model || item.name === ctx.model || item.value.includes(`"${ctx.model}"`),
    );
    if (!hit) {
      log.warn(`内核未提供模型 ${ctx.model}，保持内核默认`);
      return;
    }
    try {
      await this.client!.request(
        'session/set_config_option',
        { sessionId: acpSessionId, configId: 'model', value: hit.value },
        10_000,
      );
      log.info(`内核模型已设为 ${hit.name ?? hit.value}`);
    } catch (error) {
      log.warn(`设置内核模型失败（保持默认）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 通知与反向请求 ──────────────────────────────────────────────────────

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const ctx = this.activeRun;
    if (!ctx) return;
    const body = params as { update?: AcpSessionUpdate };
    if (!body?.update) return;
    const event = mapUpdateToEvent(body.update, ctx.runId);
    if (!event) return;

    if (event.type === 'message.delta') this.assistantText += event.text ?? '';
    if (event.type === 'tool.started' && event.call) {
      const rawInput = (body.update as { rawInput?: Record<string, unknown> }).rawInput;
      this.toolCalls.set(event.call.id, {
        name: event.call.name,
        title: event.call.summary ?? '',
        // 权限请求里只有工具 id，没有入参。把路径留在这里，审批弹窗才有东西可看 ——
        // 否则用户面对的是「允许 unknown 吗」，等于盲批。
        subject: subjectOfInput(rawInput),
      });
    }
    ctx.emit(event);
  }

  private async onAgentRequest(method: string, params: unknown): Promise<unknown> {
    const ctx = this.activeRun;
    if (!ctx) throw new Error('当前没有进行中的轮次');

    switch (method) {
      case 'session/request_permission':
        return this.handlePermission(params as AcpRequestPermissionParams);
      case 'fs/read_text_file':
        return this.handleReadFile(ctx, params as { path: string });
      case 'fs/write_text_file':
        return this.handleWriteFile(ctx, params as { path: string; content: string });
      default:
        // 未实现的能力要明确拒绝，而不是回一个空 result 让内核以为成功了
        throw new Error(`客户端未实现内核请求的方法: ${method}`);
    }
  }

  private async handlePermission(params: AcpRequestPermissionParams): Promise<unknown> {
    const ctx = this.activeRun!;
    const options = params.options ?? [];
    // 实测：工具 id 在 params.toolCall.toolCallId，顶层没有。
    const callId = params.toolCall?.toolCallId ?? params.toolCallId ?? '';
    const known = callId ? this.toolCalls.get(callId) : undefined;

    const outcome = await ctx.requestApproval({
      tool: known?.name ?? 'unknown',
      subject: known?.subject || known?.title || '内核请求权限',
      reason: '内核在执行该操作前请求授权',
    });

    // 选项 id 的键名也不统一：规格写 `id`，dsh 实测给的是 `optionId`。两个都认。
    const idOf = (option: (typeof options)[number]) => option.optionId ?? option.id ?? '';
    if (!outcome.approved) {
      const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
      return { outcome: { outcome: 'selected', optionId: idOf(reject ?? options[0] ?? {}) } };
    }
    const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always');
    return { outcome: { outcome: 'selected', optionId: idOf(allow ?? options[0] ?? {}) } };
  }

  private async handleReadFile(ctx: RunContext, params: { path: string }): Promise<unknown> {
    const target = this.assertInsideWorkspace(ctx, params.path);
    const content = await fs.readFile(target, 'utf8');
    return { content };
  }

  /**
   * 内核要写文件：这是全链路唯一允许落盘的地方，必须过审批网关。
   *
   * 流程刻意与本地写工具保持一致：读原文 → 构造差异 → 无变化短路 →
   * 带差异审批（多 hunk 时允许逐块取舍）→ 按采纳结果落盘。
   * 不这样做的话，内核就走了一条绕过 diff 审阅的旁路 —— 审批形同虚设。
   */
  private async handleWriteFile(ctx: RunContext, params: { path: string; content: string }): Promise<unknown> {
    const target = this.assertInsideWorkspace(ctx, params.path);
    const relative = path.relative(ctx.workspace, target).split(path.sep).join('/');

    let oldText: string | null = null;
    try {
      oldText = await fs.readFile(target, 'utf8');
    } catch {
      oldText = null;
    }

    const newText = params.content;
    if (oldText === newText) return {}; // 无变化短路：不该为一次空改动打扰用户

    const diff = buildFileDiff({ path: relative, oldText, newText });
    const selectable = diff.hunks.length > 1 && !diff.created && !diff.truncated;

    const outcome = await ctx.requestApproval({
      tool: 'fs.write',
      subject: relative,
      reason: oldText === null ? '内核要新建文件' : '内核要修改文件',
      diff,
      selectable,
    });

    if (!outcome.approved) throw new Error(`用户拒绝了写入 ${relative}`);

    // 逐块授权：只落盘被采纳的部分
    const finalText = applySelectedHunks(oldText ?? '', diff, outcome.hunks);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, finalText, 'utf8');
    return {};
  }

  private assertInsideWorkspace(ctx: RunContext, target: string): string {
    const resolved = path.resolve(target);
    const root = path.resolve(ctx.workspace);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`路径越界，不在工作区内: ${target}`);
    }
    return resolved;
  }

  private stopReasonToStatus(reason: string | undefined, ctx: RunContext): RunStatus {
    if (ctx.signal.aborted || this.abortedRuns.has(ctx.runId)) return 'aborted';
    switch (reason) {
      case 'cancelled':
        return 'aborted';
      case 'refusal':
        return 'failed';
      default:
        return 'completed';
    }
  }
}

/**
 * ACP session/update → 归一化事件。
 *
 * 判别字段在规格与各家 SDK 里并不统一（见过 sessionUpdate / kind / type 三种写法），
 * 在锁定到确定版本前这里兼容读取 —— 猜一个而猜错，代价是整条事件流静默变空，
 * 表现为「任务在跑但界面什么都不显示」，极难定位。
 */
export function mapUpdateToEvent(update: AcpSessionUpdate, runId: string): AgentEventInput | null {
  const kind =
    (update as { sessionUpdate?: string }).sessionUpdate ??
    (update as { kind?: string }).kind ??
    (update as { type?: string }).type ??
    '';
  const record = update as Record<string, unknown>;

  switch (kind) {
    case 'agent_thought_chunk':
      return { type: 'reasoning.delta', runId, text: textOfContent(record.content as AcpContentBlock) };

    case 'agent_message_chunk':
      return { type: 'message.delta', runId, text: textOfContent(record.content as AcpContentBlock) };

    case 'tool_call': {
      const id = String(record.toolCallId ?? `call_${Math.random().toString(36).slice(2, 10)}`);
      const name = String(record.title ?? kind);
      return {
        type: 'tool.started',
        runId,
        call: {
          id,
          name,
          args: (record.rawInput && typeof record.rawInput === 'object' ? record.rawInput : {}) as Record<string, unknown>,
          summary: String(record.title ?? ''),
          // 实测：dsh 的 tool_call.kind 恒为 "other"，按 kind 判风险会一律落到默认档。
          // 真实语义只能从工具名读出来，所以这里是名字优先、kind 兜底。
          risk: riskOfTool(name, record.kind as AcpToolKind),
        },
      };
    }

    case 'tool_call_update': {
      const status = record.status;
      if (status !== 'completed' && status !== 'failed') return null;
      return {
        type: 'tool.completed',
        runId,
        callId: String(record.toolCallId ?? ''),
        ok: status === 'completed',
        // textOfContent 同时认裸块与 { type:'content', content: 块 } 的包装块：
        // dsh 的 tool_call_update 用的是后者，只认裸块则输出恒为空串。
        output: textOfContent(record.content as AcpWrappedContent[]),
        durationMs: 0,
      };
    }

    default:
      return null;
  }
}

/**
 * 工具名 → 风险级别。
 *
 * dsh 实测工具名：write / edit / read / glob / grep / pwsh / web_fetch / skill …
 * 按名字判定，是因为它的 tool_call.kind 恒为 "other"，指望 kind 会让所有工具
 * 落到同一个档位 —— 表现为「读个文件也要弹审批」或反过来「删文件没人拦」。
 */
function riskOfTool(name: string, kind?: AcpToolKind): 'safe' | 'confirm' | 'danger' {
  const lower = name.toLowerCase();
  // MCP 连接器工具（mcp__<server>__<tool>）：来自外部进程，不在内置工具名表里，
  // 落到这里时不能走 kind 兜底（dsh 的 kind 恒为 other）—— 一律至少 confirm；
  // 名字带危险语义的（shell/exec 等）升 danger。危险命令模式的最终硬阻断
  // 仍由 Guard 的命令模式兜底，这里只管「审批弹窗前的分级如实」。
  if (lower.startsWith('mcp__')) {
    if (lower.includes('shell') || lower.includes('exec') || lower.includes('pwsh') || lower.includes('bash')) {
      return 'danger';
    }
    // 浏览器求值（mcp__<server>__browser_evaluate）：在页面上下文执行任意脚本，
    // 与 shell 同级 —— 页面里能读到的 cookie / 凭据，去留由这段脚本决定。
    // 契约层的 BROWSER_TOOL_RISK 也把 evaluate 定为 danger，两处必须一致。
    if (lower.includes('evaluate')) {
      return 'danger';
    }
    return 'confirm';
  }
  if (/^(read|read_image|glob|grep|list_dir|todo_write|get_goal|list_agents|job_list|job_output)$/.test(lower)) {
    return 'safe';
  }
  if (/^(pwsh|bash|shell|exec|job_kill|interrupt_agent)$/.test(lower) || lower.includes('shell') || lower.includes('exec')) {
    return 'danger';
  }
  if (/^(write|edit|delete|move|rm)$/.test(lower) || lower.includes('delete') || lower.includes('remove')) {
    return 'confirm';
  }
  return riskOfKind(kind);
}

/** kind → 风险级别（兜底）。写类必须让用户看见，读类不必打扰。 */
function riskOfKind(kind: AcpToolKind | undefined): 'safe' | 'confirm' | 'danger' {
  switch (kind) {
    case 'read':
    case 'search':
    case 'think':
    case 'fetch':
      return 'safe';
    case 'edit':
    case 'move':
    case 'switch_mode':
      return 'confirm';
    case 'delete':
    case 'execute':
      return 'danger';
    default:
      return 'confirm';
  }
}

/**
 * 从工具入参里取出「动的是什么」，供审批弹窗显示。
 * 取不到就返回空串，由调用方退回工具标题 —— 总比显示 unknown 强。
 */
function subjectOfInput(rawInput: Record<string, unknown> | undefined): string {
  if (!rawInput || typeof rawInput !== 'object') return '';
  for (const key of ['path', 'file', 'file_path', 'filePath', 'command', 'cmd', 'pattern', 'query', 'url']) {
    const value = rawInput[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}
