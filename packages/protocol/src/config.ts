/**
 * 应用设置模型。
 *
 * 这份配置存在 <home>/config.json，是**跨会话**的用户偏好：新建会话的默认模式与模型、
 * 上次用过的工作区、上次所在的主区视图与设置分节。注意它与 GuardPolicy（guard.json）
 * 是两份文件、两个关注点：config 是「用起来顺不顺手」，guard 是「允许发生什么」。
 * 混在一起会让「改个主题」和「放宽审批」变成同一个动作，那很危险。
 *
 * 读取一律经过 host.getConfig()，它用 DEFAULT_CONFIG 兜底并按字段合并 ——
 * 因此旧版本写下的 config.json 少字段也能正常读出，不需要迁移脚本。
 */

import type { PipSource } from './deploy';
import type { SandboxMode } from './security';
import type { AgentMode } from './session';
import { DEFAULT_TERMINAL_SHELL, TERMINAL_SHELLS, type TerminalShell } from './terminal';
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
 *
 * ── 这个清单只装「工作台视图」（2026-09-18 两次收窄）────────────────
 * 第一次：`skills` / `memory` / `schedules` / `connectors` / `usage` 一度也是一级
 * 视图，结果是 rail 上「天天点的」与「偶尔来配一次」的入口挨在一起，栏越加越长。
 * 现在它们各自是**设置里的一节**（见 `SettingsSection`）。
 *
 * 第二次（同一轮内）：**设置自己也不再是一个视图**。它从「占满主区的整页」改成了
 * 覆盖层（`.settings-mask` 之上的对话框），理由见 `SettingsSection` 的注释。
 * 判断标准只有一条：**它是不是主区里一个能停下来的页**。设置现在不是 ——
 * 它盖在所有页上面，关掉就回到原来那一页，自己不留位置。
 *
 * 于是 `lastView` 的含义收紧为「下次启动停在工作台的哪一页」，而「上次开着设置」
 * 不再是需要恢复的状态：启动时弹一个对话框出来，用户的第一动作是关掉它。
 *
 * 收窄的代价必须说清 —— 而且这是**两次**都成立的同一条：
 * `config.lastView` 里可能存着旧值（`skills`，或者上一版的 `settings`）。
 * 那种值放过去会让下次启动落到一个没有对应页面的视图上 —— 主区一片空白，
 * 而原因只写在配置文件里。**折回由宿主负责**（`getConfig`），不指望渲染层兜。
 */
export const APP_VIEWS = ['chat', 'files', 'terminal', 'browser', 'trajectory'] as const;

export type AppView = (typeof APP_VIEWS)[number];

export const APP_VIEW_LABEL: Record<AppView, string> = {
  chat: '对话',
  files: '文件',
  terminal: '终端',
  browser: '浏览器',
  trajectory: '轨迹',
};

export function isAppView(value: unknown): value is AppView {
  return typeof value === 'string' && (APP_VIEWS as readonly string[]).includes(value);
}

/**
 * 设置的分节。
 *
 * ── 设置在界面上是「覆盖层」，不是一个视图（2026-09-18）──────────────
 * 它从占满主区的整页改成了居中的对话框：盖住一切，按 Esc / 点遮罩 / 点右上角关闭，
 * 关掉就回到进来之前那一页 —— 它自己不留位置。
 *
 * 因此这里**不需要**回答「它是哪一页」（那是 `AppView` 的事，而设置已经不在里面）；
 * 这一层要回答的是「打开设置时停在哪一节」。两个状态必须分开：
 * 「开着没有」是渲染层的临时状态、**不落盘**（落盘的后果是每次启动都弹一个对话框
 * 出来，而用户的第一动作是关掉它）；「上次停在哪一节」落盘，否则用户每次回来
 * 都要在左导航十二节里重新找一遍。
 *
 * 尺寸上的取舍也记在这里：对话框宽 880 / 高 600，窗口更小就按窗口缩。
 * 管理类内容（技能几十条、用量带图表）在这个宽度里够用，而「比整页小一圈」
 * 换来的是**它一眼就是盖上去的一层**，而不是又一个页面。
 *
 * ── 分节与分组是两个关注点 ──────────────────────────────────────────
 * `SETTINGS_SECTIONS` 是**每一节是什么**（取值域，配置里存的就是它），
 * `SETTINGS_GROUPS` 是**导航怎么排版**（哪几节挨在一起、组标题写什么）。
 * 左导航、页头副标题、以及「打开设置并定位到某一节」三个地方共用这两份 ——
 * 组标题一旦写进 JSX，第二天就会长出第二份清单，然后两份不一致。
 *
 * ── 顺序有含义：从「我用起来顺不顺手」到「这台机器上允许发生什么」──
 * 排在前面的改动立刻看得见（外观），排在后面的一改就要重启内核甚至动系统（部署）。
 * 把「审批与沙箱」压到后面不是不重视它，而是**它不该被顺手改掉**：
 * 混在偏好里，用户会把它当成又一个开关。
 */
