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
  type EndpointTestResult,
  type FileDiff,
  type FilePreview,
  type ForkOrigin,
  type GuardPolicy,
  type HostStatus,
  isSandboxMode,
  type MemoryEntry,
  type MemoryLayer,
  type MemoryLayerStat,
  type ModelCatalog,
  type ModelDescriptor,
  type PreflightReport,
  type RunStatus,
  type RuntimeStatus,
  SANDBOX_MODES,
  type SandboxEscalation,
  type SandboxMode,
  type SandboxStatus,
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
import { resolveSandboxMode, sandboxPlatformNote } from './security/sandbox';
import { clearApiKey, endpointRestartMessage, endpointRoutingFingerprint, getApiKey, maskApiKey, modelEndpointOverride, setApiKey, syncModelCredentials, validateEndpoint } from './models/endpoint';
import { testEndpoint } from './models/endpoint-test';
import { DEFAULT_MODE, DEFAULT_MODEL, catalogUnavailable, mockCatalog } from './models';
import { configPath, ensureDirs, guardPath, homeDir, readJson, writeJson } from './paths';
import { runPreflight } from './runtime/preflight';
import { defaultBundledDirs, resolvePythonRuntime } from './runtime/python';
import { SchedulerEngine } from './scheduler/engine';
import { ScheduleStore } from './scheduler/store';
import { Guard } from './security/guard';
import { SessionStore } from './session/store';
import { buildMemoryContext } from './memory/context';
import { MemoryStore } from './memory/store';
import {
  buildBrowserMcpPatch,
  buildChartMcpPatch,
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
  /**
   * 最近一次拿到的模型目录，供 createSession 决定「默认用哪个模型」。
   *
   * 它是**缓存而不是事实来源**：真事实在内核的 session/new 帧里，这里只是把
   * 「刚才问到的答案」留一份，免得每建一个会话都要再去问一次内核。
   */
  private catalog: ModelCatalog | null = null;
  /**
   * 内核进程**启动时**带着的端点指纹（见 models/endpoint 的 endpointRoutingFingerprint）。
   *
   * 为什么必须自己留一份：端点进补丁是内核启动的组合期动作，内核一旦起来，它就与
   * config.json 脱钩了 —— 用户随后改配置，磁盘上、设置页里、模型目录里全都立刻是新的，
   * 只有真正在跑的那个内核还是旧的。不记这一笔，宿主就没有任何依据发现这件事，
   * 只能等用户来报「发出去一直没有回应」。null = 还没成功起过内核（不知道，不猜）。
   */
  private kernelEndpoint: string | null = null;
  /**
   * 内核沙箱模式：**进程启动时解析、每次重启内核时重新解析**。
   *
   * 与 `kernelEndpoint` 同一形态（启动参数、改了要重启内核），但不需要「旧值 vs 新值」
   * 的比较：它没有运行期修改入口 —— ACP 面不暴露 mode（`session/set_config_option`
   * 只认 model 与 reasoning_effort），所以要换档只有重启内核这一条路。
   *
   * **为什么重启内核时要重解析**（FR-3.5 尾项）：档位是内核进程的启动参数，
   * 换档 = 用新的 `DSH_PERMISSION_MODE` 重新拉起内核。设置页把选择存进 config.json 后，
   * 若这里不重解析，用户就会遇到「改了、也重启了、界面上却还是旧档位」——
   * 那时唯一的出路是重启整个应用，而界面上没有任何一处会告诉他这一点。
   *
   * 记它的意义在于**可核验**：在此之前产品从未设置过 `DSH_PERMISSION_MODE`，
   * 内核跑在自己的默认值上，界面上没有任何一处能回答「模型的写入受什么约束」。
   */
  private sandbox: SandboxStatus;
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
    // 沙箱档位在这里解析一次：它是内核的启动参数，进程活着的期间不会再变
    // （换档走 restartKernel，那里会再解析一次 —— 见 refreshSandbox）。
    this.sandbox = this.refreshSandbox(null);
    registerBuiltinTools(this.tools, { browser: this.browser });
    this.scheduler = new SchedulerEngine({
      store: this.scheduleStore,
      onFire: (task) => this.fireScheduledTask(task),
      tickMs: options?.scheduler?.tickMs,
      now: options?.scheduler?.now,
    });
  }

  /**
   * 重新解析沙箱档位并更新 `this.sandbox`；返回新的状态。
   *
   * @param previous 上一次生效的档位（构造时传 null）。只在真的变了的时候写日志 ——
   *   每次重启内核都打一行「档位未变」会把日志淹没，而这条日志的价值恰恰在于
   *   「什么时候档位换过」。
   *
   * 非法值必须留下痕迹（`log.warn` + `rejected` 进 status）—— 权限设置上
   * 「以为生效了」是最不该有的状态。注意非法值**不会**中断解析：
   * 见 `resolveSandboxMode` 的「跳过而非判死刑」。
   */
  private refreshSandbox(previous: SandboxMode | null): SandboxStatus {
    // 读配置里用户的选择（可能没有）；环境变量优先级高于它，由 resolveSandboxMode 决定
    const resolved = resolveSandboxMode(process.env, { configured: this.getConfig().sandboxMode });
    if (resolved.rejected !== undefined) {
      log.warn(
        `沙箱档位「${resolved.rejected}」不是合法值（合法值：${SANDBOX_MODES.join(' / ')}），` +
          `已跳过它、改用 ${resolved.mode}（来源：${resolved.source}）`,
      );
    }
    if (previous !== null && previous !== resolved.mode) {
      log.info(`沙箱档位已切换：${previous} → ${resolved.mode}（来源：${resolved.source}）`);
    }
    const platformNote = sandboxPlatformNote();
    return {
      mode: resolved.mode,
      source: resolved.source,
      ...(resolved.rejected !== undefined ? { rejected: resolved.rejected } : {}),
      ...(platformNote !== null ? { note: platformNote } : {}),
    };
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
      // 适配器构造参数里的 model 只是启动期的占位：真正决定每一轮用哪个模型的是
      // RunContext.model（由会话携带）。这里传配置里的默认值，是为了让
      // 「内核以什么身份起来」与「界面显示的默认模型」至少不互相矛盾。
      model: this.getConfig().defaultModel || DEFAULT_MODEL,
      mode: this.getConfig().adapter,
      patchFile: this.prepareRuntimePatchFile(),
      sandboxMode: this.sandbox.mode,
    });
    // 补丁已经写盘、内核已经带着它起来 —— 记下「这一代内核的端点是哪个」
    this.kernelEndpoint = endpointRoutingFingerprint(this.getConfig().modelEndpoint);
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
      this.chartMcpPatch(),
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
   * 内置图表服务的补丁条目。
   *
   * 与浏览器那一条同源：宿主工具注册表只在 mock 下被执行，真实内核看不到
   * `chart.render`，因此必须把同一份实现（chart/plan.ts）以 MCP 服务的形式
   * 提供给内核。入口找不到时**不注入**（不阻断内核启动）—— 缺的只是画图能力，
   * 比内核起不来轻得多。
   *
   * env 里的 `DEEPWORK_WORKSPACE` 就是内核自己被启动时拿到的那个 workspace：
   * 图表是写文件的能力，边界必须与内核一致，否则会出现「图写到别的目录去了」
   * 这种不报错的错位。
   */
  private chartMcpPatch(): { insert: ConnectorPatchEntry[] } | null {
    const entry = path.join(__dirname, 'cli', 'chart-mcp.js');
    if (!fs.existsSync(entry)) {
      log.warn(`未找到图表 MCP 服务入口（${entry}），本次不注入该能力`);
      return null;
    }
    const env: Record<string, string> = {
      DEEPWORK_HOME: homeDir(),
      DEEPWORK_WORKSPACE: this.workspace,
    };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return buildChartMcpPatch({ command: process.execPath, entry, env });
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
    // 档位是内核的启动参数，所以「重启内核」正是重新解析它的时刻：
    // 设置页存下的选择在这里才真正生效（不重解析的话用户会看到
    // 「改了、也重启了、档位还是旧的」，且无从得知为何）。
    this.sandbox = this.refreshSandbox(this.sandbox.mode);
    try {
      this.adapter = await createAdapter({
        workspace: this.workspace,
        model: this.getConfig().defaultModel || DEFAULT_MODEL,
        mode: this.getConfig().adapter,
        patchFile: this.prepareRuntimePatchFile(),
        sandboxMode: this.sandbox.mode,
      });
    } catch (error) {
      throw new Error(`内核重启失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 重启就是为了让新补丁（端点 / 连接器）生效，所以这一笔必须跟着更新：
    // 漏了它，界面会一直说「端点配置和内核不一致」，而用户已经重启过了
    this.kernelEndpoint = endpointRoutingFingerprint(this.getConfig().modelEndpoint);
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
      kernelEndpoint: this.kernelEndpoint ?? endpointRoutingFingerprint(this.getConfig().modelEndpoint),
      configEndpoint: endpointRoutingFingerprint(this.getConfig().modelEndpoint),
      // 拷贝一份出去：调用方拿到的是状态快照，不该能改到宿主的字段
      sandbox: { ...this.sandbox },
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
    // 沙箱档位先校验再落盘：和端点同一个理由 —— 不合法的值进了 config.json，
    // 下次启动会带着一份坏配置跑。这里**拒绝**而不是回落：setConfig 的调用方是
    // 我们自己的设置页，给它一个明确的报错比替它选一个档位更有用。
    // 注意与 resolveSandboxMode 的取舍不同：那里要容忍手改过的配置文件，所以是跳过 + 留痕。
    if (patch.sandboxMode !== undefined && !isSandboxMode(patch.sandboxMode)) {
      throw new Error(
        `沙箱档位「${String(patch.sandboxMode)}」不是合法值（合法值：${SANDBOX_MODES.join(' / ')}）`,
      );
    }
    // 单价表同样先清洗再落盘：NaN / 负数单价会让整张估算表变成 NaN，
    // 而那种错误在界面上只是一个 NaN，追不回源头
    if (patch.modelPrices) next.modelPrices = sanitizeModelPrices(patch.modelPrices);
    writeJson(configPath(), next);
    // 端点变化：同步凭据 + 重建运行时补丁文件。补丁在内核启动的组合期应用，
    // 所以变更需要 kernel.restart 生效 —— 生效语义在日志与 UI 上如实呈现。
    if (patch.modelEndpoint && JSON.stringify(patch.modelEndpoint) !== JSON.stringify(prev.modelEndpoint)) {
      const result = syncModelCredentials(next.modelEndpoint);
      this.prepareRuntimePatchFile();
      // 端点一换，内核公布出来的目录跟着换（覆盖补丁会在下次启动生效），
      // 缓存里那份就过期了。清掉而不是留着：留着会让「设置页显示的是什么」
      // 与「重启后会变成什么」不一致，而这种不一致没有任何报错。
      this.catalog = null;
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

  /**
   * 模型目录：向内核要真帧，拿不到就如实说拿不到。
   *
   * 三条分支的顺序有讲究 —— **自定义端点优先**：端点插了覆盖补丁时，
   * 内核公布出来的目录就是端点那一个模型，此时再走「问内核」也是同一个答案，
   * 但会白建一个探针会话；而基址（baseUrl）只有宿主知道，界面上要显示它。
   *
   * 真实内核这条路上，目录的权威来源是 session/new 真帧（见 adapter 的 modelCatalog）。
   * 探针会话只在显式要求（probe=true，UI 的「重新核对」）或还没有任何真帧时才建。
   */
  async modelCatalog(probe = false): Promise<ModelCatalog> {
    const endpoint = this.getConfig().modelEndpoint;
    if (endpoint.kind === 'custom' && endpoint.model) {
      const model: ModelDescriptor = {
        id: endpoint.model,
        label: endpoint.model,
        provider: endpoint.baseUrl ?? 'custom',
        // 端点上的模型支不支持程序化工具调用，只有端点自己知道 —— 我们不猜
        supportsPtc: false,
        source: 'endpoint',
        endpoint: endpoint.baseUrl,
      };
      // 只有用户真的填了才带上这个字段。写成 `contextWindow: undefined` 会让
      // `'contextWindow' in model` 为 true —— 「未知」与「值是 undefined」在
      // 断言和界面判断上是两回事，别让它们混为一谈。
      if (endpoint.contextWindow !== undefined) model.contextWindow = endpoint.contextWindow;
      const catalog: ModelCatalog = {
        models: [model],
        reasoningEfforts: [],
        kernelDefaultModel: model.id,
        kernelDefaultReasoningEffort: null,
        source: 'endpoint',
        checkedAt: null,
        note: `自定义端点：模型来自你在设置里填的模型名（${endpoint.baseUrl ?? '未填地址'}），未与端点核对`,
      };
      this.catalog = catalog;
      return catalog;
    }

    if (this.adapter?.kind === 'harness') {
      const fromKernel = await this.adapter.modelCatalog(probe);
      if (fromKernel) {
        this.catalog = fromKernel;
        return fromKernel;
      }
      const failed = catalogUnavailable(
        '未能向内核核对模型目录（session/new 未公布 configOptions 或取帧失败）——'
        + ' 请查看内核日志；此状态下不改动内核模型，沿用内核默认。',
      );
      this.catalog = failed;
      return failed;
    }

    const mock = mockCatalog();
    this.catalog = mock;
    return mock;
  }

  /**
   * 新建会话默认用哪个模型。
   *
   * 顺序（用户选定优先）：
   *   1. 调用方显式指定（界面上那一栏选的模型）；
   *   2. `config.defaultModel` —— **用户在设置里自行选定的那个，官方模型或自定义端点模型都行**；
   *   3. 内核真帧里的当前默认（currentValue）—— 「没选就是跟随内核」；
   *   4. 自定义端点填的模型名；
   *   5. DEFAULT_MODEL（最后的兜底，几乎没有机会用到）。
   *
   * 第 2 步曾经排在第 4 步之后：上一次改动让「切到自定义端点」顺手改写新建会话的模型，
   * 于是用户在设置里选的默认被端点配置静默覆盖 —— 界面显示的是他选的，跑的是另一个。
   * 端点配置决定「请求发到哪里」，不该顺手决定「用哪个模型」。
   */
  private resolveDefaultModel(config: AppConfig): string {
    return (
      config.defaultModel
      || this.catalog?.kernelDefaultModel
      || (config.modelEndpoint.kind === 'custom' ? config.modelEndpoint.model : '')
      || DEFAULT_MODEL
    );
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

  /**
   * 端点连通性测试（设置页「测试连接」）：对界面上的未保存值发一次真实请求。
   * key 优先级：显式参数 > 已存的 custom key > 无。结果不含 key，可直接回渲染层。
   */
  testModelEndpoint(input: { baseUrl?: string; apiKey?: string }): Promise<EndpointTestResult> {
    return testEndpoint({
      baseUrl: String(input.baseUrl ?? ''),
      apiKey: input.apiKey?.trim() || getApiKey('custom') || undefined,
    });
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
    const session = this.store.create({
      workspace: input.workspace,
      title: input.title,
      mode: input.mode ?? config.defaultMode ?? DEFAULT_MODE,
      model: input.model || this.resolveDefaultModel(config),
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

    /*
     * 开跑前端点守卫：端点配置改了、内核还是按旧端点起来的，这一轮就问错地方。
     *
     * 排在最前面（先于模型守卫）：**它成立时，模型目录本身就是不可信的** ——
     * 端点源目录是照 config 现算出来的（见 modelCatalog 的自定义端点分支），
     * 内核那边其实还是旧端点。先按目录去判模型，等于拿一份描述「重启后会怎样」
     * 的清单去裁决「现在的内核能不能跑」。
     */
    const endpointIssue = endpointRestartMessage({
      adapterKind: this.adapter.kind,
      running: this.kernelEndpoint,
      configured: this.getConfig().modelEndpoint,
    });
    if (endpointIssue) {
      this.emit({ type: 'run.failed', runId, message: endpointIssue, retryable: true });
      this.emit({ type: 'session.updated', session: this.store.update(session.id, { status: 'failed' }) });
      this.activeRuns.delete(runId);
      this.runToSession.delete(runId);
      return { runId };
    }

    /*
     * 开跑前模型守卫：目录里查无此模型时不发请求。
     *
     * 来历是内网部署的一次真实现场：用户切到自定义端点后，会话仍带着旧的官方
     * 默认模型，每一轮都被端点回一句 "Model not found" —— 四层原因（服务没起 /
     * 地址错 / key 无效 / 模型名错）共用一个症状，排障无从下手。在这里拦下，
     * 把「端点回的字符串」换成「目录里实际有哪些、去哪改」。
     *
     * 目录为空（从未核对上）时不拦：那是「不知道」，不是「不匹配」，
     * 让请求照常走、由内核与端点给出它们那一层的答案。
     */
    const knownModels = this.catalog?.models ?? [];
    if (knownModels.length > 0 && !knownModels.some((item) => item.id === model)) {
      const options = knownModels.map((item) => item.id).join(' / ');
      this.emit({
        type: 'run.failed',
        runId,
        message:
          `模型「${model}」不在当前模型目录里（可选：${options}）。` +
          '请到设置修改默认模型（或新建会话时在顶栏选择），再重试。',
        retryable: false,
      });
      this.emit({ type: 'session.updated', session: this.store.update(session.id, { status: 'failed' }) });
      this.activeRuns.delete(runId);
      this.runToSession.delete(runId);
      return { runId };
    }

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
        // 推理档位取自配置（空 = 不干预）。它不随会话存：用户改的是「我这几轮想多想少」，
        // 不是「这个会话绑死在某个档位上」—— 下一轮就生效，不必新建会话。
        reasoningEffort: this.getConfig().defaultReasoningEffort || undefined,
        skillContext: skillContext.prompt,
        memoryContext: memoryContext.prompt,
        guard: this.guard,
        tools: this.tools,
        signal: controller.signal,
        emit: (event) => {
          const stamped = this.emit(event);
          if (event.type === 'usage') {
            this.store.accumulateUsage(session.id, event.usage);
          } else if (event.type === 'context.usage') {
            /*
             * 上下文占用写进会话 meta，而不只留在事件流里。
             *
             * 它是「这轮还能塞下多少」的即时依据，而用户看它的时机恰恰是
             * 切换会话回来、或重启应用之后 —— 只在当次事件流里有效的话，
             * 它的可用窗口短得几乎没有意义。
             *
             * 同时发 session.updated：界面据此刷新，不必自己再解析事件流。
             * 一轮里内核会报多次（每条助手消息一次），每次都更新 meta 是刻意的：
             * 保留的是**最近一次**占用，而中间那些快照没有留存价值。
             */
            const updated = this.store.update(session.id, {
              context: { used: event.used, size: event.size, ts: stamped.ts },
            });
            this.emit({ type: 'session.updated', session: updated });
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
    const runIds: string[] = [];
    for (const session of sessions) {
      const events = this.store.readEvents(session.id);

      // usage 事件不带模型，模型只在 run.started 上。先建 runId → model 映射，
      // 再逐条归集 —— 一个会话中途可以换模型，用会话当前的 model 会把换模型
      // 之前的用量算到新模型头上，而那正是用量面板最该答对的题。
      const modelOfRun = new Map<string, string>();
      for (const event of events) {
        if (event.type === 'run.started') {
          modelOfRun.set(event.runId, event.model);
          // 顺带收全量 run 清单：覆盖率的分母。它必须在**同一次扫描**里取，
          // 否则「跑了 3 轮」与「3 轮都有数据」可能出自两套口径。
          runIds.push(event.runId);
        }
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
      runIds,
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

  /**
   * 环境体检（ROADMAP §8.3）。
   *
   * 与安装器用的是**同一份实现** —— 设置页里跑出来的报告与安装时跑出来的报告
   * 必须是同一个东西。两份实现一旦分叉（比如一边多查一项），分歧不会有任何报错，
   * 只会在「装的时候说没事、用起来才发现缺东西」时暴露出来。
   *
   * writeDir 默认取用户数据目录：那是应用**自己**要持续写入的地方，
   * 比安装目录更贴近「写不进去就真的用不了」这个语义。安装目录的写权限
   * 由安装器在装之前判断（那时应用还没跑起来），两者互补而不是重复。
   */
  preflight(writeDir?: string): PreflightReport {
    return runPreflight({
      writeDir: writeDir ?? homeDir(),
      pipSource: this.getConfig().pipSource,
    });
  }

  /**
   * 当前解析到的 Python 运行时（ROADMAP §8.1）。
   *
   * 找不到时 `found: false` 且带上找过的位置 —— 与 `runtimeSource` 同一条纪律：
   * 界面显示「用的是哪一个」，而不是让人去猜为什么没生效。
   */
  pythonRuntime(): RuntimeStatus {
    const resolution = resolvePythonRuntime();
    return {
      found: resolution !== null,
      source: resolution?.source ?? null,
      label: resolution?.label ?? '未找到可用的 Python',
      bin: resolution?.bin ?? null,
      bundledDirs: defaultBundledDirs(),
    };
  }

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
      /** 模型在申请放宽沙箱档位时带上（见 protocol 的 SandboxEscalation） */
      escalation?: SandboxEscalation;
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
      // 升级申请同样原样带过去 —— 它是「用户凭什么判断该不该点头」的全部信息
      escalation: input.escalation,
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
