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

/**
 * ── 终端 shell 档位 ──────────────────────────────────────────
 *
 * 为什么会有一个「档位」，而不是写死一个 shell：
 * 三档解决的是三个不同的问题，且**能力边界不同** —— 用户在终端里敲什么由他决定，
 * 界面能做的只是如实说明「这一档下哪些命令可用、哪些不可用」。
 *
 *  - `powershell`（默认）：Windows 原生，且与 Agent 侧的 shell 同族
 *    （内核在 Windows 上走 `dsh-pwsh-local`），词汇一致。
 *    代价必须说清楚：**Windows PowerShell 5.1 不支持 `&&` / `||`**（PS 7 才支持），
 *    而 5.1 是绝大多数机器上的默认版本（本机实测：只有 5.1，没有 pwsh）。
 *  - `cmd`：改动前的默认档位，保留给依赖老脚本的场景。
 *  - `gitbash`：唯一**真正与 Linux 一致**的档位（bash 语义、`&&`/`||`/管道/`grep` 齐备）。
 *
 * ── gitbash 档位的一条硬边界 ────────────────────────────────
 * 机器上没装 Git for Windows 时，**必须如实报「未找到」而不是回退到 `System32\bash.exe`**：
 * 那个文件是 **WSL 入口**，选中它会在另一个文件系统里开一个 shell ——
 * 用户以为自己在 Windows 工作区里，实际不是，而这件事从画面上看不出来。
 * 所以「解析不到就是不可用」是这一档的正确行为，不是降级失败。
 */
export type TerminalShell = 'powershell' | 'cmd' | 'gitbash';

/** 合法档位；顺序即设置页展示顺序（默认档在最前） */
export const TERMINAL_SHELLS: readonly TerminalShell[] = ['powershell', 'cmd', 'gitbash'];

export const DEFAULT_TERMINAL_SHELL: TerminalShell = 'powershell';

export const TERMINAL_SHELL_LABEL: Record<TerminalShell, string> = {
  powershell: 'PowerShell',
  cmd: '命令提示符 (cmd)',
  gitbash: 'Git Bash（与 Linux 一致）',
};

/**
 * 各档的能力边界，直接显示在设置页。
 *
 * 写在这里而不是散在界面里：它是**用户做选择时唯一需要的依据**。
 * 让用户按「我要敲什么命令」来选，比让他自己去试快得多 —— 而选错的表现
 * （比如在 PS 5.1 里敲 `a && b` 报语法错）看起来像终端坏了。
 */
export const TERMINAL_SHELL_NOTE: Record<TerminalShell, string> = {
  powershell:
    'Windows 原生，与 Agent 侧的 shell 同族。ls / cat / rm / cp / mv / pwd / echo 可用（PowerShell 别名）；' +
    'Windows PowerShell 5.1 不支持 && 与 ||，要串行请用 ; 分隔。',
  cmd: '改动前的默认档位。dir / type / copy 等原生命令，Linux 风格命令基本不可用。',
  gitbash:
    '唯一与 Linux 一致的档位：bash 语义，&& / || / 管道 / grep 齐备。需要机器已安装 Git for Windows；' +
    '解析不到时会如实报「未找到」，不会退到 WSL。',
};

/** 档位判定 —— 白名单只此一处（启动 / 配置校验 / 界面回填共用） */
export function isTerminalShell(value: unknown): value is TerminalShell {
  return typeof value === 'string' && (TERMINAL_SHELLS as readonly string[]).includes(value);
}

export interface TerminalState {
  sessionId: string;
  /** 当前工作目录，随 `cd` 更新的结果 */
  cwd: string;
  /**
   * 当前档位解析到的可执行文件（绝对路径）；空串 = 本机没有这一档。
   *
   * 与 `shellKind` 分开两个字段：`pwsh.exe` 与 `powershell.exe` 是同一档位，
   * 而界面上「选了哪一档」与「接下来会由哪个可执行文件执行」是两句不同的话。
   * 它按**当前档位**实时解析，不是「上一次用过什么」——后者会让「刚切到
   * 本机没有的档位」继续显示上一档的路径，看起来像切成功了。
   */
  shell: string;
  /**
   * 档位。
   *
   * 它是**用户选的**那一档，`shell` 是**这一档在本机解析出来的**可执行文件 ——
   * 两者分开，因为「选了 PowerShell」与「跑的是 pwsh.exe 还是 powershell.exe」
   * 是两个问题，而跨机器时答案不同（PS 7 与 5.1 的能力边界也不同）。
   */
  shellKind: TerminalShell;
  /** 正在运行的命令；空闲为 null */
  running: TerminalEntry | null;
  /** 历史条目，最新的在前 */
  history: TerminalEntry[];
  /** 因超出缓冲上限而被丢弃的字符数（界面据此提示「输出不完整」） */
  dropped: number;
  /** 当前档位在本机不可用时的原因（可直接显示给人看）；为空表示正常 */
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
