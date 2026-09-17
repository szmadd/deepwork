/**
 * 壳层（Electron 主进程）↔ 内核宿主（core-host）之间的 JSON-RPC 契约。
 *
 * 传输：子进程 stdio，行分隔 JSON（NDJSON），单行一个消息。
 * 安全：主进程与 core-host 同机、同用户、走管道，无需回环端口与 token；
 *      回环 + 一次性 token 只用于 core-host 访问更下游的真实 Harness（见 harness-sidecar.ts）。
 */

import type { AppConfig, EndpointTestResult } from './config';
import type { BrowserShotImage, BrowserShotInfo, BrowserState } from './browser';
import type { PreflightReport, RuntimeStatus } from './deploy';
import type { BranchCompareResult } from './diff';
import type { AgentEvent } from './events';
import type { MemoryEntry, MemoryLayer, MemoryLayerStat } from './memory';
import type { ConnectorConfig, ConnectorState } from './mcp';
import type { ScheduleSpec, ScheduleTask } from './schedule';
import type { ApprovalDecision, GuardPolicy, SandboxStatus } from './security';
import type { AgentMode, ForkOrigin, ModelCatalog, Session } from './session';
import type { SkillAuditReport, SkillInstallResult, SkillRecord } from './skills';
import type { TerminalChunk, TerminalState } from './terminal';
import type { UsageSummary } from './usage';
import type { FilePreview, WorkspaceTree } from './workspace';

export interface HostStatus {
  adapter: 'mock' | 'harness';
  /** 配置里的内核选择（auto/mock/harness），与当前实际运行的 adapter 是两回事 */
  adapterMode: 'auto' | 'mock' | 'harness';
  /** 真实内核凭据是否已配置（dsh 家目录下 .credentials.yaml 存在） */
  credentialsConfigured: boolean;
  version: string;
  pid: number;
  home: string;
  /** 宿主启动时的默认工作区，新建会话默认使用它 */
  workspace: string;
  nodeVersion: string;
  capabilities: string[];
  guard: GuardPolicy;
  /**
   * 内核进程**启动时**带着的模型端点（routing 指纹：`official` 或 `custom:<baseUrl>`）。
   *
   * 端点在启动的组合期才进补丁，所以它与 `config.modelEndpoint` 是两回事：改了端点
   * 不重启内核，配置是新的、内核还是旧的。这跟 `adapterMode` / `adapter` 那一对
   * 是同一类差别。还没起过内核时它等于配置值 —— 那时没有「旧内核」可言。
   */
  kernelEndpoint: string;
  /**
   * **配置里现在写的**端点（同一套指纹）。两个值都由宿主给出，界面只做相等比较 ——
   * 让渲染层自己再实现一遍指纹算法的话，两处迟早不同步，而不一致的那天没有人会看到。
   */
  configEndpoint: string;
  /**
   * 内核沙箱实际生效的文件策略模式。
   *
   * `guard` 与它是**互不相同**的两件事：`guard` 决定「哪些命令要问人」（宿主侧静态
   * 规则），`sandbox` 决定「命令能不能写成文件」（内核侧强制执行）。真实内核下
   * 模型的命令在内核里跑、不过宿主，所以 `guard` 对它们不生效 —— 挡住越界写入的
   * 一直是这个沙箱。界面必须把两者分开说，否则用户以为自己在设置里调的档位
   * 就是拦下写入的那道闸。
   *
   * 模式只在启动内核时定得下来（ACP 面没有它的运行时切换），所以这里是
   * 「内核带着什么起来的」，粒度是进程而不是会话 —— 与 `kernelEndpoint` 同一形态。
   */
  sandbox: SandboxStatus;
}

export interface ModelApiKeyStatus {
  /** 是否已设置 key（只看存在性，不看内容） */
  set: boolean;
  /** 掩码形式（sk-****1234），未设置为 undefined；明文永不离开宿主 */
  masked?: string;
}

