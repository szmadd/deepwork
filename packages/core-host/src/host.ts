import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  runBoundaries,
  sumUsage,
  type AgentEvent,
  type AgentEventInput,
  type AgentMode,
  type AppConfig,
  type ApprovalDecision,
  type ApprovalRequest,
  type BrowserState,
  type ConnectorConfig,
  type ConnectorState,
  type FileDiff,
  type FilePreview,
  type ForkOrigin,
  type GuardPolicy,
  type HostStatus,
  type MemoryEntry,
  type MemoryLayer,
  type MemoryLayerStat,
  type RunStatus,
  type ScheduleSpec,
  type ScheduleTask,
  type Session,
  type SkillAuditReport,
  type SkillInstallResult,
  type SkillRecord,
  type TerminalState,
  type UsageSummary,
  type WorkspaceTree,
} from '@deepwork/protocol';
import { createAdapter } from './adapter/factory';
import type { HarnessAdapter } from './adapter/types';
import { createLogger } from './logger';
import { clearApiKey, getApiKey, maskApiKey, modelEndpointOverride, setApiKey, syncModelCredentials, validateEndpoint } from './models/endpoint';
import { DEFAULT_MODE, DEFAULT_MODEL, listModels } from './models';
import { configPath, ensureDirs, guardPath, homeDir, readJson, writeJson } from './paths';
import { SchedulerEngine } from './scheduler/engine';
import { ScheduleStore } from './scheduler/store';
import { Guard } from './security/guard';
import { SessionStore } from './session/store';
import { buildMemoryContext } from './memory/context';
import { MemoryStore } from './memory/store';
import {
  buildBrowserMcpPatch,
  buildRuntimePatch,
  serializeRuntimePatchYaml,
  type ConnectorPatchEntry,
} from './mcp/patch';
import { ConnectorStore } from './mcp/store';
import { BrowserManager } from './browser/manager';
import { buildSkillContext } from './skills/context';
import { SkillStore } from './skills/store';
import { TerminalManager, type TerminalSink } from './terminal/manager';
import { summarizeUsage, sanitizeModelPrices, type UsageSample, type UsageSessionMeta } from './usage/summary';
import { registerBuiltinTools } from './tools/builtin';
import { ToolRegistry, type ApprovalOutcome } from './tools/registry';
import { buildTree, readPreview } from './workspace/tree';

const log = createLogger('host');

/**
 * 内核宿主。
 *
 * 职责边界（严格）：
 *  - 拥有会话存储、审批网关、工具注册表、内核适配器、终端；
 *  - 把适配器事件补上 seq/ts、落盘、再推给上层；
 *  - 对外只暴露 RPC 处理器用的方法，不含任何 UI 逻辑。
 */

interface PendingApproval {
  request: ApprovalRequest;
  runId: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  controller: AbortController;
}

export class DeepworkHost {
  private store = new SessionStore();
  private guard = new Guard();
  private tools = new ToolRegistry();
  private terminals = new TerminalManager();
  private skills = new SkillStore();
  private memory = new MemoryStore();
  private scheduleStore = new ScheduleStore();
  private scheduler: SchedulerEngine;
  private connectors = new ConnectorStore();
  private browser = new BrowserManager();
  private adapter: HarnessAdapter | null = null;
  private sink: (event: AgentEvent) => void = () => undefined;
  private terminalSink: TerminalSink = () => undefined;

  private seq = 0;
  private workspace = process.cwd();
  private activeRuns = new Map<string, ActiveRun>();
  private runToSession = new Map<string, string>();
  private pendingApprovals = new Map<string, PendingApproval>();

  /**
   * @param options.scheduler 引擎的 tick 间隔与时钟注入点 —— 测试用短 tick +
   *   偏移时钟真实等到一次触发，而不是把到期判定复制一套到测试里。
   */
  constructor(options?: { scheduler?: { tickMs?: number; now?: () => Date } }) {
    ensureDirs();
    registerBuiltinTools(this.tools, { browser: this.browser });
    this.scheduler = new SchedulerEngine({
      store: this.scheduleStore,
      onFire: (task) => this.fireScheduledTask(task),
      tickMs: options?.scheduler?.tickMs,
      now: options?.scheduler?.now,
    });
  }

  /** 上层（stdio 服务）注册事件出口 */
  onEvent(sink: (event: AgentEvent) => void): void {
    this.sink = sink;
  }

  /**
   * 注册终端出口。
   *
   * 与事件出口分开两条：事件要落盘、要可回放；终端数据不落盘、可以丢。
   * 合成一条通道的话，落盘逻辑就得对「哪些消息不该写文件」做特判 —— 那种特判迟早会被改漏。
   */
  onTerminal(sink: TerminalSink): void {
    this.terminalSink = sink;
  }

