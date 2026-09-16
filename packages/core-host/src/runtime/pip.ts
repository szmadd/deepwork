/**
 * pip 调用出口（ROADMAP §8.2）。
 *
 * 全仓任何要跑 pip 的地方都必须经过这里 —— 理由与 Python 解释器同一个：
 * 「源配在哪」如果散落在各个调用点，就会出现「某个功能走了内网源、另一个偷偷
 * 连公网」这种从配置上完全看不出来的行为。
 *
 * 两条硬规矩（对应 §8.2 的判据）：
 *  1. **参数，而不是配置文件**：源地址经 `--index-url` 注入，永不写目标机的
 *     `pip.ini`。配置文件是「这台机器以后都这么走」，命令行参数是「我们这次怎么走」——
 *     只有后者该由我们决定（见 INSTALL_POLICY.systemEnvironmentTouch）。
 *  2. **反过来也不读用户的配置**：`PIP_CONFIG_FILE` 指向空设备。目标机上一份
 *     陈年 `pip.ini` 会悄悄改变我们的行为，而那种故障没有任何线索指向它。
 *
 * 未配置源时**一个参数都不加**：pip 走它自己的默认行为，离线机器上如实报错。
 * 不伪造默认源、不静默回落到公网 —— 「装了个来路不明的包」比「装不上」严重得多。
 */

import { spawnSync } from 'node:child_process';
import { pipSourceArgs, describePipSource, type PipSource } from '@deepwork/protocol';
import type { RuntimeResolution } from '@deepwork/protocol';
import { pythonRuntimeEnv } from './python';

/**
 * 拼出 pip 的 argv —— **不含解释器路径**。
 *
 * 调用方是 `spawnSync(python.bin, pipArgv(...))`，把 bin 与参数分开传。
 * 刻意不在这里把 bin 拼进数组（虽然那样看起来更方便）：一旦拼进去，
 * 「数组的第 0 项是可执行文件」就成了隐式约定，而 `spawnSync` 的签名不接受
 * 这种数组 —— 于是每个调用点都得再 `slice(1)` 一次，反而更容易错。
 *
 * 顺序是 `<子命令…> <源参数…>`：源参数放最后，对每个子命令都生效，
 * 且不与子命令自己的位置参数打架。
 */
export function pipArgv(
  python: RuntimeResolution,
  command: string[],
  source?: PipSource,
): string[] {
  return [...python.args, '-m', 'pip', ...command, ...pipSourceArgs(source)];
}

/**
 * pip 子进程的环境变量。
 *
 * 三件事，每件都对应一类「无声地出错」：
 *  - 继承 `pythonRuntimeEnv`：随包命中时前置 PATH、清掉 PYTHONHOME；
 *  - `PIP_CONFIG_FILE` 指向空设备：不读用户的 pip 配置；
 *  - `PIP_NO_INPUT=1`：pip 在凭据缺失一类情况下会**等人输入**，
 *    而我们是无人值守的 —— 那会表现为进程挂住，不是报错。
 */
export function pipEnv(
  python: RuntimeResolution,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = pythonRuntimeEnv(python, base);
  env.PIP_CONFIG_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  env.PIP_NO_INPUT = '1';
  return env;
}

export interface PipRunResult {
  /** 进程退出码；-1 表示连进程都没起来 */
  code: number;
  stdout: string;
  stderr: string;
  /** 实际执行的 argv（诊断时最有用的一行：源到底注进去了没有） */
  argv: string[];
  /** 本次实际生效的源说明（未配置时如实说「未配置」） */
  source: string;
}

/**
 * 跑一次 pip。同步是有意的：pip 的安装动作本身以分钟计，调用方不会想在这上面做并发，
 * 而同步版本在测试里可以直读结果，不需要等 Promise。
 */
export function runPip(
  python: RuntimeResolution,
  command: string[],
  options: { source?: PipSource; cwd?: string; timeoutMs?: number } = {},
): PipRunResult {
  const argv = pipArgv(python, command, options.source);
  const result = spawnSync(python.bin, argv, {
    encoding: 'utf8',
    cwd: options.cwd,
    env: pipEnv(python),
    timeout: options.timeoutMs ?? 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    argv,
    source: describePipSource(options.source),
  };
}

/**
 * 判断 pip 的输出是「源连不上」还是「源通了但没有这个包」。
 *
 * 为什么要这个区分：对「测试内网源」这个动作，两者的含义完全相反 ——
 * 前者是配置错，后者说明源是通的、只是还没往里面推包。
 * 只看退出码会把它们混成同一个「失败」。
 *
 * 这是**关键词判定**，不是结构化协议：pip 没有给机器读的错误码。
 * 所以这里的词表按 pip 25.x 的实际输出写，并在识别不出时**如实返回 unknown**
 * （而不是猜一个）—— 猜错的方向是把「连不上」说成「通了」，那会让人白查半天。
 */
export type PipFailureKind = 'unreachable' | 'not-found' | 'unknown';

const UNREACHABLE_HINTS = [
  'failed to establish a new connection',
  'connection refused',
  'connection reset',
  'temporary failure in name resolution',
  'name or service not known',
  'getaddrinfo failed',
  'timed out',
  'ssl',
  'certificate verify failed',
  'proxy',
];

const NOT_FOUND_HINTS = [
  'no matching distribution found',
  'could not find a version that satisfies',
  '404 client error',
];

export function classifyPipFailure(text: string): PipFailureKind {
  const haystack = text.toLowerCase();
  if (NOT_FOUND_HINTS.some((hint) => haystack.includes(hint))) return 'not-found';
  if (UNREACHABLE_HINTS.some((hint) => haystack.includes(hint))) return 'unreachable';
  return 'unknown';
}
