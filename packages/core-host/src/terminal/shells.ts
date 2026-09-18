/**
 * 终端 shell 的解析与调用形态。
 *
 * ── 为什么单独一个文件，而不是在 manager 里加几行 if ──
 *
 * 换 shell 不是「换一个字符串」：三档的**调用形态**根本不同，且各有实测过的坑。
 * 把这些坑固化成代码 + 测试，比留在注释里可靠 —— 注释不会在下次改动时拦住你。
 *
 * ── 三个实测结论（2026-09-18，本机 Windows）────────────────────
 *
 * 1. **不能把 `shell` 选项指向 powershell。**
 *    现有 cmd 路径用 `spawn(command, { shell })`，Node 在 Windows 上写死
 *    `/d /s /c` 且自行给参数加引号；换成 powershell.exe 后 PowerShell 会**重新解析
 *    原始命令行、把引号吃掉**。实测 `node -e "console.log(JSON.stringify(process.argv.slice(1)))"`
 *    变成「`process.argv.slice` 无法识别为 cmdlet」——命令被静默拆坏。
 *    所以 PowerShell 走**显式 argv**（不经 Node 的 shell 选项）。
 *
 * 2. **`-EncodedCommand` 不能用**，尽管它能规避引号：实测它的 stderr 会变成
 *    **CLIXML**（`#< CLIXML <Objs Version=...`），终端里看到的是一坨不可读的序列化 XML；
 *    而且不额外收尾时，退出码会被压成 1（真值 3 丢失）。
 *
 * 3. **`-Command` + 收尾尾码是全对的**：退出码原样带出（3 → 3）、
 *    cmdlet 报错给 1 且 **stderr 是可读文本**、双层引号不被吃、中文输出正常。
 *    代价是必须自己收尾（见 POWER_SHELL_TAIL），漏了就会出现
 *    「命令失败了界面却报成功」——所有失败都变成 0，最难发现的那类错。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TERMINAL_SHELL,
  type TerminalShell,
} from '@deepwork/protocol';

/**
 * PowerShell 前置：把输出编码钉成 UTF-8。
 *
 * 实测未设置时原始字节在本机已是合法 UTF-8，但那是本机的巧合（取决于
 * 控制台代码页与系统「Unicode UTF-8 全球语言支持」开关）。节点必须自己钉死，
 * 否则换一台机器中文输出就会变成 GBK，而 GBK 字节在 UTF-8 解码下是乱码 ——
 * 这类问题的表现是「中文偶尔花掉」，最难被当成 bug 报上来。
 */
export const POWERSHELL_PRELUDE = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';

/**
 * PowerShell 收尾：把真实退出码带出来。
 *
 * 顺序不能反：必须先取 `$?`（上一条语句是否成功），再取 `$LASTEXITCODE`
 * （原生命令的退出码）—— 任何赋值动作都会刷新 `$?`，
 * 写成 `$code = $LASTEXITCODE` 在前，`$?` 反映的就成了那次赋值。
 *
 * 两条分支各管一类失败，实测覆盖：
 *  - 原生命令失败（`node -e "process.exit(3)"`）→ 走第一条，带出 3；
 *  - cmdlet 报错 / 命令不存在（`Get-Item <不存在>`）→ `$LASTEXITCODE` 为空，走第二条给 1。
 * 漏掉任何一条都会静默变成「成功」。
 */
export const POWERSHELL_TAIL = [
  '$ok = $?',
  '$code = $LASTEXITCODE',
  'if ($code -ne $null -and $code -ne 0) { exit $code }',
  'if (-not $ok) { exit 1 }',
  'exit 0',
].join('\r\n');

/** 一次命令的具体调用形态 */
export interface TerminalInvocation {
  /** 可执行文件（绝对路径或 PATH 上的名字） */
  file: string;
  args: string[];
  /**
   * 是否把「命令文本」交给 Node 的 shell 选项去拼。
   *
   * 只有 cmd 走这条路（改动前验证过：Node 自己拼命令行在空格/嵌套引号/管道/退出码上都对）。
   * PowerShell 与 bash 都走显式 argv —— 理由见文件头第 1 条。
   */
  viaShellOption: boolean;
}

/** 一档 shell 的解析结果 */
export interface TerminalShellResolution {
  kind: TerminalShell;
  /** 解析到的可执行文件；null = 本机不可用 */
  exe: string | null;
  /** 不可用的原因（可直接显示给人看）；可用时为空串 */
  unavailable: string;
}

