import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  TERMINAL_LIMITS,
  type TerminalChunk,
  type TerminalEntry,
  type TerminalExit,
  type TerminalState,
} from '@deepwork/protocol';
import { createLogger } from '../logger';
import { OutputDecoder } from './decoder';

const log = createLogger('terminal');

export type TerminalSink = (chunk: TerminalChunk) => void;

/**
 * 内置终端。
 *
 * ── 它是什么 ──
 * 流式命令台：一条命令一个子进程，stdout/stderr 实时回传，`write()` 可向运行中的进程送 stdin。
 *
 * ── 它刻意不是什么 ──
 *
 * 1. **不是 PTY。** 全屏 TUI（vim / top）用不了，因为这里没有伪终端。
 *    伪终端要引入 node-pty 这类原生模块，会带来编译链与预编译二进制的分发问题；
 *    在「本地优先、依赖面越小越好」的取舍下这一步被显式推迟。
 *    好处是换来的：零原生依赖、跨平台行为一致、可以纯 Node 断言它的整条链路。
 *
 * 2. **不经过 Guard。** Guard 管的是「**Agent** 能做什么」，不是「用户能敲什么」。
 *    用户在自己的机器上敲 `rm`，系统本来就不该拦 —— 把它拦下来只会让人以为这层保护有效，
 *    而真正的风险（Agent 自作主张执行命令）反而被这种虚假安全感掩盖。
 *    Agent 发起的命令走 shell.run 工具，那条路一定会过 Guard，两条路不可混淆。
 *
 * 3. **不落盘。** 终端 I/O 走独立通知通道，不进会话事件日志，理由见 protocol/terminal.ts。
 *
 * ── 一个容易被忽略的细节：shell 的调用方式 ──
 * 用 `spawn(command, { shell })` 而不是 `spawn(shell, ['/c', command])`。
 * 后者在 Windows 上会踩进 cmd 的引号转义泥潭：Node 会按 CreateProcess 规则给参数加引号，
 * 而 cmd 的 /c 解析规则是另一套，两者叠加后 `node -e "console.log(1+1)"` 这类命令会静默失败。
 * 实测 `shell: true` 让 Node 自己拼命令行才是对的 —— 空格、嵌套引号、管道、退出码全部正确。
 */

/** 单个终端的运行状态 */
interface LiveTerminal {
  sessionId: string;
  cwd: string;
  shell: string;
  child: ChildProcess | null;
  running: TerminalEntry | null;
  history: TerminalEntry[];
  /** 当前条目已接收的字符数（用于限流） */
  received: number;
  /** 当前条目是否已触顶（避免重复刷提示） */
  capped: boolean;
  dropped: number;
  /** 是被我们主动中断的，用于把退出标成 interrupted 而不是 failed */
  interrupted: boolean;
  sink: TerminalSink;
}

function resolveShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return process.env.SHELL || '/bin/sh';
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export class TerminalManager {
  private terminals = new Map<string, LiveTerminal>();

  /** 打开（或接管）某个会话的终端；重复打开只是换掉出口，不重启进程状态 */
  open(sessionId: string, workspace: string, sink: TerminalSink): TerminalState {
    const existing = this.terminals.get(sessionId);
    if (existing) {
      existing.sink = sink;
      return this.snapshot(existing);
    }

    const cwd = isDirectory(workspace) ? path.resolve(workspace) : process.cwd();
    const live: LiveTerminal = {
      sessionId,
      cwd,
      shell: resolveShell(),
      child: null,
      running: null,
      history: [],
      received: 0,
      capped: false,
      dropped: 0,
      interrupted: false,
      sink,
    };
    this.terminals.set(sessionId, live);
    log.info(`终端已打开 session=${sessionId} shell=${live.shell} cwd=${cwd}`);
    return this.snapshot(live);
  }

  state(sessionId: string): TerminalState | null {
    const live = this.terminals.get(sessionId);
    return live ? this.snapshot(live) : null;
  }

  /** 启动一条命令；立即返回条目 id，输出走通知通道 */
  run(sessionId: string, command: string): { entryId: string } {
    const live = this.require(sessionId);
    const trimmed = command.trim();
    if (!trimmed) throw new Error('命令为空');
    if (live.running) throw new Error('上一条命令仍在运行，请先中断或等它结束');

    const entry: TerminalEntry = {
      id: `t_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`,
      command: trimmed,
      cwd: live.cwd,
      startedAt: Date.now(),
      status: 'running',
    };
    live.running = entry;
    live.received = 0;
    live.capped = false;
    live.interrupted = false;
    this.remember(live, entry);

    // 刻意不在这里回显 `$ command`：命令本身会作为条目元数据随状态一起返回，
    // 界面在块头渲染它。两处都写就成了重复，而且会让「输出」这个缓冲区混进非输出内容。
    // （中断提示之类的宿主消息仍然走 system 流 —— 那些是输出里没有、用户又必须知道的事。）

    let child: ChildProcess;
    try {
      child = spawn(trimmed, {
        shell: live.shell,
        cwd: live.cwd,
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      this.finish(live, entry, {
        status: 'failed',
      }, `无法启动 shell：${error instanceof Error ? error.message : String(error)}`);
      return { entryId: entry.id };
    }

    live.child = child;
    const outDecoder = new OutputDecoder();
    const errDecoder = new OutputDecoder();

    child.stdout?.on('data', (buffer: Buffer) => {
      this.push(live, entry.id, 'stdout', outDecoder.decode(buffer));
    });
    child.stderr?.on('data', (buffer: Buffer) => {
      this.push(live, entry.id, 'stderr', errDecoder.decode(buffer));
    });

    // spawn 本身失败（shell 路径不存在等）只会在 'error' 上报，不会走 close
    child.on('error', (error: Error) => {
      this.finish(live, entry, { status: 'failed' }, `进程启动失败：${error.message}\n`);
    });

    child.on('close', (code: number | null) => {
      this.push(live, entry.id, 'stdout', outDecoder.flush());
      this.push(live, entry.id, 'stderr', errDecoder.flush());
      this.finish(
        live,
        entry,
        live.interrupted
          ? { status: 'interrupted' }
          : { status: 'exited', exitCode: code ?? undefined },
        '',
      );
      // cwd 只有在命令真正跑完之后才推进，避免中途切换让后续诊断错位
      this.applyCwd(live, trimmed);
    });

    return { entryId: entry.id };
  }

  /** 向运行中的进程送 stdin —— 命令台里回一句 y / 密码之类的交互靠它 */
  write(sessionId: string, data: string): { ok: boolean } {
    const live = this.terminals.get(sessionId);
    if (!live?.child?.stdin || live.child.stdin.destroyed) return { ok: false };
    const payload = data.slice(0, TERMINAL_LIMITS.writeChars);
    live.child.stdin.write(payload);
    return { ok: true };
  }

  interrupt(sessionId: string): { ok: boolean } {
    const live = this.terminals.get(sessionId);
    if (!live?.child || !live.running) return { ok: false };
    live.interrupted = true;
    this.say(live, live.running.id, 'system', '\n[已请求中断]\n');
    this.kill(live.child);
    return { ok: true };
  }

  close(sessionId: string): { ok: true } {
    const live = this.terminals.get(sessionId);
    if (live) {
      live.interrupted = true;
      if (live.child) this.kill(live.child);
      this.terminals.delete(sessionId);
      log.info(`终端已关闭 session=${sessionId}`);
    }
    return { ok: true };
  }

  closeAll(): void {
    for (const [id] of this.terminals) this.close(id);
  }

  /**
   * 中断/关闭时终止整棵进程树。
   *
   * Windows 上 child.kill() 只杀直接子进程，而这里直接子进程是 shell、真正干活的是它的孙进程；
   * 不带上 /T 的话，`npm run dev` 这类会派生的命令会变成杀不掉的孤儿。
   */
  private kill(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        child.kill();
      }
      return;
    }
    child.kill('SIGTERM');
  }

  /** 命令结束后推进 cwd。只认 `cd X` 与 `cd X && ...` 这两种形态 */
  private applyCwd(live: LiveTerminal, command: string): void {
    const head = command.split('&&')[0]?.trim() ?? '';
    const match = /^cd(?:\s+(.+))?$/i.exec(head);
    if (!match) return;

    let target = (match[1] ?? '').trim();
    if (!target) return; // 裸 `cd` 只是打印当前目录，不改变它
    if (process.platform === 'win32') target = target.replace(/^\/d\s+/i, '').trim();
    target = target.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (target === '~' || target === '%USERPROFILE%') target = process.env.USERPROFILE || process.env.HOME || live.cwd;
    if (!target) return;

    const abs = path.resolve(live.cwd, target);
    // 目录不存在就保持原 cwd：命令自己会报错，宿主不必替它猜一个「大概想去哪」
    if (isDirectory(abs)) live.cwd = abs;
  }

  private require(sessionId: string): LiveTerminal {
    const live = this.terminals.get(sessionId);
    if (!live) throw new Error('终端未打开，请先调用 terminal.open');
    return live;
  }

  private remember(live: LiveTerminal, entry: TerminalEntry): void {
    live.history = [entry, ...live.history.filter((item) => item.id !== entry.id)].slice(
      0,
      TERMINAL_LIMITS.historyEntries,
    );
  }

  /** 收尾：更新条目状态、广播结束块，然后清空运行位 */
  private finish(
    live: LiveTerminal,
    entry: TerminalEntry,
    exit: TerminalExit,
    extraOutput: string,
  ): void {
    if (entry.status !== 'running') return;
    if (extraOutput) this.say(live, entry.id, 'system', extraOutput);

    entry.status = exit.status;
    entry.exitCode = exit.exitCode;
    entry.endedAt = Date.now();
    this.remember(live, entry);

    live.running = null;
    live.child = null;
    live.sink({ sessionId: live.sessionId, entryId: entry.id, stream: 'system', text: '', exit });
  }

  private say(live: LiveTerminal, entryId: string, stream: 'stdout' | 'stderr' | 'system', text: string): void {
    if (!text) return;
    live.sink({ sessionId: live.sessionId, entryId, stream, text });
  }

  /** 推送输出，并执行单条命令的输出上限 */
  private push(live: LiveTerminal, entryId: string, stream: 'stdout' | 'stderr', text: string): void {
    if (!text) return;

    const remaining = TERMINAL_LIMITS.perEntryChars - live.received;
    if (text.length <= remaining) {
      live.received += text.length;
      this.say(live, entryId, stream, text);
      return;
    }

    if (remaining > 0) {
      live.received += remaining;
      this.say(live, entryId, stream, text.slice(0, remaining));
    }
    if (!live.capped) {
      live.capped = true;
      live.dropped += text.length - Math.max(0, remaining);
      this.say(
        live,
        entryId,
        'system',
        `\n[输出超过 ${TERMINAL_LIMITS.perEntryChars} 字符上限，后续内容已丢弃]\n`,
      );
    } else {
      live.dropped += text.length;
    }
  }

  private snapshot(live: LiveTerminal): TerminalState {
    return {
      sessionId: live.sessionId,
      cwd: live.cwd,
      shell: live.shell,
      running: live.running,
      history: live.history,
      dropped: live.dropped,
    };
  }
}