export interface CreateSessionParams {  workspace: string;
  title?: string;
  mode?: AgentMode;
  model?: string;
}

export interface SendParams {
  sessionId: string;
  text: string;
  mode?: AgentMode;
  model?: string;
  /** 附件绝对路径列表 */
  attachments?: string[];
}

export interface SendResult {
  runId: string;
}

export interface ForkSessionParams {
  sessionId: string;
  /**
   * 分叉点：父会话里某条事件的 seq，继承到**那一条为止**（逐事件分叉）。
   * 省略表示「从末尾分叉」。落在两个事件之间时取不晚于它的最近事件，
   * 并在结果 `from.requestedSeq` 与 `from.atSeq` 的差异里如实保留。
   *
   * 注意继承的是**记录**不是模型上下文：新会话的续跑不会把这段历史带给模型
   * （见 host.forkSession 的注释）。界面上的措辞必须与此一致。
   */
  atSeq?: number;
}

export interface ForkSessionResult {
  session: Session;
  /** 实际采用的分叉点与继承条数（可能与请求不同，见 ForkOrigin.requestedSeq） */
  from: ForkOrigin;
}

/** 方法名 → { 入参, 返回 } */
export interface RpcContract {
  'host.status': { params: Record<string, never>; result: HostStatus };
  'config.get': { params: Record<string, never>; result: AppConfig };
  'config.set': { params: { patch: Partial<AppConfig> }; result: AppConfig };
  'guard.get': { params: Record<string, never>; result: GuardPolicy };
  'guard.set': { params: { policy: Partial<GuardPolicy> }; result: GuardPolicy };
  /**
   * 模型目录。
   *
   * 权威来源是内核 `session/new` 公布的 configOptions 真帧 —— 只要能用真实内核，
   * 这里返回的就是内核实际提供的模型与推理档位，而不是本机写死的一份清单。
   * 拿不到真帧时返回空 models 并在 note 里说明原因，**绝不回退到一份自编的官方清单**：
   * 那种回退会让「界面显示官方模型名、实际跑的是别的模型」永远不会被发现。
   *
   * `models.refresh` 强制重新取帧（会新建一个探针会话，用完即关），
   * 用于「我刚在端点上换完模型，现在核对一下」。
   */
  'models.list': { params: Record<string, never>; result: ModelCatalog };
  'models.refresh': { params: Record<string, never>; result: ModelCatalog };
  /**
   * 端点连通性测试：对 `GET {baseUrl}/models` 发一次真实请求，回延迟、HTTP 状态与
   * 端点公布的模型清单。给设置页的「测试连接」用 —— 填完端点先测一下，
   * 而不是等一轮对话发出去才知道通不通。baseUrl 用界面上的未保存值，
   * key 优先级：显式参数 > 宿主已存的 custom key > 无。
   */
  'models.testEndpoint': { params: { baseUrl: string; apiKey?: string }; result: EndpointTestResult };
  /**
   * 模型 API key 管理。
   *
   * key 与 config 分文件存放（secrets.json），且**永远不通过 RPC 返回明文** ——
   * 渲染层只能拿到掩码（sk-****1234）与「是否已设置」。key 是渲染层唯一不该
   * 看见原文的数据：它被截图、被日志记录的概率远高于内核进程。
   */
  'model.apiKey.status': { params: Record<string, never>; result: ModelApiKeyStatus };
  'model.apiKey.set': { params: { key: string }; result: ModelApiKeyStatus };
  'model.apiKey.clear': { params: Record<string, never>; result: ModelApiKeyStatus };
  'session.list': { params: Record<string, never>; result: Session[] };
  'session.create': { params: CreateSessionParams; result: Session };
  'session.rename': { params: { sessionId: string; title: string }; result: Session };
  'session.delete': { params: { sessionId: string }; result: { ok: true } };
  'session.events': { params: { sessionId: string }; result: AgentEvent[] };
  'session.fork': { params: ForkSessionParams; result: ForkSessionResult };
  /** 分支对比：两条会话各自对文件的改动（不要求它们有血缘，见 host.compareBranches） */
  'session.compareBranches': { params: { leftId: string; rightId: string }; result: BranchCompareResult };
  'run.send': { params: SendParams; result: SendResult };
  'run.abort': { params: { runId: string }; result: { ok: boolean } };

