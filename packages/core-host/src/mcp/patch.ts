/**
 * 连接器清单 → dsh 插件补丁（纯函数，无 IO）。
 *
 * ── 形状来源（2026-09-13 对 dsh 0.1.5-rc.1 源码取证）─────────────────
 * - `dsh --patch <file>` 的补丁文件是**顶层 YAML 数组**，元素是 cordis
 *   loader 补丁条目（dsh-app-boot `loadOverlayPatches` / `parsePatchList`）；
 * - 新增插件用 `{ insert: [条目] }`（无 id 的 insert 直接追加到根条目列表，
 *   见 dsh-app-boot `applyEntryPatches`）；条目形状 `{ id, name, config }`，
 *   参照物是 dsh-base 自带的 cordis.patch.yml；
 * - `@deepseek-ai/dsh-mcp-client` 的 Config（zod schema，lib/index.js）：
 *   stdio 传输 = `{ transport:'stdio', serverName, command, args?, env?, cwd? }`，
 *   serverName 须匹配 `[A-Za-z0-9_-]{1,32}`（我们的清单更严：小写，见
 *   protocol/mcp.ts）；
 * - 工具注册后的公开名恒为 `mcp__<serverName>__<rawName>`。
 *
 * dsh 按依赖闭包解析 `@deepseek-ai/dsh-mcp-client`（dsh 自身的
 * dependencies 里有它，dsh-app-boot 会把安装依赖自愈到
 * `$DSH_HOME/profiles/node_modules`），所以补丁里写包名即可，不需要绝对路径。
 */

import { BROWSER_MCP_SERVER_NAME, type ConnectorConfig } from '@deepwork/protocol';