/** 在 PATH 上找可执行文件；找不到返回 null。找不到就是找不到，不做模糊匹配。 */
export function which(exe: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PATH ?? env.Path ?? '';
  const exts = (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  const hasExt = path.extname(exe) !== '';
  for (const dir of raw.split(path.delimiter).filter(Boolean)) {
    if (!hasExt) {
      for (const ext of exts) {
        const candidate = path.join(dir, exe + ext.toLowerCase());
        if (isFile(candidate)) return candidate;
        const upper = path.join(dir, exe + ext.toUpperCase());
        if (isFile(upper)) return upper;
      }
      continue;
    }
    const candidate = path.join(dir, exe);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * `System32\bash.exe` 是 **WSL 入口**，不是 Git Bash。
 *
 * 必须显式排除：选中它会在另一个文件系统里开 shell，而画面上看不出区别 ——
 * 用户以为自己在 Windows 工作区里敲 `ls`，其实看的是 WSL 的根目录。
 * 「解析不到就报未找到」比「悄悄换个文件系统」诚实得多。
 */
function isWslBash(target: string): boolean {
  const lower = target.toLowerCase().replace(/\//g, '\\');
  return lower.includes('\\system32\\bash.exe') || lower.includes('\\windowsapps\\bash.exe');
}

/**
 * 解析 Git Bash。
 *
 * 顺序：显式覆盖 → 从 `git.exe` 推出安装根目录 → 常见安装根目录。
 *
 * 从 git.exe 推导是首选：Git for Windows 的布局稳定，而安装根目录
 * （D 盘、非默认路径）在各机器上差异很大 —— 本机就装在 `D:\Program Files\Git`，
 * 写死 `C:\Program Files` 会直接找不到。
 *
 * ── 上溯级数不能写死一级（实测踩过）──────────────────────────
 * git.exe 在 Git for Windows 里有**多个落点**：`<root>\cmd\git.exe`（PATH 上最常见）、
 * `<root>\bin\git.exe`、`<root>\mingw64\bin\git.exe`。对应到 `<root>\bin\bash.exe`
 * 分别要上溯 1 / 1 / 2 级。只写死 2 级时，本机 PATH 上的 `D:\Program Files\Git\cmd\git.exe`
 * 会被推导成 `D:\Program Files\bin\bash.exe`（不存在）—— 结果是「装了 Git 却报未找到」，
 * 而这句话会让用户去重装一遍 Git。所以两种布局都试。
 */
export function resolveGitBash(env: NodeJS.ProcessEnv = process.env): TerminalShellResolution {
  const candidates: string[] = [];
  if (env.DEEPWORK_GIT_BASH) candidates.push(env.DEEPWORK_GIT_BASH);

  const git = which('git', env);
  if (git) {
    const dir = path.dirname(git); // <root>\cmd 或 <root>\bin 或 <root>\mingw64\bin
    for (const up of ['..', path.join('..', '..')]) {
      candidates.push(path.resolve(dir, up, 'bin', 'bash.exe'));
    }
  }

  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (root) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
  }

  for (const candidate of candidates) {
    if (!candidate || isWslBash(candidate)) continue;
    if (isFile(candidate)) return { kind: 'gitbash', exe: candidate, unavailable: '' };
  }

  return {
    kind: 'gitbash',
    exe: null,
    unavailable:
      '未找到 Git Bash（需要安装 Git for Windows）。本机 System32 下的 bash.exe 是 WSL 入口，' +
      '不在这里当替代品 —— 它会在另一个文件系统里开 shell。',
  };
}

/** 解析指定的 shell 档位 */
export function resolveTerminalShell(
  kind: TerminalShell = DEFAULT_TERMINAL_SHELL,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TerminalShellResolution {
  if (platform !== 'win32') {
    // 非 Windows 上不谈档位：只有系统 shell 一种，档位字段被忽略（设置页会如实说明）
    return { kind, exe: env.SHELL ?? '/bin/sh', unavailable: '' };
  }

  if (kind === 'cmd') {
    return { kind, exe: env.ComSpec ?? 'cmd.exe', unavailable: '' };
  }

  if (kind === 'gitbash') return resolveGitBash(env);

  // powershell：优先 pwsh（PowerShell 7，支持 && / ||），退到系统自带的 5.1
  const pwsh = which('pwsh', env);
  if (pwsh) return { kind, exe: pwsh, unavailable: '' };
  const legacy = which('powershell', env);
  if (legacy) return { kind, exe: legacy, unavailable: '' };
  return { kind, exe: null, unavailable: '未找到 PowerShell（pwsh 与 Windows PowerShell 均不在 PATH 上）' };
}

/** 构造一次命令的调用形态。`resolution.exe` 为 null 时调用方应先拦下，不该走到这里。 */
export function terminalInvocation(kind: TerminalShell, exe: string, command: string): TerminalInvocation {
  if (kind === 'cmd') {
    // 保持改动前的形态：Node 自己拼命令行，空格/嵌套引号/管道/退出码实测都对
    return { file: command, args: [], viaShellOption: true };
  }
  if (kind === 'gitbash') {
    // bash -c <整条命令>：命令作为单个 argv 传入，引号不会被再解析一层
    return { file: exe, args: ['-c', command], viaShellOption: false };
  }
  // PowerShell：-NoProfile 保证结果可复现（不加载用户 profile 的别名/函数）；
  // 收尾尾码是正确性的一部分，不是可选项（见文件头第 3 条）
  return {
    file: exe,
    args: ['-NoLogo', '-NoProfile', '-Command', `${POWERSHELL_PRELUDE}\r\n${command}\r\n${POWERSHELL_TAIL}`],
    viaShellOption: false,
  };
}