  /**
   * 工作区视图。
   * 只做只读列举与预览，不做任何写操作 —— 这条边界让「看一眼」永远不会改变磁盘状态。
   */
  'fs.tree': { params: { sessionId: string; path?: string; depth?: number }; result: WorkspaceTree };
  'fs.preview': { params: { sessionId: string; path: string }; result: FilePreview };

  /**
   * 内置终端。
   * 终端按会话隔离：一个会话对应一个 cwd 与一份命令历史，
   * 这样「切到某个项目的会话」与「在那个目录下敲命令」是同一件事。
   */
  'terminal.open': { params: { sessionId: string }; result: TerminalState };
  'terminal.run': { params: { sessionId: string; command: string }; result: { entryId: string } };
  'terminal.write': { params: { sessionId: string; data: string }; result: { ok: boolean } };
  'terminal.interrupt': { params: { sessionId: string }; result: { ok: boolean } };
  'terminal.close': { params: { sessionId: string }; result: { ok: true } };

  'approval.respond': {
    params: {
      requestId: string;
      decision: ApprovalDecision;
      persist?: boolean;
      /** 逐 hunk 授权时被采纳的 hunk 下标；省略表示整体授权 */
      hunks?: number[];
    };
    result: { ok: boolean };
  };

  /**
   * 技能系统。
   *
   * 安装流程 = 审计先行：critical 发现直接拒绝（源不进家目录），
   * warn/info 留档。`skills.audit` 允许先「干跑审计」再决定装不装。
   * 技能是别人写的指令，审计是不可协商的安装前置 —— 与写工具过审批网关
   * 是同一条纪律：先看见，再发生。
   */
  'skills.list': { params: Record<string, never>; result: SkillRecord[] };
  'skills.install': { params: { source: string }; result: SkillInstallResult };
  'skills.uninstall': { params: { name: string }; result: { ok: boolean } };
  'skills.audit': { params: { source: string }; result: SkillAuditReport };
  'skills.toggle': { params: { name: string; enabled: boolean }; result: SkillRecord };

  /**
   * 三层记忆系统。
   *
   * 写入是显式动作：UI 面板写入、宿主侧 run 结束后追加当日日志；
   * 内核自动写记忆依赖 MCP 工具暴露，属 M2-G。
   * 用户级与工作区精选有总字符预算，超限的 memory.add 会被拒绝并给出可行动原因，
   * 而不是静默丢弃或截断 —— 「记下了多少」永远由 MemoryLayerStat 如实呈现。
   */
  'memory.list': { params: { layer?: MemoryLayer; workspace?: string }; result: MemoryEntry[] };
  'memory.add': {
    params: { layer: MemoryLayer; text: string; workspace?: string };
    result: MemoryEntry;
  };
  'memory.remove': { params: { id: string }; result: { ok: boolean } };
  'memory.stats': { params: { workspace?: string }; result: MemoryLayerStat[] };
  'memory.setProfile': { params: { text: string }; result: { ok: boolean } };

  /**
   * 自动化调度。
   *
   * 调度只在应用运行期间生效（桌面应用没有常驻守护进程），错过的时间不补跑。
   * schedule.runNow 与定时触发走同一条路径（同样的技能/记忆注入与审批网关），
   * 只是不改动任务的启用状态与 nextRunAt。
   */
  'schedule.list': { params: Record<string, never>; result: ScheduleTask[] };
  'schedule.add': {
    params: { title: string; prompt: string; workspace: string; spec: ScheduleSpec };
    result: ScheduleTask;
  };
  'schedule.remove': { params: { id: string }; result: { ok: boolean } };
  'schedule.toggle': { params: { id: string; enabled: boolean }; result: ScheduleTask };
  'schedule.runNow': { params: { id: string }; result: { runId: string } };