/** dsh 插件补丁条目（cordis loader 的 insert 条目形状） */
export interface ConnectorPatchEntry {
  id: string;
  name: string;
  config: {
    transport: 'stdio';
    serverName: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
}

/**
 * 把启用的连接器生成 dsh 插件补丁对象（顶层数组，一个 insert 补丁包住全部条目）。
 * 没有启用的连接器时返回 null —— 调用方据此不传 --patch，让内核保持零改动启动。
 */
export function buildConnectorPatch(connectors: ConnectorConfig[]): Array<{ insert: ConnectorPatchEntry[] }> | null {
  const entries = connectors
    .filter((item) => item.enabled)
    .map((item) => ({
      id: `deepwork-connector-${item.name}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        transport: 'stdio' as const,
        serverName: item.name,
        command: item.command,
        ...(item.args?.length ? { args: item.args } : {}),
        ...(item.env && Object.keys(item.env).length > 0 ? { env: item.env } : {}),
      },
    }));
  return entries.length > 0 ? [{ insert: entries }] : null;
}

/**
 * 把补丁对象序列化为 dsh 可读的 YAML（最小子集，手写）。
 *
 * 我们的数据形状受控（上面 buildConnectorPatch 的产物）：字符串里可能出现
 * 的只有路径、参数与键值 —— 一律用 JSON 双引号风格序列化标量
 * （JSON 转义是 YAML 双引号标量的合法子集），不需要引入 js-yaml。
 * 若将来要生成更深/更自由的结构，先回来改这里，不要在调用方拼接。
 */
export function serializeConnectorPatchYaml(patch: Array<{ insert: ConnectorPatchEntry[] }>): string {
  const lines: string[] = [
    '# 由 DeepWork 生成（packages/core-host/src/mcp/patch.ts），请勿手改：',
    '# 每次内核（重）启动前按 ~/.deepwork/connectors.json 重建。',
  ];
  for (const patchEntry of patch) {
    lines.push('- insert:');
    for (const entry of patchEntry.insert) {
      lines.push(`    - id: ${quote(entry.id)}`);
      lines.push(`      name: ${quote(entry.name)}`);
      lines.push('      config:');
      lines.push(`        transport: ${quote(entry.config.transport)}`);
      lines.push(`        serverName: ${quote(entry.config.serverName)}`);
      lines.push(`        command: ${quote(entry.config.command)}`);
      if (entry.config.args?.length) {
        lines.push('        args:');
        for (const arg of entry.config.args) lines.push(`          - ${quote(arg)}`);
      }
      if (entry.config.env && Object.keys(entry.config.env).length > 0) {
        lines.push('        env:');
        for (const [key, value] of Object.entries(entry.config.env)) {
          lines.push(`          ${quote(key)}: ${quote(value)}`);
        }
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** JSON 双引号标量：YAML 双引号风格的合法子集（含 \\ \" \n 等转义） */
function quote(value: string): string {
  return JSON.stringify(value);
}

// ════════════════════════════════════════════════════════════════
// 运行时补丁（连接器 insert + 既有条目覆盖）
// ════════════════════════════════════════════════════════════════

/**
 * 覆盖补丁：按 id 找到既有条目并整体替换其 config（dsh-app-boot
 * applyEntryPatches 的非 insert 分支：id 定位、name 校验、overrides 赋值）。
 * 用于模型端点（覆盖 llm-deepseek 条目的 baseURL 与 models 目录）。
 *
 * 为什么模型端点走补丁而不是 $DSH_HOME/settings.yaml：settings-file 是
 * 热重载的，session/new 公布模型目录与设置加载之间存在竞态（2026-09-13
 * 实测：同一配置间歇性拿到内置目录）。补丁在组合期应用，是确定性的；
 * 代价是变更需重启内核生效（patchReload: startup），与连接器同一语义。
 */
export interface RuntimePatchOverride {
  id: string;
  name: string;
  config: Record<string, unknown>;
}

export type RuntimePatchItem = { insert: ConnectorPatchEntry[] } | RuntimePatchOverride;

/**
 * 内置浏览器 MCP 服务的补丁条目。
 *
 * 为什么浏览器能力要以内置 MCP 服务的形式进内核，而不是只在宿主工具注册表里：
 * 注册表只在 mock 适配器下被执行，真实内核（dsh）有自己的一套模型可见工具 ——
 * 只注册进注册表的话，模型永远看不到这六个工具（开发期用 mock 完全看不出来）。
 * 内核原生支持 MCP，所以把它做成 MCP 服务是最短的、且不需要改内核的路径。
 *
 * 条目形状与用户连接器完全一致（同一个 dsh-mcp-client 插件），
 * 区别只在 id / serverName / env 由我们生成。
 */
export function buildBrowserMcpPatch(options: {
  /** 拉起 MCP 服务的可执行文件（node / electron-in-node-mode） */
  command: string;
  /** MCP 服务的入口脚本绝对路径 */
  entry: string;
  /** 传给子进程的环境变量（至少要有 DEEPWORK_HOME，否则两个进程会各拉一个浏览器） */
  env: Record<string, string>;
}): { insert: ConnectorPatchEntry[] } {
  return {
    insert: [
      {
        id: 'deepwork-browser',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          transport: 'stdio',
          serverName: BROWSER_MCP_SERVER_NAME,
          command: options.command,
          args: [options.entry],
          env: options.env,
        },
      },
    ],
  };
}

/** 合并连接器补丁、模型端点覆盖与内置浏览器服务；三者皆空返回 null（内核零改动启动） */
export function buildRuntimePatch(
  connectors: ConnectorConfig[],
  endpointOverride: RuntimePatchOverride | null,
  browserPatch?: { insert: ConnectorPatchEntry[] } | null,
): RuntimePatchItem[] | null {
  const items: RuntimePatchItem[] = [];
  const connectorPatch = buildConnectorPatch(connectors);
  if (connectorPatch) items.push(...connectorPatch);
  if (endpointOverride) items.push(endpointOverride);
  // 浏览器服务放最后：它排在前面的 insert 之后被追加进内核的条目列表，
  // 与「用户清单优先」的直觉一致（出问题时先怀疑内置的那一项）
  if (browserPatch) items.push(browserPatch);
  return items.length > 0 ? items : null;
}

/**
 * 运行时补丁序列化。数据形状受控（buildRuntimePatch 的产物）：
 * 标量 / 标量数组 / 一层平面对象数组，手写最小 YAML 发射器，不引 js-yaml。
 */
export function serializeRuntimePatchYaml(items: RuntimePatchItem[]): string {
  const lines: string[] = [
    '# 由 DeepWork 生成（packages/core-host/src/mcp/patch.ts），请勿手改：',
    '# 每次内核（重）启动前按 ~/.deepwork 的连接器清单与模型端点配置重建。',
  ];
  for (const item of items) {
    if ('insert' in item) {
      lines.push(...serializeInsert(item));
    } else {
      lines.push(`- id: ${quote(item.id)}`);
      lines.push(`  name: ${quote(item.name)}`);
      lines.push('  config:');
      emitConfig(lines, item.config, 4);
    }
  }
  return `${lines.join('\n')}\n`;
}

function serializeInsert(item: { insert: ConnectorPatchEntry[] }): string[] {
  const lines: string[] = [];
  for (const entry of item.insert) {
    lines.push('- insert:');
    lines.push(`    - id: ${quote(entry.id)}`);
    lines.push(`      name: ${quote(entry.name)}`);
    lines.push('      config:');
    lines.push(`        transport: ${quote(entry.config.transport)}`);
    lines.push(`        serverName: ${quote(entry.config.serverName)}`);
    lines.push(`        command: ${quote(entry.config.command)}`);
    if (entry.config.args?.length) {
      lines.push('        args:');
      for (const arg of entry.config.args) lines.push(`          - ${quote(arg)}`);
    }
    if (entry.config.env && Object.keys(entry.config.env).length > 0) {
      lines.push('        env:');
      for (const [key, value] of Object.entries(entry.config.env)) {
        lines.push(`          ${quote(key)}: ${quote(value)}`);
      }
    }
  }
  return lines;
}

/** 受控形状的 YAML 发射：标量 / 标量数组 / 一层平面对象数组 */
function emitConfig(lines: string[], config: Record<string, unknown>, indent: number): void {
  const pad = ' '.repeat(indent);
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      lines.push(`${pad}${key}: ${quote(value)}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${pad}${key}: ${value}`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      lines.push(`${pad}${key}:`);
      for (const item of value) lines.push(`${pad}  - ${quote(item)}`);
    } else if (Array.isArray(value)) {
      lines.push(`${pad}${key}:`);
      for (const obj of value as Array<Record<string, unknown>>) {
        const entries = Object.entries(obj);
        entries.forEach(([k, v], index) => {
          const prefix = index === 0 ? `${pad}  - ${k}:` : `${pad}    ${k}:`;
          if (typeof v === 'string') lines.push(`${prefix} ${quote(v)}`);
          else if (typeof v === 'number' || typeof v === 'boolean') lines.push(`${prefix} ${v}`);
          else throw new Error(`运行时补丁不支持 ${key}.${k} 的嵌套形状（先扩展 emitConfig）`);
        });
      }
    } else {
      throw new Error(`运行时补丁不支持 ${key} 的值形状（先扩展 emitConfig）`);
    }
  }
}
