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
 * custom  = 任意 OpenAI 兼容端点 —— 本地 Ollama（:11434/v1）、LM Studio（:1234/v1）、
 *           vLLM 或私有网关；「本地模型、离线运行」战略的落点。
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
  /** custom 时的端点地址，如 http://localhost:11434/v1 */
  baseUrl?: string;
  /** custom 时的模型 id（端点上的真实模型名，如 qwen2.5:7b） */
  model?: string;
  /** 端点无需 key 时（本地 Ollama）置 true，凭据写占位值 */
  noApiKey?: boolean;
}

export interface AppConfig {
  theme: 'dark' | 'light';
  /**
   * 内核选择：auto = 有 DEEPWORK_HARNESS_CMD 才用真实内核；mock = 强制 mock；
   * harness = 强制真实内核（失败即报错不降级）。持久化在这里，不用每次设环境变量。
   */
  adapter: 'auto' | 'mock' | 'harness';
  defaultMode: AgentMode;
  defaultModel: string;
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
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'dark',
  adapter: 'auto',
  defaultMode: 'ptc',
  defaultModel: 'deepseek-flash',
  lastWorkspace: '',
  lastView: 'chat',
  terminalBufferLimit: 200_000,
  treeDepth: 3,
  collapseReasoning: false,
  modelEndpoint: { kind: 'official' },
  modelPrices: {},
};

/** 配置项的取值域，设置面板据此渲染控件；未知键不进设置面板（由实现自行消费） */
export const CONFIG_FIELDS = {
  theme: { kind: 'enum', values: ['dark', 'light'], label: '主题' },
  adapter: { kind: 'enum', values: ['auto', 'mock', 'harness'], label: '内核' },
  defaultMode: { kind: 'enum', values: ['ptc', 'standard', 'minimal', 'creative'], label: '默认模式' },
  defaultModel: { kind: 'string', label: '默认模型' },
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