  /**
   * 连接器管理（MCP，需求文档 §4.5 的内核工具通道）。
   *
   * 只管理清单：连接、工具发现与注册由内核托管（dsh 自带的 dsh-mcp-client
   * 插件）。清单变更只影响下一次内核启动 —— 生效语义如实由
   * ConnectorState.note 呈现，配合 kernel.restart 手动重启内核。
   * mock 内核没有 MCP 能力：清单照常可管，但不产生任何效果。
   */
  'connectors.list': { params: Record<string, never>; result: ConnectorState[] };
  'connectors.add': { params: { config: ConnectorConfig }; result: ConnectorState };
  'connectors.remove': { params: { name: string }; result: { ok: boolean } };
  'connectors.toggle': { params: { name: string; enabled: boolean }; result: ConnectorState };

  /**
   * 重启内核进程（停止当前适配器并重新拉起）。
   * 连接器清单变更后需要它才能生效；返回重启后的宿主状态。
   * 重启失败如实报错，不静默降级。
   */
  'kernel.restart': { params: Record<string, never>; result: HostStatus };

  /**
   * 浏览器自动化（CDP 驱动系统 Edge/Chrome，见 browser.ts）。
   *
   * 这三个方法供 **UI 面板**使用：`browser.open` 是「用户亲手输入 URL 打开网页」，
   * 属于用户自己的动作，不走审批。
   *
   * Agent 侧的六个动作（navigate / content / click / type / evaluate / screenshot）
   * **不在**这张表里：它们要么走宿主工具注册表，要么走内核加载的 MCP 服务，
   * 两条路径都在模型侧、都必须过审批网关。把模型能调用的动作放进 UI 的 RPC 白名单，
   * 等于给出一条绕过审批的旁路 —— 界面能做的事和模型能做的事授权语义不同，
   * 合并它们会让「审批」这个唯一的闸门失去意义。
   */
  'browser.state': { params: Record<string, never>; result: BrowserState };
  'browser.open': { params: { url: string }; result: BrowserState };
  'browser.close': { params: Record<string, never>; result: { ok: true; message: string } };

  /**
   * 用量聚合（M2-J）。
   *
   * **只读聚合，不新建存储** —— 数据来自既有会话存储（meta.usage 与日志里的
   * usage 事件）。再存一份「用量表」等于同一件事有两个事实来源，必然漂移，
   * 而且漂移出问题时没有任何一方是权威。
   *
   * 参数为空是刻意的：不做「最近 N 天」过滤。过滤只发生在渲染层的图表上，
   * 汇总与分组恒为全量 —— 否则「按日分组的合计」会与 totals 不等，
   * 那条一致性等式就此失效（见 usage.ts 顶部注释）。
   */
  'usage.summary': { params: Record<string, never>; result: UsageSummary };

  /**
   * 部署与运行时（ROADMAP §八）。
   *
   * `runtime.preflight` 用的就是安装体检那一份实现（core-host/src/runtime/preflight.ts）——
   * 设置页里的报告与安装器里的报告**必须是同一个东西**，否则「装的时候说没事、
   * 用起来才发现缺东西」会变成常态，而两份实现的分歧没有任何机制能发现。
   *
   * `runtime.python` 如实回报当前解析到哪个 Python（随包 / 系统 / 显式指定），
   * 与 `runtimeSource` 同一条纪律：界面显示「用的是哪一个」，不让人去猜。
   */
  'runtime.preflight': { params: { writeDir?: string }; result: PreflightReport };
  'runtime.python': { params: Record<string, never>; result: RuntimeStatus };
}

