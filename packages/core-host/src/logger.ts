import fs from 'node:fs';
import path from 'node:path';
import { logsDir, ensureDirs } from './paths';

/**
 * 日志一律走 stderr 与文件。
 * stdout 是 JSON-RPC 协议通道，任何一条普通日志写进去都会破坏协议。
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = (process.env.DEEPWORK_LOG_LEVEL as Level) || 'info';
let stream: fs.WriteStream | null = null;

function fileStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    ensureDirs();
    stream = fs.createWriteStream(path.join(logsDir(), 'core-host.log'), { flags: 'a' });
  } catch {
    stream = null;
  }
  return stream;
}

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}${
    extra === undefined ? '' : ` ${safeStringify(extra)}`
  }`;
  process.stderr.write(`${line}\n`);
  fileStream()?.write(`${line}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}

export type Logger = ReturnType<typeof createLogger>;