  async start(workspace: string): Promise<HostStatus> {
    this.workspace = path.resolve(workspace);
    // 凭据按请求解析（无启动竞态），启动时同步一次；模型端点本体走运行时补丁
    // （prepareRuntimePatchFile），组合期应用才确定 —— settings.yaml 热重载
    // 与 session/new 公布目录之间存在实测竞态，不能用。
    try {
      syncModelCredentials(this.getConfig().modelEndpoint);
    } catch (error) {
      log.error('模型凭据同步失败（按 dsh 现有凭据继续）', String(error));
    }
    this.adapter = await createAdapter({
      workspace: this.workspace,
      model: DEFAULT_MODEL,
      mode: this.getConfig().adapter,
      patchFile: this.prepareRuntimePatchFile(),
    });
    log.info(`内核就绪: ${this.adapter.kind} / ${this.adapter.version}`);
    this.scheduler.start();
    this.emit({
      type: 'host.ready',
      adapter: this.adapter.kind,
      adapterVersion: this.adapter.version,
      capabilities: this.adapter.capabilities(),
    });
    return this.status();
  }

  /**
   * 把启用的连接器清单、模型端点配置与内置浏览器服务生成 dsh 运行时补丁文件；
   * 三者皆空返回 undefined（不传 --patch，内核零改动启动）。
   *
   * 插件与覆盖都在内核启动的组合期应用，所以补丁文件在每次拉起内核前重建；
   * 运行期的清单/端点变更不影响当前进程，需 kernel.restart 生效 —— 这条语义
   * 在 UI 上如实呈现，不做「改了立即生效」的假动作。
   * 都清空后把旧补丁文件一并删掉，避免磁盘上留着一份不再使用的旧配置。
   */
  private prepareRuntimePatchFile(): string | undefined {
    const endpoint = this.getConfig().modelEndpoint;
    const patch = buildRuntimePatch(
      this.connectors.list(),
      modelEndpointOverride(endpoint),
      this.browserMcpPatch(),
    );
    const file = path.join(homeDir(), 'runtime', 'kernel.patch.yml');
    if (!patch) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        log.warn('清理运行时补丁文件失败（忽略）', String(error));
      }
      return undefined;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeRuntimePatchYaml(patch), 'utf8');
    return file;
  }

  /**
   * 内置浏览器服务的补丁条目。
   *
   * 入口找不到时返回 null（不注入）—— 例如有人直接跑源码而没编译 dist。
   * 那时浏览器的后果是「模型看不到 browser_* 工具」，而不是内核起不来；
   * 宁可少一个可选能力，也不要因为它让整个内核启动失败。
   */
  private browserMcpPatch(): { insert: ConnectorPatchEntry[] } | null {
    const entry = path.join(__dirname, 'cli', 'browser-mcp.js');
    if (!fs.existsSync(entry)) {
      log.warn(`未找到浏览器 MCP 服务入口（${entry}），本次不注入该能力`);
      return null;
    }
    const env: Record<string, string> = { DEEPWORK_HOME: homeDir() };
    // Electron 以 ELECTRON_RUN_AS_NODE 跑宿主时，process.execPath 是 electron.exe：
    // 这个变量必须继续传给子进程，否则被拉起的 MCP 服务会变成「启动一个 GUI 应用」——
    // 窗口不出现、MCP 消息也没有回应，症状是「工具调用永远超时」。
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    // 指定过的浏览器路径要一起传，否则宿主找得到、MCP 服务找不到
    if (process.env.DEEPWORK_BROWSER_PATH) {
      env.DEEPWORK_BROWSER_PATH = process.env.DEEPWORK_BROWSER_PATH;
    }
    // 与我们自己被拉起的方式保持一致：谁跑起了宿主，就用同一个运行时跑 MCP 服务
    return buildBrowserMcpPatch({ command: process.execPath, entry, env });
  }

  /**
   * 重启内核进程：连接器插件只在内核启动时加载，清单变更必须经这里生效。
   *
   * 有正在运行的任务时拒绝重启（重启会杀掉它们的内核侧上下文），
   * 失败如实报错并保持「无内核」状态 —— 不静默降级成另一个适配器。
   */
  async restartKernel(): Promise<HostStatus> {
    if (!this.adapter) throw new Error('内核尚未启动');
    if (this.activeRuns.size > 0) {
      throw new Error('有正在运行的任务，请先中断或等它们结束再重启内核');
    }
    await this.adapter.stop();
    this.adapter = null;
    try {
      this.adapter = await createAdapter({
        workspace: this.workspace,
        model: DEFAULT_MODEL,
        mode: this.getConfig().adapter,
        patchFile: this.prepareRuntimePatchFile(),
      });
    } catch (error) {
      throw new Error(`内核重启失败：${error instanceof Error ? error.message : String(error)}`);
    }
    log.info(`内核已重启: ${this.adapter.kind} / ${this.adapter.version}`);
    // 壳层与 UI 靠 host.ready 恢复就绪态（与初次启动同一条通道）
    this.emit({
      type: 'host.ready',
      adapter: this.adapter.kind,
      adapterVersion: this.adapter.version,
      capabilities: this.adapter.capabilities(),
    });
    return this.status();
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
    for (const [, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      pending.resolve({ approved: false });
    }
    this.pendingApprovals.clear();
    for (const [, run] of this.activeRuns) run.controller.abort();
    this.activeRuns.clear();
    this.terminals.closeAll();
    // 浏览器是进程级资源：宿主退出等于应用退出，必须按 endpoint 文件把进程树收掉。
    // 它不会自己退（无界面实例没有窗口可关），漏掉就是一条常驻的 Chromium。
    await this.browser.shutdown();
    await this.adapter?.stop();
    this.adapter = null;
  }

  // ── 事件出口 ──────────────────────────────────────────────

  private emit(input: AgentEventInput): AgentEvent {
    const event = { ...input, seq: ++this.seq, ts: Date.now() } as AgentEvent;

    const sessionId = this.sessionIdOf(event);
    if (sessionId) {
      try {
        this.store.append(sessionId, event);
      } catch (error) {
        // 落盘失败不能中断推理，但要留下痕迹
        log.warn('事件落盘失败', String(error));
      }
    }
    this.sink(event);
    return event;
  }

  private sessionIdOf(event: AgentEvent): string | null {
    if (event.type === 'session.created' || event.type === 'session.updated') return event.session.id;
    // 分叉标记属于新会话的日志，不是父会话的 —— 写错会让父日志里多出一条不属于它的记录
    if (event.type === 'session.forked') return event.session.id;
    if ('runId' in event) return this.runToSession.get(event.runId) ?? null;
    return null;
  }

  // ── 状态与配置 ────────────────────────────────────────────

  status(): HostStatus {
    return {
      adapter: this.adapter?.kind ?? 'mock',
      adapterMode: this.getConfig().adapter,
      credentialsConfigured: credentialsFile() !== null,
      version: this.adapter?.version ?? '未启动',
      pid: process.pid,
      home: homeDir(),
      workspace: this.workspace,
      nodeVersion: process.version,
      capabilities: this.adapter?.capabilities() ?? [],
      guard: this.guard.get(),
    };
  }

  /**
   * 读配置。
   *
   * 用 `{...默认值, ...磁盘值}` 而不是直接返回磁盘内容：旧版本写下的 config.json 少几个字段时
   * 也能正常读，于是永远不需要写迁移脚本。代价是「删掉某个键」无法用配置文件表达 ——
   * 对这份配置来说不存在这种需求，换来的是升级永不出问题。
   */
  getConfig(): AppConfig {
    const stored = readJson<Partial<AppConfig>>(configPath(), {});
    return { ...DEFAULT_CONFIG, ...stored };
  }

  setConfig(patch: Partial<AppConfig>): AppConfig {
    const prev = this.getConfig();
    const next: AppConfig = { ...prev, ...patch };
    // 模型端点先校验再落盘：不合法的配置不该进 config.json，
    // 否则下次启动会带着一份坏配置跑
    if (patch.modelEndpoint) validateEndpoint(patch.modelEndpoint);
    // 单价表同样先清洗再落盘：NaN / 负数单价会让整张估算表变成 NaN，
    // 而那种错误在界面上只是一个 NaN，追不回源头
    if (patch.modelPrices) next.modelPrices = sanitizeModelPrices(patch.modelPrices);
    writeJson(configPath(), next);
    // 端点变化：同步凭据 + 重建运行时补丁文件。补丁在内核启动的组合期应用，
    // 所以变更需要 kernel.restart 生效 —— 生效语义在日志与 UI 上如实呈现。
    if (patch.modelEndpoint && JSON.stringify(patch.modelEndpoint) !== JSON.stringify(prev.modelEndpoint)) {
      const result = syncModelCredentials(next.modelEndpoint);
      this.prepareRuntimePatchFile();
      log.info(`模型端点已更新（重启内核生效）: ${result.detail}`);
    }
    return next;
  }

  getGuard(): GuardPolicy {
    return this.guard.get();
  }

  setGuard(policy: Partial<GuardPolicy>): GuardPolicy {
    return this.guard.set(policy);
  }

  models() {
    // 自定义端点：模型清单就是用户在端点配置里填的那一个（内核目录已被运行时补丁覆盖）
    const endpoint = this.getConfig().modelEndpoint;
    if (endpoint.kind === 'custom' && endpoint.model) {
      return [
        {
          id: endpoint.model,
          label: `${endpoint.model}（自定义端点）`,
          provider: endpoint.baseUrl ?? 'custom',
          supportsPtc: false,
          contextWindow: 0,
        },
      ];
    }
    return listModels(this.adapter?.kind ?? 'mock');
  }

  // ── 模型 API key（secrets.json，明文不出宿主）──────────────────

  modelApiKeyStatus(): { set: boolean; masked?: string } {
    const mode = this.getConfig().modelEndpoint.kind;
    const key = getApiKey(mode);
    return { set: key !== null, masked: maskApiKey(key) };
  }

  /** 设置当前模式的 key 并立即同步进 dsh 凭据（凭据按请求解析，即时生效） */
  setModelApiKey(key: string): { set: boolean; masked?: string } {
    const endpoint = this.getConfig().modelEndpoint;
    setApiKey(endpoint.kind, key);
    const result = syncModelCredentials(endpoint);
    log.info(`模型凭据已更新: ${result.detail}`);
    return this.modelApiKeyStatus();
  }

  clearModelApiKey(): { set: boolean; masked?: string } {
    const endpoint = this.getConfig().modelEndpoint;
    clearApiKey(endpoint.kind);
    const result = syncModelCredentials(endpoint);
    log.info(`模型凭据已清除: ${result.detail}`);
    return this.modelApiKeyStatus();
  }

  // ── 会话 ──────────────────────────────────────────────────

  listSessions(): Session[] {
    return this.store.list();
  }

  createSession(input: {
    workspace: string;
    title?: string;
    mode?: AgentMode;
    model?: string;
  }): Session {
    const config = this.getConfig();
    // 自定义端点时新建会话默认用端点模型（内核目录已只剩这一个模型）；
    // 官方端点走配置默认。用户显式指定优先。
    const endpointModel = config.modelEndpoint.kind === 'custom' ? config.modelEndpoint.model : undefined;
    const session = this.store.create({
      workspace: input.workspace,
      title: input.title,
      mode: input.mode ?? config.defaultMode ?? DEFAULT_MODE,
      model: input.model ?? endpointModel ?? config.defaultModel ?? DEFAULT_MODEL,
    });
    this.emit({ type: 'session.created', session });
    return session;
  }

  renameSession(sessionId: string, title: string): Session {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('标题不能为空');
    const session = this.store.update(sessionId, { title: trimmed.slice(0, 80) });
    this.emit({ type: 'session.updated', session });
    return session;
  }

  deleteSession(sessionId: string): { ok: true } {
    const running = [...this.activeRuns.values()].find((run) => run.sessionId === sessionId);
    if (running) running.controller.abort();
    // 终端跟着会话一起走：留下一个指向已删会话的 shell，用户既看不见也关不掉
    this.terminals.close(sessionId);
    this.store.remove(sessionId);
    log.info(`删除会话 ${sessionId}`);
    return { ok: true };
  }

  sessionEvents(sessionId: string): AgentEvent[] {
    return this.store.readEvents(sessionId);
  }

  /**
   * 从既有会话分叉出一个新会话。
   *
   * 三个刻意的设计选择：
   *
   * 1. **分叉点吸附到运行边界。** 半轮里的日志停在悬空的 tool.started 或半截流式消息上，
   *    那种状态没法接着跑。请求落在轮中就退到该轮之前，并如实记录 `requestedSeq` 与
   *    `atSeq` 的差异，而不是默默改掉用户选的位置。
   * 2. **继承段是字节级复制。** 新会话日志的前 N 行与父会话前 N 行逐字节相同，
   *    所以「这段历史来自哪里」是可核验的，而不是靠字段比对去猜。
   * 3. **用量随上下文一起继承。** 被继承的上下文对模型而言真实存在，成本面板若在分叉处
   *    凭空掉一截，后续的用量判断就会失准。
   */
  forkSession(sessionId: string, atSeq?: number): { session: Session; from: ForkOrigin } {
    const parent = this.store.get(sessionId);
    if (!parent) throw new Error(`会话不存在: ${sessionId}`);

    const running = [...this.activeRuns.values()].some((run) => run.sessionId === sessionId);
    if (running) throw new Error('该会话正在运行，请先中断或等它结束再分叉');

    const events = this.store.readEvents(sessionId);
    if (events.length === 0) throw new Error('该会话还没有任何事件，没有可分叉的历史');

    const requested = typeof atSeq === 'number' && Number.isFinite(atSeq) ? atSeq : null;
    const target = requested ?? events[events.length - 1].seq;

    const boundary =
      [...runBoundaries(events)].reverse().find((seq) => seq <= target) ?? null;
    if (boundary === null) {
      // 两种「没有可用边界」的原因完全不同，提示也必须分开：
      // 一个是这个会话根本还没跑过，另一个是用户选的位置太靠前。
      const hasAnyRun = events.some((event) => event.type === 'run.completed' || event.type === 'run.failed');
      throw new Error(
        hasAnyRun
          ? '所选位置之前没有已完成的运行，无法作为分叉点；请选择某一轮对话结束之后的位置'
          : '该会话还没有完成任何一轮对话，没有可分叉的历史',
      );
    }

    const inherited = events.slice(0, events.findIndex((event) => event.seq === boundary) + 1);

    const session = this.store.create({
      workspace: parent.workspace,
      title: `${parent.title} · 分支`,
      mode: parent.mode,
      model: parent.model,
    });

    const branched = this.store.update(session.id, {
      fork: { sessionId: parent.id, atSeq: boundary },
      usage: sumUsage(inherited),
    });

    // 顺序不可颠倒：先铺继承的历史，再让分叉标记落盘到末尾。
    // 反过来写，新日志的前 N 行就不再等于父日志的前 N 行。
    const copied = this.store.seedFrom(parent.id, branched.id, inherited.length);
    const from: ForkOrigin = { sessionId: parent.id, requestedSeq: requested, atSeq: boundary, copied };

    this.emit({ type: 'session.forked', session: branched, from });
    log.info(`分叉 ${parent.id} → ${branched.id}（继承 ${copied} 条事件，atSeq=${boundary}）`);

    return { session: branched, from };
  }

  // ── 运行 ──────────────────────────────────────────────────

  /** 立即返回 runId，真正的执行在后台推进并通过事件流汇报 */
  send(input: {
    sessionId: string;
    text: string;
    mode?: AgentMode;
    model?: string;
    attachments?: string[];
    /**
     * 由定时任务触发时带上任务本体：schedule.fired 会先于 user.message 落盘
     * （它解释「这一轮是谁发起的」），run 结束时把结局写回任务。
     * 手动发送永远不带它 —— 日志里「这一轮由调度发起」不允许伪造。
     */
    scheduleTask?: ScheduleTask;
  }): { runId: string } {
    const session = this.store.get(input.sessionId);
    if (!session) throw new Error(`会话不存在: ${input.sessionId}`);
    if (!this.adapter) throw new Error('内核未启动');

    const runId = `r_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
    const controller = new AbortController();
    this.activeRuns.set(runId, { runId, sessionId: session.id, controller });
    this.runToSession.set(runId, session.id);

    const mode = input.mode ?? session.mode;
    const model = input.model ?? session.model;
    const attachments = input.attachments?.filter((item) => typeof item === 'string' && item.trim());

    // 首轮对话自动用用户输入生成标题
    if (session.title === '新会话') {
      const title = input.text.replace(/\s+/g, ' ').trim().slice(0, 24) || '新会话';
      const updated = this.store.update(session.id, { title });
      this.emit({ type: 'session.updated', session: updated });
    }
    this.emit({ type: 'session.updated', session: this.store.update(session.id, { status: 'running' }) });

    // 调度触发的留痕：必须先于 user.message / run.started —— runToSession 映射
    // 已在上面建立，事件归属这条 run 的会话（与 skill.attached 同一条纪律）
    if (input.scheduleTask) {
      this.emit({
        type: 'schedule.fired',
        runId,
        sessionId: session.id,
        task: { ...input.scheduleTask },
      });
    }

    // 用户输入先进事件流，保证日志可用于回放
    this.emit({ type: 'user.message', runId, text: input.text, attachments });

    // 技能上下文：每轮按「当前启用清单」重新构建 —— 用户在面板里停用一个技能，
    // 下一轮就必须看不到它，不存在「缓存里还有」的窗口期
    const skillContext = buildSkillContext(this.skills, input.text);
    if (skillContext.attached.length > 0) {
      this.emit({ type: 'skill.attached', runId, skills: skillContext.attached });
    }
    if (skillContext.skipped.length > 0) {
      log.warn(`技能启用但 SKILL.md 不可用，已跳过: ${skillContext.skipped.join(', ')}`);
    }

    // 记忆上下文：每轮重建（与技能同理，面板里删掉一条，下一轮就不能再看到它）。
    // 有内容才发 memory.attached，且必须先于 run.started —— 不带 runId 或次序颠倒
    // 都会让分叉会话的视图里凭空多出别的会话的记忆记录
    const memoryContext = buildMemoryContext(this.memory, session.workspace);
    if (memoryContext.prompt) {
      this.emit({ type: 'memory.attached', runId, layers: memoryContext.layers });
    }

    void this.adapter
      .run({
        runId,
        sessionId: session.id,
        text: input.text,
        attachments,
        workspace: session.workspace,
        mode,
        model,
        skillContext: skillContext.prompt,
        memoryContext: memoryContext.prompt,
        guard: this.guard,
        tools: this.tools,
        signal: controller.signal,
        emit: (event) => {
          this.emit(event);
          if (event.type === 'usage') {
            this.store.accumulateUsage(session.id, event.usage);
          }
        },
        requestApproval: (req) => this.requestApproval(runId, session.id, req),
      })
      .then((status: RunStatus) => {
        const finalStatus = status === 'completed' ? 'idle' : status === 'aborted' ? 'aborted' : 'failed';
        const updated = this.store.update(session.id, { status: finalStatus, mode, model });
        this.emit({ type: 'session.updated', session: updated });
        // 调度任务的结局写回：run 结束才知道 lastStatus，引擎在触发时管不到这一头
        if (input.scheduleTask) {
          try {
            this.scheduleStore.patch(input.scheduleTask.id, { lastStatus: status, lastSessionId: session.id });
          } catch (error) {
            log.warn('定时任务结局写回失败', String(error));
          }
        }
        // 工作区每日日志：run 结束即追加一行（时间 / 用户输入前 80 字 / 结果状态）。
        // 只追加不覆盖 —— 它是「这个项目里实际跑过什么」的流水账，落点失败不阻断会话。
        try {
          const brief = input.text.replace(/\s+/g, ' ').trim().slice(0, 80);
          this.memory.appendDailyLog(
            session.workspace,
            `- ${new Date().toISOString()} · 输入：${brief} · 结果：${status}`,
          );
        } catch (error) {
          log.warn('每日日志追加失败', String(error));
        }
      })
      .catch((error: unknown) => {
        log.error('run 未捕获异常', String(error));
      })
      .finally(() => {
        this.activeRuns.delete(runId);
      });

    return { runId };
  }

  abort(runId: string): { ok: boolean } {
    const run = this.activeRuns.get(runId);
    if (!run) return { ok: false };
    run.controller.abort();
    this.adapter?.abort(runId);
    return { ok: true };
  }

  // ── 工作区视图（只读）──────────────────────────────────────

  workspaceTree(sessionId: string, base?: string, depth?: number): WorkspaceTree {
    const root = this.workspaceOf(sessionId);
    return buildTree(root, { base, depth: depth ?? this.getConfig().treeDepth });
  }

  previewFile(sessionId: string, rel: string): FilePreview {
    return readPreview(this.workspaceOf(sessionId), rel);
  }

  // ── 终端 ──────────────────────────────────────────────────

  openTerminal(sessionId: string): TerminalState {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    return this.terminals.open(sessionId, session.workspace, (chunk) => this.terminalSink(chunk));
  }

  runTerminal(sessionId: string, command: string): { entryId: string } {
    return this.terminals.run(sessionId, command);
  }

  writeTerminal(sessionId: string, data: string): { ok: boolean } {
    return this.terminals.write(sessionId, data);
  }

  interruptTerminal(sessionId: string): { ok: boolean } {
    return this.terminals.interrupt(sessionId);
  }

  closeTerminal(sessionId: string): { ok: true } {
    return this.terminals.close(sessionId);
  }

  // ── 技能系统 ──────────────────────────────────────────────

  listSkills(): SkillRecord[] {
    return this.skills.list();
  }

  installSkill(source: string): SkillInstallResult {
    return this.skills.install(source);
  }

  uninstallSkill(name: string): { ok: boolean } {
    return { ok: this.skills.uninstall(name) };
  }

  auditSkill(source: string): SkillAuditReport {
    return this.skills.auditOnly(source);
  }

  toggleSkill(name: string, enabled: boolean): SkillRecord {
    const record = this.skills.toggle(name, enabled);
    if (!record) throw new Error(`技能不存在或未安装：${name}`);
    return record;
  }

  // ── 三层记忆 ──────────────────────────────────────────────
  // 写入是显式动作（UI 面板 / 宿主侧日志追加），预算超限在这里抛错，
  // 让 UI 能把「为什么没记下」原样摆给用户，而不是静默丢掉。

  listMemories(layer?: MemoryLayer, workspace?: string): MemoryEntry[] {
    return this.memory.list(layer, workspace);
  }

  addMemory(layer: MemoryLayer, text: string, workspace?: string): MemoryEntry {
    return this.memory.add(layer, text, { workspace });
  }

  removeMemory(id: string): { ok: boolean } {
    return { ok: this.memory.remove(id) };
  }

  memoryStats(workspace?: string): MemoryLayerStat[] {
    return this.memory.stats(workspace);
  }

  setMemoryProfile(text: string): { ok: boolean } {
    this.memory.setProfile(text);
    return { ok: true };
  }

  // ── 自动化调度 ────────────────────────────────────────────
  // 调度只在应用运行期间生效（引擎随宿主启动与停止），错过不补跑。
  // 自动任务走与手动 send 完全相同的链路（技能/记忆注入、审批网关），
  // 不享有绕过审批的特权。

  listSchedules(): ScheduleTask[] {
    return this.scheduleStore.list();
  }

  addSchedule(input: { title: string; prompt: string; workspace: string; spec: ScheduleSpec }): ScheduleTask {
    return this.scheduleStore.add(input);
  }

  removeSchedule(id: string): { ok: boolean } {
    return { ok: this.scheduleStore.remove(id) };
  }

  toggleSchedule(id: string, enabled: boolean): ScheduleTask {
    const task = this.scheduleStore.toggle(id, enabled);
    if (!task) throw new Error(`定时任务不存在: ${id}`);
    return task;
  }

  /** 手动立即触发一次；与定时触发同一条路径，返回派生出的 runId */
  runScheduleNow(id: string): { runId: string } {
    if (!this.adapter) throw new Error('内核未启动');
    return this.scheduler.runNow(id);
  }

  // ── 连接器（MCP）──────────────────────────────────────────
  // DeepWork 只管清单；连接与工具注册在内核。清单变更在下一次
  // 内核启动（kernel.restart / 应用重启）时才拼进 --patch，这里不做任何
  // 「立即生效」的假动作。

  listConnectors(): ConnectorState[] {
    return this.connectors.listStates();
  }

  addConnector(config: ConnectorConfig): ConnectorState {
    return this.connectors.add(config);
  }

  removeConnector(name: string): { ok: boolean } {
    return { ok: this.connectors.remove(name) };
  }

  toggleConnector(name: string, enabled: boolean): ConnectorState {
    const state = this.connectors.toggle(name, enabled);
    if (!state) throw new Error(`连接器不存在：${name}`);
    return state;
  }

  // ── 用量聚合（M2-J）────────────────────────────────────────
  // 只读聚合：扫既有会话存储（meta.usage + 日志里的 usage 事件），算完即弃。
  // 不落第二份「用量表」—— 同一件事有两个事实来源必然漂移，且漂移时无权威。

  usageSummary(): UsageSummary {
    const sessions = this.store.list();
    const meta: UsageSessionMeta[] = sessions.map((session) => ({
      id: session.id,
      title: session.title,
      workspace: session.workspace,
      updatedAt: session.updatedAt,
    }));

    const samples: UsageSample[] = [];
    for (const session of sessions) {
      const events = this.store.readEvents(session.id);

      // usage 事件不带模型，模型只在 run.started 上。先建 runId → model 映射，
      // 再逐条归集 —— 一个会话中途可以换模型，用会话当前的 model 会把换模型
      // 之前的用量算到新模型头上，而那正是用量面板最该答对的题。
      const modelOfRun = new Map<string, string>();
      for (const event of events) {
        if (event.type === 'run.started') modelOfRun.set(event.runId, event.model);
      }

      for (const event of events) {
        if (event.type !== 'usage') continue;
        samples.push({
          sessionId: session.id,
          runId: event.runId,
          // 找不到 run.started（日志被截断 / 内核没发）时退化为会话当前模型：
          // 不精确但可解释，且其后果会如实出现在 unpricedModels 里，不会静默。
          model: modelOfRun.get(event.runId) ?? session.model,
          ts: event.ts,
          usage: event.usage,
        });
      }
    }

    return summarizeUsage({
      sessions: meta,
      samples,
      // 读取侧同样清洗：config.json 可能被手工改过，而一个坏单价会让整张估算表变成 NaN。
      // 清洗把坏条目变成「未定价」，那是一个能被理解的界面状态。
      prices: sanitizeModelPrices(this.getConfig().modelPrices),
      now: Date.now(),
    });
  }

  // ── 浏览器（M2-H）──────────────────────────────────────────
  // 这里只有面板用的三个方法，都是「用户自己的动作」，不走审批。
  // 模型侧的六个动作走工具注册表与内核加载的 MCP 服务，那条路径必须过审批。
  // 两条入口的授权语义不同，不能合并 —— 合并等于给模型留一条绕过审批的旁路。

  browserState(): BrowserState {
    return this.browser.state();
  }

  /**
   * 用户亲手打开一个网页（面板地址栏）。
   *
   * 与 Agent 的 navigate 不同，这里不弹审批：地址栏里那串 URL 是用户自己敲的，
   * 让他再批准一次自己刚做的决定，只会训练出「闭着眼点允许」——
   * 而那个习惯会在真正需要他看一眼的审批上生效。
   */
  async browserOpen(url: string): Promise<BrowserState> {
    await this.browser.run('navigate', { url });
    return this.browser.state();
  }

  browserClose(): { ok: true; message: string } {
    return this.browser.close();
  }

  /**
   * 引擎触发回调：为任务派生一个真实 run。
   *
   * 会话复用纪律：任务上次绑定的会话还在就复用（同一任务的历次触发
   * 留在同一条时间线里，交付物与上下文连续）；会话已被删除则以
   * 「⏰ 任务标题」新建并绑定。绑定关系由 run 结束时的 lastSessionId
   * 写回维护 —— 这里不直接写，避免「绑定了但 run 没跑成」的假记录。
   */
  private fireScheduledTask(task: ScheduleTask): string {
    let sessionId = task.lastSessionId;
    if (!sessionId || !this.store.get(sessionId)) {
      const session = this.createSession({ workspace: task.workspace, title: `⏰ ${task.title}` });
      sessionId = session.id;
    }
    const { runId } = this.send({ sessionId, text: task.prompt, scheduleTask: task });
    return runId;
  }

  // ── 审批 ──────────────────────────────────────────────────

  private requestApproval(
    runId: string,
    sessionId: string,
    input: {
      tool: string;
      subject: string;
      reason: string;
      diff?: FileDiff;
      selectable?: boolean;
    },
  ): Promise<ApprovalOutcome> {
    const request: ApprovalRequest = {
      id: `ap_${crypto.randomUUID().slice(0, 8)}`,
      callId: '',
      tool: input.tool,
      subject: input.subject,
      cwd: this.store.get(sessionId)?.workspace,
      reason: input.reason,
      risk: 'confirm',
      // 差异原样带到 UI：审批弹窗展示的内容与将要落盘的内容必须逐字一致，
      // 中间任何一层「顺手裁剪」都会让审批退化成盲签
      diff: input.diff,
      selectable: input.selectable,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60_000,
    };

    this.emit({ type: 'approval.requested', runId, request });

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(request.id);
        this.emit({ type: 'approval.resolved', runId, requestId: request.id, decision: 'deny' });
        resolve({ approved: false });
      }, 5 * 60_000);

      this.pendingApprovals.set(request.id, {
        request,
        runId,
        timer,
        resolve: (outcome) => {
          clearTimeout(timer);
          this.pendingApprovals.delete(request.id);
          resolve(outcome);
        },
      });
    });
  }

  respondApproval(
    requestId: string,
    decision: ApprovalDecision,
    persist = false,
    hunks?: number[],
  ): { ok: boolean } {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return { ok: false };

    if (decision === 'allow_always' && persist) {
      this.guard.rememberAlwaysAllow(pending.request.subject);
    }

    // 只有「允许」才带选择；拒绝时把 hunks 丢掉，避免日志里出现「拒绝了但采纳了 3 处」这种自相矛盾
    const approved = decision === 'allow' || decision === 'allow_always';
    const normalized = approved && hunks !== undefined ? [...new Set(hunks)].sort((a, b) => a - b) : undefined;
    // 采纳数为 0 的部分授权等价于拒绝。这里显式归一化，不让「空挑选」以「允许」的形态流下去，
    // 否则写工具会拿到一个既非同意也非拒绝的状态，最终只能靠各自的特判去猜。
    const effective = approved && normalized !== undefined && normalized.length === 0 ? false : approved;

    this.emit({
      type: 'approval.resolved',
      runId: pending.runId,
      requestId,
      decision: effective ? decision : 'deny',
      hunks: effective ? normalized : undefined,
    });

    pending.resolve(effective ? { approved: true, hunks: normalized } : { approved: false });
    return { ok: true };
  }

  /** 供 RPC 层查询当前待审批项（UI 重连时补状态用） */
  pendingApprovalList(): ApprovalRequest[] {
    return [...this.pendingApprovals.values()].map((item) => item.request);
  }

  workspaceOf(sessionId: string): string {
    return this.store.get(sessionId)?.workspace ?? this.workspace;
  }

  /** 打开一个会话时把 workspace 落到 config，便于下次启动恢复 */
  rememberWorkspace(workspace: string): void {
    this.setConfig({ lastWorkspace: path.resolve(workspace) });
  }

  guardFilePath(): string {
    return guardPath();
  }
}


/**
 * dsh 凭据文件的位置（$DSH_HOME/.credentials.yaml，缺省 ~/.dsh）。
 * 只判断存在性，不读内容 —— 里面是 API key，宿主不需要知道它是什么。
 */
function credentialsFile(): string | null {
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  const file = path.join(dshHome, '.credentials.yaml');
  return fs.existsSync(file) ? file : null;
}