export type RpcMethod = keyof RpcContract;
export type RpcParams<M extends RpcMethod> = RpcContract[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcContract[M]['result'];

/**
 * core-host → 客户端 的通知（不需要应答）。
 *
 * 两条通道刻意分开：
 *  - `event`    会话事件流。幂等、可回放、逐条落盘，是会话的唯一事实来源。
 *  - `terminal` 终端字节流。高频、易失、不落盘，只服务于「正在看的那块屏幕」。
 * 混成一条的话，要么日志被终端输出刷爆，要么终端得为「可回放」付出完全没必要的代价。
 */
export interface AgentEventNotification {
  jsonrpc: '2.0';
  method: 'event';
  params: AgentEvent;
}

export interface TerminalNotification {
  jsonrpc: '2.0';
  method: 'terminal';
  params: TerminalChunk;
}

export type RpcNotification = AgentEventNotification | TerminalNotification;

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  jsonrpc: '2.0';
  id: number;
  method: M;
  params: RpcParams<M>;
}

export interface RpcSuccess<M extends RpcMethod = RpcMethod> {
  jsonrpc: '2.0';
  id: number;
  result: RpcResult<M>;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccess | RpcFailure;

export const RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/** Electron IPC 通道名（主进程 ↔ 渲染层） */
export const IPC = {
  /** 渲染层 → 主进程：统一调用入口 */
  INVOKE: 'deepwork:invoke',
  /** 渲染层 → 主进程：宿主运行时信息（Node / Electron 版本来源） */
  RUNTIME: 'deepwork:invoke:runtime',
  /** 主进程 → 渲染层：事件推送 */
  EVENT: 'deepwork:event',
  /** 主进程 → 渲染层：终端数据推送 */
  TERMINAL: 'deepwork:terminal',
  /** 主进程 → 渲染层：宿主状态变化 */
  HOST_STATE: 'deepwork:host-state',
  /**
   * 渲染层 → 主进程：弹出系统目录选择框，返回所选绝对路径（取消返回 null）。
   *
   * 这条通道不走 core-host：选目录是纯壳层能力，渲染层在 sandbox 下拿不到 dialog。
   * 因此它必须在主进程白名单里单独列出，而不是混进 RPC 方法表。
   */
  PICK_WORKSPACE: 'deepwork:pick-workspace',
  /**
   * 渲染层 → 主进程：多选文件作为附件，返回绝对路径数组。
   *
   * 附件在**工作区之外**（用户从桌面随手拖一份日志进来是常态），
   * 所以它不能走 core-host 的工作区边界，只能由壳层处理；
   * 而「壳层能读任意路径」又太宽，因此配套了 PREVIEW_ATTACHMENT 的已选白名单，
   * 见 main.js 的 attachmentAllowlist。
   */
  PICK_ATTACHMENTS: 'deepwork:pick-attachments',
  PREVIEW_ATTACHMENT: 'deepwork:preview-attachment',
  /**
   * 渲染层 → 主进程：列出 / 读取浏览器截图。
   *
   * 截图落在 `<home>/browser-shots/` 下 —— 与附件同理，它在工作区之外，
   * 走不了 core-host 的工作区边界，只能由壳层处理。但白名单比附件更窄：
   * 附件是「用户亲手选过的文件」，截图是「只需要读这一个目录里的 .png」。
   * 后者不依赖用户的任何一次点击，所以必须由路径本身收窄 ——
   * 否则渲染层被注入脚本后能读到的就是整个磁盘。
   */
  BROWSER_SHOTS: 'deepwork:browser-shots',
  BROWSER_SHOT_READ: 'deepwork:browser-shot-read',
} as const;

export interface AttachmentPreview {
  path: string;
  name: string;
  size: number;
  /** 文本内容；二进制或读取失败时为空串 */
  text: string;
  binary: boolean;
  truncated: boolean;
  error?: string;
}

export type HostState = 'starting' | 'ready' | 'restarting' | 'stopped';
