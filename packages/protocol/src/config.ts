/**
 * 应用设置模型。
 *
 * 这份配置存在 <home>/config.json，是**跨会话**的用户偏好：新建会话的默认模式与模型、
 * 上次用过的工作区、右侧面板停在哪个页签。注意它与 GuardPolicy（guard.json）是两份文件、
 * 两个关注点：config 是「用起来顺不顺手」，guard 是「允许发生什么」。
 * 混在一起会让「改个主题」和「放宽审批」变成同一个动作，那很危险。
 *
 * 读取一律经过 host.getConfig()，它用 DEFAULT_CONFIG 兜底并按字段合并 ——
 * 因此旧版本写下的 config.json 少字段也能正常读出，不需要迁移脚本。
 */

import type { PipSource } from './deploy';
import type { SandboxMode } from './security';
import type { AgentMode } from './session';
import type { ModelPrice } from './usage';

/**
 * 主区视图。
 *
 * 界面从「标题栏横排按钮 + 居中弹窗」改为「左侧活动栏（rail）切换主区视图」之后，
 * 这个字段的含义随之升级为**上次所在的视图**，下次打开就停在同一页。
 *
 * 它取代了旧的 `sidePanel`（none/tree/terminal）：旧语义是「右侧面板开在哪一页」，
 * 而右侧并排面板本身已被 view 里的 `files` / `terminal` 取代表达。
 * getConfig 按字段合并默认值，旧 config.json 缺这个键就走默认 'chat'，无需迁移脚本。
 */
export type AppView =
  | 'chat'
  | 'files'
  | 'terminal'
  | 'browser'
  | 'trajectory'
  | 'skills'
  | 'memory'
  | 'schedules'
  | 'connectors'
  | 'usage'
  | 'settings';

export const APP_VIEW_LABEL: Record<AppView, string> = {
  chat: '对话',
  files: '文件',
  terminal: '终端',
  browser: '浏览器',
  trajectory: '轨迹',
  skills: '技能',
  memory: '记忆',
  schedules: '自动化',
  connectors: '连接器',
  usage: '用量',
  settings: '设置',
};

/**
 * 模型端点。
 *
 * official = DeepSeek 官方（dsh 内置 provider 与模型目录，凭据在 dsh 家目录）。
 * custom  = 任意 OpenAI 兼容端点 —— 局域网 GPUStack / vLLM / SGLang 网关，
 *           或本机 Ollama（:11434/v1）、LM Studio（:1234/v1）。
 *
 * 生效路径（2026-09-13 两轮取证）：host 把它翻译成 dsh 启动补丁
 * （`--patch` 按 id 覆盖 `llm-deepseek` 条目的 baseURL 与 models 目录），
 * 组合期应用、启动即确定，变更需重启内核生效。
 * （曾试过 `$DSH_HOME/settings.yaml` 热重载路径：与 session/new 公布目录
 * 存在实测竞态，弃用。）
 * API key 不进本文件 —— 见宿主 secrets.json 与 dsh 凭据文档的同步逻辑。
 */
export interface ModelEndpoint {
  kind: 'official' | 'custom';
  /** custom 时的端点地址，如 http://127.0.0.1:8000/v1 */
  baseUrl?: string;
  /** custom 时的模型 id（端点上的真实模型名，如 qwen3-8-27b） */
  model?: string;
  /**
   * custom 时的上下文窗口（token）。**必须由用户填**：端点不会在补丁里告诉我们，
   * 而 dsh 的模型目录要求这个字段。不填按 DEFAULT_ENDPOINT_CONTEXT_WINDOW 估计，
   * 界面上如实标注是估计值 —— 写死一个数字当事实正是上一版的问题。
   *
   * 它的实际影响**本轮未证实**：实测端点收到的请求里 `max_tokens` 恒为 256000，
   * 与补丁里填的 131072 不一致，所以「填它就等于控制压缩时机」这句话目前没有证据。
   * 保留这个字段的理由是它确实是配置的一部分、也确实需要用户提供；
   * 但它到底影响什么，等有人真去验一次再说。
   */
  contextWindow?: number;
  /** 端点无需 key 时置 true，凭据写占位值 */
  noApiKey?: boolean;
}

/**
 * 端点连通性测试的结果（`models.testEndpoint` 的返回）。
 *
 * ok 与 error 互斥；models 是端点 `GET /models` 公布的模型 id 清单
 * （端点不给就是空数组，不猜）。httpStatus 在「连上了但回的不是 200」时保留 ——
 * 401 与 404 的处置完全不同，只回一个 ok=false 等于把诊断信息丢掉。
 */
export interface EndpointTestResult {
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  models: string[];
  error?: string;
}