export const SETTINGS_SECTIONS = [
  'appearance',
  'session',
  'interface',
  'model',
  'skills',
  'memory',
  'schedules',
  'connectors',
  'security',
  'usage',
  'deploy',
  'about',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface SettingsGroup {
  id: string;
  label: string;
  sections: readonly SettingsSection[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'general', label: '通用', sections: ['appearance', 'session', 'interface'] },
  { id: 'model', label: '模型', sections: ['model'] },
  { id: 'manage', label: '功能与数据', sections: ['skills', 'memory', 'schedules', 'connectors', 'usage'] },
  { id: 'safety', label: '安全与部署', sections: ['security', 'deploy', 'about'] },
];

export const SETTINGS_SECTION_LABEL: Record<SettingsSection, string> = {
  appearance: '外观',
  session: '会话默认',
  interface: '界面与终端',
  model: '模型与端点',
  skills: '技能',
  memory: '记忆',
  schedules: '自动化',
  connectors: '连接器',
  security: '审批与沙箱',
  usage: '用量',
  deploy: '部署与运行时',
  about: '关于',
};

/** 每一节「管什么」的一句话（设置页页头副标题）。写事实，不写形容词。 */
export const SETTINGS_SECTION_NOTE: Record<SettingsSection, string> = {
  appearance: '主题与思考过程的默认折叠方式；都立刻生效。',
  session: '新会话起步用什么模式、哪个模型、多高的推理档位。',
  interface: '文件树与终端的形态。终端这一档决定你敲的命令由谁解释。',
  model: '推理能力从哪来：内核选择、端点、API key。改动需重启内核。',
  skills: '已安装的技能、来源审计与逐条的启用开关。',
  memory: '内核会持续读写的长期记忆，分用户级 / 工作区级 / 会话级三层。',
  schedules: '定时任务：到点由内核另起一轮会话，只在应用运行期间生效。',
  connectors: 'MCP 连接器清单：给内核挂上外部工具与数据源。',
  security: '允许发生什么：内核沙箱、审批档位、硬拒绝模式。',
  usage: '跨会话的 token 与费用账本，以及模型单价表。',
  deploy: '随包 Python 运行时、内网 pip 源与安装前环境体检。',
  about: '这台机器上实际跑着哪些东西。',
};

export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'appearance';

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

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
 * 端点探测失败的**根因分类**。
 *
 * ── 为什么要有这个枚举，而不是从 error 字符串里认 ────────────────────
 * `testEndpoint` 的每一句 error 都是在**它构造失败的那一刻**写下的，那里
 * 恰好是唯一确切知道根因的地方。事后拿字符串去正则匹配，等于把「知道的事」
 * 降级成「猜的事」—— 改一个错字就会让分类静默失效，而失效的表现是
 * 「提示里说得含含糊糊」（或更糟：把「key 无效」说成「服务没起」，
 * 用户去重启一个本来好好的服务）。本项目在别处栽过同类跟头
 * （用全文搜索断言，被注释里的路径绊倒）。
 *
 * 四个值对应排障时**下一步动作完全不同**的四类：
 *  - `invalid-url`：地址本身不合规 —— 改配置，不用查网络；
 *  - `unreachable`：连不上 —— 查服务是否在跑、网络与防火墙；
 *  - `auth`：连上了但凭据被拒 —— 换 key；
 *  - `not-found`：连上了但路径不对（多半少了 `/v1`）—— 改地址后缀；
 *  - `bad-response`：连上了、应答异常 —— 去看端点侧日志；
 *  - `not-json`：连上了、但不是 OpenAI 兼容端点 —— 换端点。
 */
export type EndpointFailureKind =
  | 'invalid-url'
  | 'unreachable'
  | 'auth'
  | 'not-found'
  | 'bad-response'
  | 'not-json';

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
  /**
   * 失败根因分类（ok 为 true 时不带）。
   *
   * 由 `testEndpoint` 在构造失败的那一刻填 —— **不是**从 error 字符串反推的，
   * 所以它比 error 文本可靠：文本给人读、可能被改写，这个字段给代码分支用。
   * 端点不可达时的开跑提示（FR-10.2 后半）就靠它决定说哪一句话。
   */
  kind?: EndpointFailureKind;
}

