/**
 * 内置终端契约。
 *
 * ── 一个必须先说清楚的边界 ──
 *
 * 这里实现的是**流式命令台**，不是 PTY。命令台按「一条命令一个子进程」执行，
 * 输出实时回传；`terminal.write` 可以在命令运行期间把数据送进它的 stdin，
 * 因此 `npm init`、`git commit` 这类需要回一两句的交互能用。
 *
 * 它做不到的是全屏 TUI（vim / top / 交互式 REPL）——那需要伪终端（node-pty），
 * 而 PTY 是原生模块，会引入编译链与预编译二进制分发问题。
 * 在「本地优先、依赖面越小越好」的取舍下，这一步被显式推迟，而不是假装做到了。
 *
 * ── 为什么终端 I/O 不进会话事件日志 ──
 *
 * 事件日志（events.jsonl）是「Agent 与用户之间发生过什么」的忠实记录，要可回放、可分叉。
 * 终端里敲的是什么，属于**用户在自己机器上的操作**，不属于 Agent 的上下文，
 * 把它写进日志只会让日志被刷屏、让回放变得又慢又吵。
 * 因此终端数据走独立的 RPC 通知通道（method='terminal'），不落盘、不进归约器。
 */

/** 输出流来源：stdout / stderr / 宿主自身的系统提示（如「命令已中断」） */
export type TerminalStream = 'stdout' | 'stderr' | 'system';

export type TerminalEntryStatus = 'running' | 'exited' | 'interrupted' | 'failed';

/** 命令结束的结算信息 */
export interface TerminalExit {
  status: TerminalEntryStatus;
  /** 退出码；被信号终止时为 undefined */
  exitCode?: number;
}

export interface TerminalChunk {
  sessionId: string;
  /** 所属命令条目 */
  entryId: string;
  stream: TerminalStream;
  /** 增量文本；结束块为空串 */
  text: string;
  /**
   * 结束块。
   *
   * 单独给一个字段，而不是让界面去解析最后一行输出（比如找 "exit code 0"）——
   * 那种做法会在用户恰好打印了同样的字符串时出错，
   * 而「这条命令到底结束了没有」是界面必须精确知道的事。
   */
  exit?: TerminalExit;
}

export interface TerminalEntry {
  id: string;
  command: string;
  /** 执行时的工作目录（绝对路径） */
  cwd: string;
  startedAt: number;
  endedAt?: number;
  status: TerminalEntryStatus;
  /** 退出码；被信号终止时为 undefined */
  exitCode?: number;
}

export interface TerminalState {
  sessionId: string;
  /** 当前工作目录，随 `cd` 更新的结果 */
  cwd: string;
  /** 实际使用的 shell 可执行文件 */
  shell: string;
  /** 正在运行的命令；空闲为 null */
  running: TerminalEntry | null;
  /** 历史条目，最新的在前 */
  history: TerminalEntry[];
  /** 因超出缓冲上限而被丢弃的字符数（界面据此提示「输出不完整」） */
  dropped: number;
  /** shell 不可用时的原因；为空表示正常 */
  unavailable?: string;
}

/** 终端会话的容量约束（宿主与 UI 共用，避免两边各写一套数） */
export const TERMINAL_LIMITS = {
  /** 单条命令的输出上限（字符），超出后停止推送 */
  perEntryChars: 400_000,
  /** 历史条目保留上限 */
  historyEntries: 50,
  /** 单次写入 stdin 的上限 */
  writeChars: 8_000,
} as const;
