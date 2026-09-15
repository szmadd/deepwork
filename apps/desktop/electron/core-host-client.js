'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

/**
 * 内核宿主客户端：拉起 core-host 子进程，以 NDJSON 走 stdio 做 JSON-RPC。
 *
 * 为什么用 stdio 而不是回环端口：
 *  - 主进程与 core-host 同机同用户、通过管道通信，不存在网络暴露面，也就不需要端口与 token；
 *  - 回环 + 一次性 token 这条规则用在更下游——core-host 访问真实 Harness 时（见 harness-sidecar.ts）。
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * 内核宿主入口的定位。
 *
 * 两种运行形态下产物位置不同：
 *  - 开发态：仓库里的 packages/core-host/dist/index.js；
 *  - 打包后：resources/core-host/dist/index.js（由 electron-builder 的 extraResources 落位）。
 *
 * 打包态优先，但**必须先确认文件真的存在**再采用：Electron 在开发态同样会设置
 * process.resourcesPath（指向 Electron 自己的 resources 目录），无条件采用会让
 * `npm run start` 直接缺内核。
 */
function resolveCoreEntry() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'core-host', 'dist', 'index.js');
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.join(REPO_ROOT, 'packages', 'core-host', 'dist', 'index.js');
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;

/**
 * 解析用哪个 Node 运行时来跑 core-host。
 *
 * 绝对不能用 Electron 自带的运行时去跑真实 Harness：官方要求 Node 22.19+，
 * 而 Electron 内置 Node 版本不受我们控制。这里的策略是「显式指定 > 随包运行时 >
 * 外部 Node > 兜底 ELECTRON_RUN_AS_NODE」，并在 status 里把实际使用的运行时暴露出去。
 *
 * 随包运行时（resources/node-runtime/）是一体化安装包离线部署的关键：目标机不装
 * Node、不联网也能跑内核。只取 node.exe 单文件，core-host 与 dsh 都是纯 JS，
 * 不需要完整 Node 发行版。
 */
function resolveNodeRuntime() {
  const explicit = process.env.DEEPWORK_NODE_BIN;
  if (explicit && fs.existsSync(explicit)) {
    return { bin: explicit, args: [], source: 'DEEPWORK_NODE_BIN' };
  }

  if (process.resourcesPath) {
    const bundled = path.join(
      process.resourcesPath, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'node',
    );
    if (fs.existsSync(bundled)) {
      return { bin: bundled, args: [], source: '随包 Node 运行时' };
    }
  }

  const candidates = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['-v'], { encoding: 'utf8', timeout: 4000 }).trim();
      const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
      if (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)) {
        return { bin: candidate, args: [], source: `PATH (${version})` };
      }
    } catch {
      // 继续尝试下一个候选
    }
  }

  // 兜底：让 Electron 二进制以纯 Node 模式运行（不启动 GUI）
  return {
    bin: process.execPath,
    args: [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    source: `ELECTRON_RUN_AS_NODE (${process.versions.node}，可能不满足内核 22.19+ 要求)`,
  };
}

class CoreHostClient extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.runtime = null;
    this.restarts = 0;
    this.stopping = false;
  }

  get runtimeSource() {
    return this.runtime ? this.runtime.source : '未启动';
  }

  start({ workspace, home }) {
    const entry = resolveCoreEntry();
    if (!fs.existsSync(entry)) {
      throw new Error(
        `未找到内核宿主产物: ${entry}\n开发态请在仓库根目录执行 npm run build；打包态请检查安装包是否完整`,
      );
    }

    this.runtime = resolveNodeRuntime();
    this.stopping = false;

    const env = {
      ...process.env,
      ...(this.runtime.env || {}),
      DEEPWORK_WORKSPACE: workspace,
    };
    if (home) env.DEEPWORK_HOME = home;
    // 随包运行时不在系统 PATH 上；把它前置进子进程 PATH，下游（dsh、MCP 连接器）
    // 若再解析 `node` 也能命中同一个运行时，而不是落空或撞上版本不符的系统 node。
    if (this.runtime.source === '随包 Node 运行时') {
      const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      env[key] = `${path.dirname(this.runtime.bin)}${path.delimiter}${env[key] ?? ''}`;
    }

    this.child = spawn(this.runtime.bin, [...this.runtime.args, entry], {
      env,
      cwd: workspace,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      process.stderr.write(`[core-host] ${chunk}`);
    });

    this.child.on('exit', (code, signal) => {
      const wasStopping = this.stopping;
      this.child = null;
      for (const [, entry] of this.pending) {
        entry.reject(new Error('内核宿主已退出'));
      }
      this.pending.clear();
      if (!wasStopping) {
        this.emit('crashed', { code, signal });
      }
    });

    this.emit('started', { runtime: this.runtime.source });
  }

  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        process.stderr.write(`[core-host] 无法解析的协议行: ${trimmed}\n`);
        continue;
      }

      if (message.method === 'event' && message.params) {
        this.emit('event', message.params);
        continue;
      }

      /**
       * 终端字节流走独立事件名。
       * 不合并进 'event' 是刻意的：订阅方对两者的处理完全不同 ——
       * 事件要进归约器、要落 UI 状态；终端数据只是往屏幕缓冲里追加。
       * 混在一起会让每个订阅点都得自己再分一次类。
       */
      if (message.method === 'terminal' && message.params) {
        this.emit('terminal', message.params);
        continue;
      }

      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(message.error.message || '内核调用失败'));
        } else {
          entry.resolve(message.result);
        }
      }
    }
  }

  invoke(method, params = {}, timeoutMs = 120_000) {
    if (!this.child) {
      return Promise.reject(new Error('内核宿主未运行'));
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`内核调用超时: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.child.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async stop() {
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      // 关闭 stdin 会触发 core-host 的优雅退出
      child.stdin.end();
      setTimeout(() => child.kill(), 1500);
    });
    this.child = null;
  }
}

module.exports = { CoreHostClient, resolveCoreEntry, REPO_ROOT };
