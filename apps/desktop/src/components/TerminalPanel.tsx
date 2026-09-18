import { useEffect, useMemo, useRef, useState } from 'react';
import { TERMINAL_SHELL_LABEL, type TerminalEntry } from '@deepwork/protocol';
import type { TerminalView } from '../useAgent';

interface TerminalPanelProps {
  terminal: TerminalView;
  onRun: (command: string) => void;
  onWrite: (data: string) => void;
  onInterrupt: () => void;
  onClear: () => void;
}

/**
 * 内置终端（流式命令台）。
 *
 * ── 它是什么 ──
 * 真实执行命令的终端：stdout/stderr 实时回显、退出码照实显示、`cd` 会推进后续命令的工作目录。
 * 运行中的命令可以直接在下面的输入框打字回送 stdin，因此 `npm init` 这类会追问一句的程序能用。
 *
 * ── 它刻意不是什么 ──
 * 不是 PTY，所以全屏 TUI（vim / top）跑不起来。这条边界写在界面上，而不是让人先试一次才发现。
 *
 * ── 两条界面纪律 ──
 * 1. **退出码常驻。** 「跑完了」和「跑成功了」是两件事，尤其在跑构建与测试时。
 *    只在非零时提示，会让人把「没报错」误读成「没问题」。
 * 2. **截断要说出来。** 输出被限流或界面缓冲写满时必须显式提示，
 *    否则用户会拿着一份不完整的日志去 debug。
 */
export function TerminalPanel({ terminal, onRun, onWrite, onInterrupt, onClear }: TerminalPanelProps) {
  const [input, setInput] = useState('');
  const [showTuiHint, setShowTuiHint] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const entries = useMemo(() => orderedEntries(terminal.state), [terminal.state]);
  const running = Boolean(terminal.state?.running);

  useEffect(() => {
    if (stickToBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [terminal.text, entries.length]);

  const submit = () => {
    const value = input.trim();
    if (!value || running) return;
    onRun(value);
    setInput('');
    stickToBottom.current = true;
  };

  return (
    <div className="panel-body terminal-panel">
      <div className="panel-toolbar">
        <code className="terminal-cwd" title={terminal.state?.cwd}>
          {terminal.state?.cwd ?? '未打开'}
        </code>
        {/*
          档位与实际可执行文件分两处显示：用户选的是「档位」，真正跑的是某个 exe，
          而同一个档位在不同机器上可能是 pwsh.exe 或 powershell.exe。
          合成一句话会让人以为「我选了 PowerShell」就等于「跑的一定是那个路径」。
        */}
        <code
          className="terminal-shell"
          title={terminal.state?.shell ? `实际可执行文件：${terminal.state.shell}` : '未解析到可执行文件'}
        >
          {terminal.state ? TERMINAL_SHELL_LABEL[terminal.state.shellKind] : '—'}
        </code>
        <span className="panel-spacer" />
        {running ? (
          <button type="button" className="btn btn-tiny btn-danger" onClick={onInterrupt}>
            中断
          </button>
        ) : null}
        <button type="button" className="btn btn-tiny" onClick={onClear} title="只清界面，不影响内核侧记录">
          清屏
        </button>
      </div>

      {/*
        档位解析不到可执行文件时提前拦住：是在这里直接说清，而不是等用户敲完命令
        才看到「启动失败」——后者看起来像是命令写错了，实际是这一档在本机根本没有。
      */}
      {terminal.state?.unavailable ? (
        <div className="panel-note panel-note-warn">{terminal.state.unavailable}</div>
      ) : null}

      {showTuiHint ? (
        <div className="panel-note panel-note-warn">
          命令台模式：输出实时回显、可回送输入；不支持全屏交互程序（vim / top），那需要伪终端。
          <button type="button" className="panel-note-close" onClick={() => setShowTuiHint(false)}>
            ×
          </button>
        </div>
      ) : null}

      <div
        className="terminal-out"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {entries.length === 0 ? (
          <div className="empty-hint">
            在下方输入命令。工作目录已设为当前会话的工作区（当前
            {terminal.state ? ` ${TERMINAL_SHELL_LABEL[terminal.state.shellKind]}` : ''}
            {terminal.state?.shell ? ` · ${terminal.state.shell}` : ''}）。
          </div>
        ) : null}

        {entries.map((entry) => (
          <div className="terminal-block" key={entry.id}>
            <div className="terminal-block-head">
              <span className={`terminal-status terminal-status-${entry.status}`}>
                {statusLabel(entry)}
              </span>
              <code className="terminal-cmd">{entry.command}</code>
            </div>
            <pre className="terminal-text">{terminal.text[entry.id] ?? ''}</pre>
            {entry.status === 'running' ? <span className="caret" /> : null}
          </div>
        ))}
      </div>

      <div className="terminal-input-row">
        <span className="terminal-prompt">&gt;</span>
        <input
          className="terminal-input"
          value={input}
          placeholder={running ? '命令运行中，输入的内容会送进它的 stdin（回车发送）' : '输入命令，回车执行'}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (running) {
                if (input) {
                  onWrite(`${input}\n`);
                  setInput('');
                }
                return;
              }
              submit();
            }
            // Ctrl+C：把中断意图翻译成宿主侧的动作，而不是往 stdin 塞一个 \x03 字符
            if (event.key === 'c' && event.ctrlKey && running) {
              event.preventDefault();
              onInterrupt();
            }
          }}
        />
        <button type="button" className="btn btn-tiny" onClick={running ? () => onWrite(`${input}\n`) : submit} disabled={!input && !running}>
          {running ? '回送' : '执行'}
        </button>
      </div>
    </div>
  );
}

function statusLabel(entry: TerminalEntry): string {
  if (entry.status === 'running') return '运行中';
  if (entry.status === 'interrupted') return '已中断';
  if (entry.status === 'failed') return '启动失败';
  return `退出 ${entry.exitCode ?? '?'}`;
}

/**
 * 把内核侧的状态快照摊平成「最旧在前」的条目序列。
 *
 * history 本身是最新在前，且**已经包含正在运行的那一条**（内核在启动时就登记了）。
 * 这里只补一种情况：RPC 快照还没回来、但 running 已经有值 —— 那时把它并进来，
 * 否则命令刚发出去的那一瞬间界面会显示「什么都没有」。
 */
function orderedEntries(state: TerminalView['state']): TerminalEntry[] {
  if (!state) return [];
  const list = [...state.history];
  if (state.running && !list.some((item) => item.id === state.running?.id)) {
    list.unshift(state.running);
  }
  return list.reverse();
}