/**
 * 主题档位。
 *
 * ── 为什么加 'system' 而不是只留 light/dark ─────────────────────────
 * 「跟随系统」是唯一一个**不需要用户再管**的档位：系统在日落时切深色，
 * 用户不必回来改一次设置。两个固定值做不到这件事，而它是设置页里
 * 成本最低、收益最直接的一项。
 *
 * 代价是它把「用户选了什么」与「现在实际是什么」分开了：'system' 本身
 * 不是一个可渲染的颜色方案，必须结合系统偏好解析成 light/dark 才谈得上生效。
 * 所以解析函数 resolveTheme 与档位清单同住契约层 —— 界面、测试与
 * 未来的其它渲染入口（托盘图标、预览窗口）必须用同一份解析，
 * 否则「跟随系统」在某个窗口里会静默变成永远浅色。
 */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 合法档位，顺序即设置页展示顺序（固定值在前，跟随系统在最后） */
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

/** 主题档位判定 —— 白名单只此一处（启动 / 配置校验 / 界面回填共用） */
export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/**
 * 把档位解析成**实际要渲染的方案**。
 *
 * `prefersDark` 由调用方从渲染环境取（浏览器是 matchMedia，测试直接传值）——
 * 不在这里读全局，是因为这个函数要能在没有 window 的地方跑（宿主、
 * 打包期校验、Node 里的测试），而读全局会让它只在浏览器里可测。
 */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): 'light' | 'dark' {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

export interface AppConfig {
  /**
   * 主题档位。
   *
   * 默认 `light` —— 与当前实际渲染一致。这个字段自 M0 起就存在，但**从未被
   * 任何代码消费过**（2026-09-17 接切换器时发现）：它此前是 `'dark' | 'light'`
   * 且默认 `'dark'`，而界面一直渲染浅色。也就是说，一旦有人开始读它，
   * 默认值会立刻把界面翻成深色 —— 那不是「实现了主题」，那是改了一个
   * 从没生效过的默认值引发的视觉变更。默认值随实现一起修正为 `light`，
   * 保持读者看到的东西与以前一致。
   */
  theme: ThemeMode;
  /**
   * 终端 shell 档位（默认 `powershell`）。
   *
   * 从 `cmd` 改成 `powershell` 是一次**可见的默认值变更**，与 theme 那次的处理
   * 同理：默认值一旦开始被消费就立刻生效，所以默认与实现必须同时落地，
   * 不能先留一个「以后再说」的旧默认，否则界面上会出现一个没人解释过的差异。
   *
   * 三档的能力边界写在 `terminal.ts` 的 `TERMINAL_SHELL_NOTE` 里，设置页直接引用 ——
   * 「选哪一档」的依据是「要敲什么命令」，那句话必须与档位同住契约层，
   * 界面各写一份的话，两者会各自腐烂。
   *
   * 生效语义与 terminalBufferLimit 同类：**下一次执行命令时生效**，
   * 不需要重启内核（终端是宿主里的进程，内核不参与）。
   */
  terminalShell: TerminalShell;
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
  /**
   * 设置上次所在的分节。
   *
   * 与 lastView 同类（下次打开停在同一页），但语义上比它多一层：设置现在是覆盖层，
   * 「开着没有」不落盘，**「上次停在哪一节」落盘** —— 这两件事必须分开。
   * 前者落盘的后果是每次启动都弹一个设置对话框出来；后者不落盘的后果是
   * 用户每次回来都要在左导航十二节里重新找一遍。
   *
   * 刻意不放进 `CONFIG_FIELDS`：它的入口是设置里的左导航（与 railExpanded 同理），
   * 塞进通用渲染器只会多一个没人会去找的下拉框。
   */
  settingsSection: SettingsSection;
  /** 终端回滚缓冲上限（字符） */
  terminalBufferLimit: number;
  /** 文件树展开深度 */
  treeDepth: number;
  /** 思考过程默认折叠 */
  collapseReasoning: boolean;
  /**
   * 左侧活动栏是否展开显示文字标签。
   *
   * 收起时是 56px 纯图标栏（悬停出提示），展开后图标旁带功能名。
   * 默认展开：图标的语义要靠使用者的先验知识，纯图标栏的「认不出哪个是哪个」
   * 是手动调试期真实出现的反馈；收起入口留在栏底的切换按钮上。
   */
  railExpanded: boolean;
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
  /**
   * 按**会话模式**指定模型（FR-10.2 后半：快模型 / 推理模型分工）。
   *
   * 例：`{ minimal: 'qwen3-8-flash', ptc: 'qwen3-8-27b' }` —— 轻问答走小模型，
   * 要动代码的走大模型。留空的模式落到 `defaultModel`。
   *
   * ── 为什么按「模式」而不是按「猜任务难度」──────────────────────────
   * 「按任务挑模型」最直觉的做法是分类用户输入（长短、有没有代码块、关键词…），
   * 但那是一条**没有真值**的规则：判错时用户只会看到「这轮怎么换了个模型」，
   * 既不知道为什么，也无从纠正。而会话模式是用户自己显式选的、意义明确、
   * 且已经存在于产品里 —— 用它做路由，规则是可见的、可测的、错了能自己改。
   *
   * 代价要说清楚：**映射在新建会话时生效**，会话建好之后改模式不会自动换模型
   * （在对话中途静默换模型比不换更糟）。会话建好后要换模型，用会话自己的模型
   * 选择器 —— 那一次是用户显式的动作。
   */
  modeModels?: Partial<Record<AgentMode, string>>;
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'light',
  // 与 DEFAULT_TERMINAL_SHELL 同源引用，不各写一份 'powershell' 字面量
  terminalShell: DEFAULT_TERMINAL_SHELL,
  adapter: 'auto',
  defaultMode: 'ptc',
  defaultModel: '',
  defaultReasoningEffort: '',
  lastWorkspace: '',
  lastView: 'chat',
  settingsSection: DEFAULT_SETTINGS_SECTION,
  terminalBufferLimit: 200_000,
  treeDepth: 3,
  collapseReasoning: false,
  railExpanded: true,
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
  theme: { kind: 'enum', values: ['light', 'dark', 'system'], label: '主题' },
  adapter: { kind: 'enum', values: ['auto', 'mock', 'harness'], label: '内核' },
  defaultMode: { kind: 'enum', values: ['ptc', 'standard', 'minimal', 'creative'], label: '默认模式' },
  defaultModel: { kind: 'string', label: '默认模型（空 = 跟随内核默认）' },
  defaultReasoningEffort: { kind: 'string', label: '默认推理档位（空 = 不干预）' },
  lastView: { kind: 'enum', values: APP_VIEWS, label: '上次所在视图' },
  terminalBufferLimit: { kind: 'number', label: '终端缓冲上限（字符）' },
  terminalShell: { kind: 'enum', values: TERMINAL_SHELLS, label: '终端 shell' },
  treeDepth: { kind: 'number', label: '文件树深度' },
  collapseReasoning: { kind: 'boolean', label: '默认折叠思考过程' },
} as const;
