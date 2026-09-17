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

import {
  BROWSER_MCP_SERVER_NAME,
  CHART_MCP_SERVER_NAME,
  MEMORY_MCP_SERVER_NAME,
  connectorTransportOf,
  dshTransportOf,
  type ConnectorConfig,
} from '@deepwork/protocol';

/**
 * dsh 插件补丁条目（cordis loader 的 insert 条目形状）。
 *
 * 两种传输的 config 形状不同（内核的 zod schema 是一个 union），所以这里也是
 * 一个判别联合 —— 用「可选字段全塞进一个接口」的写法，生成侧就得靠运行时判断
 * 该不该带 command，而类型系统对此一句话也说不上。
 * `transport` 取内核的值（'streamable-http'），因为这是**补丁文件的内容**，
 * 由内核对齐；我们自己的 'http' 在 buildConnectorPatch 里已转换完毕。
 */
export interface ConnectorPatchEntry {
  id: string;
  name: string;
  config:
    | {
        transport: 'stdio';
        serverName: string;
        command: string;
        args?: string[];
        env?: Record<string, string>;
      }
    | {
        transport: 'streamable-http';
        serverName: string;
        url: string;
        headers?: Record<string, string>;
      };
}

/**
 * 把启用的连接器生成 dsh 插件补丁对象（顶层数组，一个 insert 补丁包住全部条目）。
 * 没有启用的连接器时返回 null —— 调用方据此不传 --patch，让内核保持零改动启动。
 *
 * 传输在这里翻译：本产品的 http → 内核的 streamable-http（dshTransportOf）。
 * 两种形态各自只带自己那些字段 —— 多带一个空的 command 或 url，内核的
 * zod schema 会直接拒绝整个补丁，而报错信息只说明某个字段不符合预期，
 * 不会告诉我们「是哪个连接器」。
 */
export function buildConnectorPatch(connectors: ConnectorConfig[]): Array<{ insert: ConnectorPatchEntry[] }> | null {
  const entries = connectors
    .filter((item) => item.enabled)
    .map((item): ConnectorPatchEntry => {
      const transport = connectorTransportOf(item);
      if (transport === 'http') {
        return {
          id: `deepwork-connector-${item.name}`,
          name: '@deepseek-ai/dsh-mcp-client',
          config: {
            transport: dshTransportOf(transport) as 'streamable-http',
            serverName: item.name,
            url: (item.url ?? '').trim(),
            ...(item.headers && Object.keys(item.headers).length > 0 ? { headers: item.headers } : {}),
          },
        };
      }
      return {
        id: `deepwork-connector-${item.name}`,
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          transport: dshTransportOf(transport) as 'stdio',
          serverName: item.name,
          command: (item.command ?? '').trim(),
          ...(item.args?.length ? { args: item.args } : {}),
          ...(item.env && Object.keys(item.env).length > 0 ? { env: item.env } : {}),
        },
      };
    });
  return entries.length > 0 ? [{ insert: entries }] : null;
}

/**
 * 把补丁对象序列化为 dsh 可读的 YAML（最小子集，手写）。
 *
 * 序列化只有一份实现（serializeInsert + emitConfig）：早先这里另有一份手写的
 * 「stdio 专用」发射器，加 http 传输时它立刻成了要同步维护的第二份知识 ——
 * 而且它的失败形态是**静默漏字段**（少写一个 url，内核报的是「配置不合法」，
 * 不说是哪一条）。现在两者共用一个受控形状的发射器。
 */
export function serializeConnectorPatchYaml(patch: Array<{ insert: ConnectorPatchEntry[] }>): string {
  const lines: string[] = [
    '# 由 DeepWork 生成（packages/core-host/src/mcp/patch.ts），请勿手改：',
    '# 每次内核（重）启动前按 ~/.deepwork/connectors.json 重建。',
  ];
  for (const patchEntry of patch) lines.push(...serializeInsert(patchEntry));
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
 * 内置 MCP 服务的补丁条目（**一个形状，两处使用**）。
 *
 * 为什么浏览器与图表能力都要以内置 MCP 服务的形式进内核，而不是只放在宿主的
 * 工具注册表里：注册表**只在 mock 适配器下被执行**，真实内核（dsh）有它自己的
 * 一套模型可见工具 —— 只注册进注册表的话，模型永远看不到这些工具，
 * 而开发期用 mock 完全看不出来。内核原生支持 MCP，所以这是最短、
 * 且不需要改内核的路径。
 *
 * 两个服务的条目形状与用户连接器完全一致（同一个 dsh-mcp-client 插件），
 * 区别只在 id / serverName / env —— 因此这里只有一份构造逻辑，
 * 免得「加了一个内置服务却漏了某个字段」这种错要在两处各查一遍。
 */
export interface BuiltinMcpService {
  /** 补丁条目的 id（`deepwork-<name>`），同名会与既有条目冲突 */
  id: string;
  /** MCP serverName：模型侧工具名的中段（`mcp__<serverName>__<tool>`），不含点号 */
  serverName: string;
  /** 拉起 MCP 服务的可执行文件（node / electron-in-node-mode） */
  command: string;
  /** MCP 服务的入口脚本绝对路径 */
  entry: string;
  /** 传给子进程的环境变量 */
  env: Record<string, string>;
}

export function buildBuiltinMcpPatch(service: BuiltinMcpService): { insert: ConnectorPatchEntry[] } {
  return {
    insert: [
      {
        id: service.id,
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          transport: 'stdio',
          serverName: service.serverName,
          command: service.command,
          args: [service.entry],
          env: service.env,
        },
      },
    ],
  };
}

