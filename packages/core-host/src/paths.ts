import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR_NAME } from '@deepwork/protocol';

/**
 * 运行时数据目录。
 * 默认 <用户主目录>/.deepwork，可用 DEEPWORK_HOME 覆盖（测试与多实例场景）。
 */
export function homeDir(): string {
  const custom = process.env.DEEPWORK_HOME;
  if (custom && custom.trim()) return path.resolve(custom.trim());
  return path.join(os.homedir(), DATA_DIR_NAME);
}

export function sessionsDir(): string {
  return path.join(homeDir(), 'sessions');
}

export function sessionDir(id: string): string {
  return path.join(sessionsDir(), id);
}

export function logsDir(): string {
  return path.join(homeDir(), 'logs');
}

export function configPath(): string {
  return path.join(homeDir(), 'config.json');
}

export function guardPath(): string {
  return path.join(homeDir(), 'guard.json');
}

export function ensureDirs(): void {
  for (const dir of [homeDir(), sessionsDir(), logsDir(), path.join(homeDir(), 'skills')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 极小的 JSON 读写工具，容忍文件缺失与损坏 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
