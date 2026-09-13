/**
 * 连接器（MCP）契约 —— DeepWork 管清单与 UI，内核管协议。
 *
 * ── 架构选择（为什么不自己实现 MCP 客户端）─────────────────────────
 * 真实内核 dsh 自带 @deepseek-ai/dsh-mcp-client：配置一条 server 记录，
 * 外部 MCP server 的工具就以 `mcp__<serverName>__<tool>` 注册进内核工具
 * 列表（stdio / Streamable HTTP 两种传输）。上层再写一套 MCP 客户端是
 * 重复建设。因此本契约只描述「清单管理」：DeepWork 持久化连接器清单、
 * 在内核（重）启动时把它们叠加成 dsh 插件配置（--patch 层），
 * 连接、发现、重连、工具注册全部在内核进程内完成。
 *
 * ── 状态语义如实 ────────────────────────────────────────────────────
 * ConnectorState.kernelManaged 恒为 true：清单在 DeepWork，连接与工具
 * 注册在内核 —— DeepWork 不知道实时连接状态（连没连上、工具列没列出，
 * 要看内核日志），note 字段如实说明这一点与生效时机。
 * mock 内核没有 MCP 能力，清单照常可管，但不产生任何效果。
 */

/** 连接器名称：会成为内核工具名前缀 mcp__<name>__，同时是清单主键 */
export const CONNECTOR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ConnectorConfig {
  /** 例 'github' → 工具名 mcp__github__create_issue */
  name: string;
  /** stdio 传输：本地可执行程序（本轮只做 stdio；HTTP 传输留作遗留） */
  command: string;
  args?: string[];
  /** 叠加到子进程环境之上的变量（内核侧会合并到清理过的环境上） */
  env?: Record<string, string>;
  enabled: boolean;
}

export interface ConnectorState {
  config: ConnectorConfig;
  /** 恒为 true：连接与工具注册由内核托管，DeepWork 不掌握实时连接状态 */
  kernelManaged: true;
  /** 如实说明生效语义，UI 原样展示 */
  note: string;
}

/**
 * 校验连接器配置，返回人读错误信息；合法返回 null。
 * UI 与宿主共用同一份校验（与 validateScheduleSpec 同一纪律）。
 */
export function validateConnectorConfig(config: ConnectorConfig): string | null {
  if (!config || typeof config !== 'object') return '连接器配置不能为空';
  if (!CONNECTOR_NAME_PATTERN.test(config.name ?? '')) {
    return '名称应为小写字母/数字/中划线（1-32 位，以字母或数字开头）——它会成为工具名前缀 mcp__<名称>__';
  }
  if (!config.command || !config.command.trim()) return '命令不能为空';
  if (config.args !== undefined && !Array.isArray(config.args)) return '参数应为数组';
  if (config.env !== undefined) {
    if (typeof config.env !== 'object' || config.env === null || Array.isArray(config.env)) return '环境变量应为键值表';
    for (const [key, value] of Object.entries(config.env)) {
      if (!key.trim()) return '环境变量名不能为空';
      if (typeof value !== 'string') return `环境变量 ${key} 的值应为字符串`;
    }
  }
  return null;
}

/**
 * 配置 → 状态。note 文案集中在这里（而不是 UI 里），
 * 保证面板、测试与文档看到的是同一句话。
 */
export function connectorStateOf(config: ConnectorConfig): ConnectorState {
  return {
    config,
    kernelManaged: true,
    note: config.enabled
      ? '清单在 DeepWork，连接与工具注册由内核托管：配置将在内核（重）启动后生效，工具以 mcp__' +
        config.name +
        '__ 前缀出现；实时连接状态以内核日志为准。'
      : '已停用：不会注入内核配置；停用与删除同样在内核（重）启动后生效。',
  };
}