export interface AppConfig {
  theme: 'dark' | 'light';
  /**
   * 内核选择：auto = 有 DEEPWORK_HARNESS_CMD 才用真实内核；mock = 强制 mock；
   * harness = 强制真实内核（失败即报错不降级）。持久化在这里，不用每次设环境变量。
   */
  adapter: 'auto' | 'mock' | 'harness';
  defaultMode: AgentMode;
  /**
   * 新建会话的默认模型。**由用户自行选定**，官方内核公布的模型与自定义端点上的
   * 模型在这里不做区别对待 —— 它是一个模型 id，来源由 modelEndpoint 决定。
   *
   * 空串 = 跟随内核当前默认（session/new 的 currentValue）。刻意留一个「不选」的
   * 取值：以前这里写死 'deepseek-flash'，而内核实际默认是 deepseek-v4-flash，
   * 两个答案都不报错，只有抓端点请求才看得出来用的是哪个。
   */
  defaultModel: string;
  /**
   * 新建会话的默认推理档位（内核的 reasoning_effort）。
   * 空串 = 不干预，用内核默认。取值必须是内核 session/new 公布过的选项值 ——
   * 这里不校验也不枚举：内核换档位表时，写死一份枚举就会变成「界面能选但内核不认」。
   */
  defaultReasoningEffort: string;
  /** 上次使用的工作区；新建会话时优先用它 */
  lastWorkspace: string;
  /** 上次所在的视图；下次启动停在同一页 */
  lastView: AppView;
  /** 终端回滚缓冲上限（字符） */
  terminalBufferLimit: number;
  /** 文件树展开深度 */
  treeDepth: number;
  /** 思考过程默认折叠 */
  collapseReasoning: boolean;
  /** 模型端点（见 ModelEndpoint 注释） */
  modelEndpoint: ModelEndpoint;
  /**
   * 模型单价表（元 / 千 token），供用量面板做费用估算。
   *
   * **刻意不放常量**：模型价格会变，写死在代码里的价格表会以「看起来很精确的
   * 数字」腐烂掉 —— 那种错误没有任何报错，只有算出来的金额是错的。
   * 默认空：估算显示为「未定价」而不是 0，因为 0 会被读成「免费」。
   */
  modelPrices: Record<string, ModelPrice>;
  /**
   * 内网 pip 源（§8.2）。**不设默认值** —— 缺省就是「未配置」，
   * 此时 pip 走它自己的默认源，离线机器上如实报错。
   *
   * 刻意不放进 CONFIG_FIELDS：它是个嵌套对象，设置页有专门的表单与
   * 「测试连通」动作，塞进通用渲染器只会得到一个渲染不出来的输入框。
   */
  pipSource?: PipSource;
  /**
   * 内核沙箱档位（FR-3.5 尾项：把「切换入口」从环境变量搬进设置页）。
   *
   * **不设默认值**：缺省 = 用户没选过，落到产品默认（与内核默认一致）。
   * 刻意不给它写一个 `sandboxMode: 'workspace-write'` 的默认值 —— 那会让
   * 「用户明确选了限定工作区」与「用户从没碰过这一项」变成同一件事，
   * 界面就没法如实区分「你选的」与「产品默认」，而这两句话的下一步动作不同。
   *
   * 生效语义与 modelEndpoint 同类但更硬：档位是**内核进程的启动参数**
   * （见 core-host/src/security/sandbox.ts），存下来只是记下了意图，
   * 必须重启内核才真的换档 —— 所以宿主在 `restartKernel()` 里重新解析一次，
   * 界面据此可以给出「已保存，重启内核后生效」这种诚实的中间态提示。
   *
   * 刻意不放进 CONFIG_FIELDS：它带重启语义与三档后果说明，需要专门的控件，
   * 塞进通用渲染器只会得到一个不知道后果的普通下拉框。
   */
  sandboxMode?: SandboxMode;
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'dark',
  adapter: 'auto',
  defaultMode: 'ptc',
  defaultModel: '',
  defaultReasoningEffort: '',
  lastWorkspace: '',
  lastView: 'chat',
  terminalBufferLimit: 200_000,
  treeDepth: 3,
  collapseReasoning: false,
  modelEndpoint: { kind: 'official' },
  modelPrices: {},
};

/**
 * 自定义端点未填 contextWindow 时的估计值（token）。
 *
 * 它是**估计**而不是事实，界面上必须这么说。dsh 的模型目录 schema 要求这个字段，
 * 不给就连模型都注册不进去，所以只能兜底一个数。但请注意（2026-09-14 实测）：
 * 端点收到的请求里 `max_tokens` 恒为 256000，与这里填多少无关 ——
 * 所以不要声称它「控制压缩时机」，那是没验过的因果。
 */
export const DEFAULT_ENDPOINT_CONTEXT_WINDOW = 131_072;

/** 配置项的取值域，设置面板据此渲染控件；未知键不进设置面板（由实现自行消费） */
export const CONFIG_FIELDS = {
  theme: { kind: 'enum', values: ['dark', 'light'], label: '主题' },
  adapter: { kind: 'enum', values: ['auto', 'mock', 'harness'], label: '内核' },
  defaultMode: { kind: 'enum', values: ['ptc', 'standard', 'minimal', 'creative'], label: '默认模式' },
  defaultModel: { kind: 'string', label: '默认模型（空 = 跟随内核默认）' },
  defaultReasoningEffort: { kind: 'string', label: '默认推理档位（空 = 不干预）' },
  lastView: {
    kind: 'enum',
    values: [
      'chat',
      'files',
      'terminal',
      'trajectory',
      'skills',
      'memory',
      'schedules',
      'connectors',
      'usage',
      'settings',
    ],
    label: '上次所在视图',
  },
  terminalBufferLimit: { kind: 'number', label: '终端缓冲上限（字符）' },
  treeDepth: { kind: 'number', label: '文件树深度' },
  collapseReasoning: { kind: 'boolean', label: '默认折叠思考过程' },
} as const;
