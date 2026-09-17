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

/**
 * 传输形态。
 *
 * ── 为什么现在补上 http（M2-G 遗留）──────────────────────────────────
 * 原设计只做 stdio（本机拉起一个子进程），理由是「局域网 MCP 场景还没出现」。
 * 它出现了：内网里跑着的 MCP 服务通常是一个**已经在别的机器上监听的地址**，
 * 而不是本机的一个可执行文件 —— 没有 http 传输，就只能在那台机器上也装一份
 * DeepWork，而这恰恰是部署形态最不可能允许的事。
 *
 * 取值用 `http` 而不是照抄内核的 `streamable-http`：前者是用户能理解的词
 * （「一个地址」），后者是实现名的细节。两者的映射只写一处（dshTransportOf），
 * 免得每个调用方各自记一遍。
 */
export type ConnectorTransport = 'stdio' | 'http';

export const CONNECTOR_TRANSPORTS: readonly ConnectorTransport[] = ['stdio', 'http'];

export const CONNECTOR_TRANSPORT_LABEL: Record<ConnectorTransport, string> = {
  stdio: '本地进程（stdio）',
  http: '网络地址（Streamable HTTP）',
};

/**
 * 读出一个连接器的传输形态。
 *
 * 缺省 stdio 而不是报错：`transport` 是后加的字段，之前写下的 connectors.json
 * 里没有它 —— 而那些清单写的就是 stdio（当时唯一形态）。所以「缺省 = stdio」
 * 是**如实**的默认，不是猜。
 */
export function connectorTransportOf(config: Pick<ConnectorConfig, 'transport'>): ConnectorTransport {
  return config.transport === 'http' ? 'http' : 'stdio';
}

/**
 * 本产品的传输名 → 内核（@deepseek-ai/dsh-mcp-client）的传输名。
 *
 * 两个概念的边界在这里收口：上层只说 http / stdio，转换只在这一处发生。
 * 散在调用方的后果是「内核换了字段名，而界面上仍显示 http」。
 */
export function dshTransportOf(transport: ConnectorTransport): 'stdio' | 'streamable-http' {
  return transport === 'http' ? 'streamable-http' : 'stdio';
}

export interface ConnectorConfig {
  /** 例 'github' → 工具名 mcp__github__create_issue */
  name: string;
  /** 传输形态，缺省 stdio（见 connectorTransportOf） */
  transport?: ConnectorTransport;
  /** stdio 传输：本地可执行程序 */
  command?: string;
  args?: string[];
  /** 叠加到子进程环境之上的变量（内核侧会合并到清理过的环境上）；stdio 专用 */
  env?: Record<string, string>;
  /** http 传输：MCP 服务地址，如 http://192.168.1.20:3000/mcp */
  url?: string;
  /**
   * http 传输：附加请求头（如 `Authorization`）。
   *
   * **会明文写进 connectors.json 与内核补丁文件**（内核读它才能带上去）。
   * 界面上必须说出这件事：这里不适合放会过期的短期令牌，也不是密钥保险箱
   * （真正的密钥走宿主 secrets 那一套）。
   */
  headers?: Record<string, string>;
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
 *
 * 按传输分别校验：stdio 要 command，http 要 url。两者的必填项不同 ——
 * 拿「command 必填」去套 http，会让 http 连接器永远存不下去，
 * 而用户填的地址明明是对的。
 */
export function validateConnectorConfig(config: ConnectorConfig): string | null {
  if (!config || typeof config !== 'object') return '连接器配置不能为空';
  if (!CONNECTOR_NAME_PATTERN.test(config.name ?? '')) {
    return '名称应为小写字母/数字/中划线（1-32 位，以字母或数字开头）——它会成为工具名前缀 mcp__<名称>__';
  }
  if (config.transport !== undefined && !(CONNECTOR_TRANSPORTS as readonly string[]).includes(config.transport)) {
    return `传输形态「${String(config.transport)}」不是合法值（合法值：${CONNECTOR_TRANSPORTS.join(' / ')}）`;
  }

  if (connectorTransportOf(config) === 'http') {
    const url = (config.url ?? '').trim();
    if (!url) return '网络传输需要填服务地址（如 http://192.168.1.20:3000/mcp）';
    if (!/^https?:\/\//i.test(url)) return '服务地址需要以 http:// 或 https:// 开头';
  } else if (!config.command || !config.command.trim()) {
    return '本地传输需要填命令（如 npx 或某个可执行文件的绝对路径）';
  }

  if (config.args !== undefined && !Array.isArray(config.args)) return '参数应为数组';
  return validateStringRecord(config.env, '环境变量') ?? validateStringRecord(config.headers, '请求头');
}

/** 键值表的形状校验（env 与 headers 共用；两处各写一遍必然有一处会漏） */
function validateStringRecord(
  value: Record<string, string> | undefined,
  label: string,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${label}应为键值表`;
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim()) return `${label}名不能为空`;
    if (typeof item !== 'string') return `${label} ${key} 的值应为字符串`;
  }
  return null;
}

/**
 * 配置 → 状态。note 文案集中在这里（而不是 UI 里），
 * 保证面板、测试与文档看到的是同一句话。
 *
 * note 按传输分开说：stdio 的生效前提是「那个程序在这台机器上能起来」，
 * http 的前提是「那个地址从这台机器能连上」—— 这两句话指向的排查方向
 * 完全不同，合成一句「重启内核后生效」等于什么也没说。
 */
export function connectorStateOf(config: ConnectorConfig): ConnectorState {
  if (!config.enabled) {
    return {
      config,
      kernelManaged: true,
      note: '已停用：不会注入内核配置；停用与删除同样在内核（重）启动后生效。',
    };
  }
  const transport = connectorTransportOf(config);
  return {
    config,
    kernelManaged: true,
    note:
      `清单在 DeepWork，连接与工具注册由内核托管：配置将在内核（重）启动后生效，` +
      `工具以 mcp__${config.name}__ 前缀出现；实时连接状态以内核日志为准。` +
      (transport === 'http'
        ? '网络传输要求该地址从这台机器可达。'
        : '本地传输要求该命令在这台机器上能直接启动。'),
  };
}

/** 这个连接器指向什么（日志与测试用，不进 UI 文案） */
export function connectorTargetOf(config: ConnectorConfig): string {
  return connectorTransportOf(config) === 'http'
    ? (config.url ?? '').trim()
    : [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');
}
