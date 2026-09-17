/**
 * 连接器清单存储：`<home>/connectors.json`（数组）。
 *
 * DeepWork 只拥有清单 —— 连接、工具发现与注册发生在内核进程里。
 * 所以这里的 add/remove/toggle 都不尝试「立刻连接」，只持久化；
 * 生效时机（下一次内核启动）由 ConnectorState.note 如实呈现。
 */

import path from 'node:path';
import { connectorStateOf, connectorTransportOf, validateConnectorConfig, type ConnectorConfig, type ConnectorState } from '@deepwork/protocol';
import { homeDir, readJson, writeJson } from '../paths';

export class ConnectorStore {
  private readonly file: string;

  constructor(baseDir?: string) {
    this.file = path.join(baseDir ?? homeDir(), 'connectors.json');
  }

  list(): ConnectorConfig[] {
    return readJson<ConnectorConfig[]>(this.file, []);
  }

  listStates(): ConnectorState[] {
    return this.list().map(connectorStateOf);
  }

  get(name: string): ConnectorConfig | null {
    return this.list().find((item) => item.name === name) ?? null;
  }

  add(config: ConnectorConfig): ConnectorState {
    const invalid = validateConnectorConfig(config);
    if (invalid) throw new Error(invalid);
    const transport = connectorTransportOf(config);
    /*
     * 按传输归一化：两种形态各自保留自己那些字段，互不夹带。
     *
     * 这层归一化不是洁癖 —— 补丁是照着清单生成的，残留字段会直接进内核配置：
     * 一个从 stdio 改成 http 的连接器如果留着旧 command，补丁里就会出现
     * `transport: streamable-http` 与 `command` 同时在场的形状，内核的
     * zod union 两边都匹配不上，报错却是「配置不合法」。落盘前清干净。
     *
     * stdio 不写 transport 字段：缺省即 stdio，写上去只是多一个键，
     * 而多出来的键会让「旧清单」与「新清单」在文本上产生无意义的差异。
     */
    const normalized: ConnectorConfig =
      transport === 'http'
        ? {
            name: config.name,
            transport: 'http',
            url: (config.url ?? '').trim(),
            ...(config.headers && Object.keys(config.headers).length > 0
              ? { headers: { ...config.headers } }
              : {}),
            enabled: config.enabled !== false,
          }
        : {
            name: config.name,
            command: (config.command ?? '').trim(),
            ...(config.args?.length ? { args: config.args.map(String) } : {}),
            ...(config.env && Object.keys(config.env).length > 0 ? { env: { ...config.env } } : {}),
            enabled: config.enabled !== false,
          };
    const list = this.list();
    if (list.some((item) => item.name === normalized.name)) {
      throw new Error(`连接器已存在：${normalized.name}（名称即工具名前缀，不可重复）`);
    }
    this.persist([...list, normalized]);
    return connectorStateOf(normalized);
  }

  remove(name: string): boolean {
    const list = this.list();
    const next = list.filter((item) => item.name !== name);
    if (next.length === list.length) return false;
    this.persist(next);
    return true;
  }

  toggle(name: string, enabled: boolean): ConnectorState | null {
    const list = this.list();
    const index = list.findIndex((item) => item.name === name);
    if (index < 0) return null;
    list[index] = { ...list[index], enabled };
    this.persist(list);
    return connectorStateOf(list[index]);
  }

  private persist(list: ConnectorConfig[]): void {
    writeJson(this.file, list);
  }
}