/** 内置浏览器服务（六动作）：env 至少要有 DEEPWORK_HOME，否则两个进程会各拉一个浏览器 */
export function buildBrowserMcpPatch(options: {
  command: string;
  entry: string;
  env: Record<string, string>;
}): { insert: ConnectorPatchEntry[] } {
  return buildBuiltinMcpPatch({
    id: 'deepwork-browser',
    serverName: BROWSER_MCP_SERVER_NAME,
    command: options.command,
    entry: options.entry,
    env: options.env,
  });
}

/**
 * 内置图表服务（chart.render）。
 *
 * env 里多一个 `DEEPWORK_WORKSPACE`：图表是**写文件**的能力，必须知道写到哪个
 * 工作区。这个值取自宿主启动内核时用的那个 workspace，与内核自己的边界同源 ——
 * 缺了它，MCP 服务只能退到自己的 cwd，而那与内核的边界是两回事
 * （症状是「图写到别的目录去了」，而且不报错）。
 */
export function buildChartMcpPatch(options: {
  command: string;
  entry: string;
  env: Record<string, string>;
}): { insert: ConnectorPatchEntry[] } {
  return buildBuiltinMcpPatch({
    id: 'deepwork-chart',
    serverName: CHART_MCP_SERVER_NAME,
    command: options.command,
    entry: options.entry,
    env: options.env,
  });
}

/**
 * 内置记忆服务（memory_write / memory_read）。
 *
 * env 里有 `DEEPWORK_HOME` 与 `DEEPWORK_WORKSPACE`：
 *  - HOME 决定记忆写到哪（<home>/memory）—— 必须与宿主同源，否则模型写的
 *    和面板显示的是两份文件，症状是「模型说记下了，面板里没有」；
 *  - WORKSPACE 决定工作区层记忆归属哪个项目。
 */
export function buildMemoryMcpPatch(options: {
  command: string;
  entry: string;
  env: Record<string, string>;
}): { insert: ConnectorPatchEntry[] } {
  return buildBuiltinMcpPatch({
    id: 'deepwork-memory',
    serverName: MEMORY_MCP_SERVER_NAME,
    command: options.command,
    entry: options.entry,
    env: options.env,
  });
}

/** 合并连接器补丁、模型端点覆盖与内置服务；三者皆空返回 null（内核零改动启动） */
export function buildRuntimePatch(
  connectors: ConnectorConfig[],
  endpointOverride: RuntimePatchOverride | null,
  browserPatch?: { insert: ConnectorPatchEntry[] } | null,
  chartPatch?: { insert: ConnectorPatchEntry[] } | null,
  memoryPatch?: { insert: ConnectorPatchEntry[] } | null,
): RuntimePatchItem[] | null {
  const items: RuntimePatchItem[] = [];
  const connectorPatch = buildConnectorPatch(connectors);
  if (connectorPatch) items.push(...connectorPatch);
  if (endpointOverride) items.push(endpointOverride);
  /*
   * 内置服务的顺序：**图表、记忆在前，浏览器在后**。
   *
   * 浏览器恒为最后一项是一条被断言钉住的约定（browser-test 段 2：
   * 「出问题时先怀疑内置项」），所以新加的内置服务插在它前面，
   * 而不是顺手追加到末尾 —— 追加会让那条断言红，而它红的原因
   * 与「浏览器服务坏了」完全无关，属于最费时间的那类失败。
   *
   * 注意参数顺序与推入顺序**不同**：参数沿用历史形状（browser 在前）以免
   * 破坏既有调用方，推入顺序由这段代码决定。新增内置服务请只改这里。
   */
  if (chartPatch) items.push(chartPatch);
  if (memoryPatch) items.push(memoryPatch);
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
    // 统一走 emitConfig：config 的形状是受控的扁平对象（只可能多一层
    // env / headers 这种平面键值表），不需要第二份发射器
    emitConfig(lines, entry.config as unknown as Record<string, unknown>, 8);
  }
  return lines;
}

/** 受控形状的 YAML 发射：标量 / 标量数组 / 一层平面对象 / 平面对象数组 */
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
    } else if (value !== null && typeof value === 'object') {
      /*
       * 一层平面键值表（连接器的 env 与 headers）。
       * 只往下走一层：emitConfig 递归后，若还遇到对象会再次进这一支 —— 也就是
       * 允许 env: { A: { B: 1 } } 这种形状通过，而那内核并不接受。
       * 因此这里限制「值必须是字符串」，不合法时明确抛错（方向与上面几支一致：
       * 形状变复杂就先回来改这里，不要在调用方拼字符串）。
       */
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [, item] of entries) {
        if (typeof item !== 'string') {
          throw new Error(`运行时补丁的 ${key} 只支持一层键值表（值必须是字符串，先扩展 emitConfig）`);
        }
      }
      lines.push(`${pad}${key}:`);
      for (const [k, item] of entries) lines.push(`${pad}  ${quote(k)}: ${quote(item as string)}`);
    } else {
      throw new Error(`运行时补丁不支持 ${key} 的值形状（先扩展 emitConfig）`);
    }
  }
}
