/**
 * 连接器清单存储：`<home>/connectors.json`（数组）。
 *
 * DeepWork 只拥有清单 —— 连接、工具发现与注册发生在内核进程里。
 * 所以这里的 add/remove/toggle 都不尝试「立刻连接」，只持久化；
 * 生效时机（下一次内核启动）由 ConnectorState.note 如实呈现。
 */

import path from 'node:path';
import { connectorStateOf, validateConnectorConfig, type ConnectorConfig, type ConnectorState } from '@deepwork/protocol';
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
    const normalized: ConnectorConfig = {
      name: config.name,
      command: config.command.trim(),
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
