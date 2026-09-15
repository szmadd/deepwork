import fs from 'node:fs';
import path from 'node:path';
import type { SandboxMode } from '@deepwork/protocol';
import { createLogger } from '../logger';
import { sandboxLaunchEnv } from '../security/sandbox';
import { HarnessSidecarAdapter } from './harness-sidecar';
import { MockHarnessAdapter } from './mock-harness';
import type { HarnessAdapter } from './types';

const log = createLogger('adapter:factory');

export interface CreateAdapterOptions {
  workspace: string;
  model: string;
  /** 连接器补丁文件路径（真实内核启动时以 --patch 叠加；mock 忽略） */
  patchFile?: string;
  /** 内核选择（来自 AppConfig.adapter）；省略时按 DEEPWORK_ADAPTER 环境变量，再省略为 auto */
  mode?: 'auto' | 'mock' | 'harness';
  /**
   * 内核沙箱模式，交给内核的 `DSH_PERMISSION_MODE`。
   *
   * 由宿主解析一次后传入（而不是这里各自调一次解析函数）：解析结果要同时进
   * `HostStatus` 给界面看，两个地方各算一次的话，「界面上显示的」与「真正传给
   * 内核的」就有了两条独立的路径 —— 它们不一致的那天没有人会看到。
   */
  sandboxMode: SandboxMode;
}

/**
 * 适配器选择策略。
 *
 * 默认仍是 mock，但理由与「契约未校准」无关 —— ACP 契约已于 2026-09-12 校准
 * （见 harness-sidecar.ts 顶部）。默认 mock 是因为真实内核要下载完整运行时
 * 并配置模型凭据：在没有显式要求的情况下静默去拉取，会让「装好就能跑」变成碰运气。
 * 唯一的例外是一体化安装包：dsh 已随包内置（resources/dsh-runtime），不存在
 * 「静默去拉取」的问题，auto 模式直接尝试真实内核，失败再降级 mock。
 *
 * 切换方式：
 *   DEEPWORK_ADAPTER=harness        使用真实内核（dsh --profile acp），失败即报错，不降级
 *   DEEPWORK_ADAPTER=mock           强制 mock
 *   DEEPWORK_HARNESS_CMD=...        指定内核启动命令（设置后 auto 模式会尝试真实内核）
 *
 * 内核侧的文件写入会经由 ACP 的 fs/write_text_file 回到本项目执行，
 * 因此审批网关与逐 hunk 授权在真实内核下同样生效 —— 这不是巧合，
 * 而是选择 ACP 而非 headless 的主要原因之一。
 */
export async function createAdapter(options: CreateAdapterOptions): Promise<HarnessAdapter> {
  const mode = (options.mode ?? process.env.DEEPWORK_ADAPTER ?? 'auto').toLowerCase();

  if (mode === 'mock') {
    log.info('按配置使用 mock 内核');
    const adapter = new MockHarnessAdapter();
    await adapter.start();
    return adapter;
  }

  if (mode === 'harness') {
    log.info('按配置强制使用真实内核');
    const adapter = new HarnessSidecarAdapter({
      ...options,
      ...harnessLaunch(options.sandboxMode),
    });
    await adapter.start();
    return adapter;
  }

  if (process.env.DEEPWORK_HARNESS_CMD || bundledDshBin()) {
    try {
      const adapter = new HarnessSidecarAdapter({
        ...options,
        ...harnessLaunch(options.sandboxMode),
      });
      await adapter.start();
      return adapter;
    } catch (error) {
      log.warn(
        `真实内核启动失败，降级到 mock：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  log.info('未指定内核启动命令，使用 mock 内核');
  const adapter = new MockHarnessAdapter();
  await adapter.start();
  return adapter;
}

/**
 * 随包 dsh 的入口；不在一体化安装包形态下（开发态、源码运行）返回 null。
 *
 * __dirname = packages/core-host/dist/adapter。打包态上三级是 resources/，
 * 一体化安装包把 dsh 依赖布置在 resources/dsh-runtime/；开发态同一表达式
 * 指向 packages/dsh-runtime，不存在，existsSync 自然为否 —— 因此这条探测
 * 不会改变开发态「默认 mock」的行为，verify 各套件不受影响。
 */
function bundledDshBin(): string | null {
  const bin = path.resolve(__dirname, '../../../dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
  return fs.existsSync(bin) ? bin : null;
}

/**
 * 真实内核的启动方式。
 *
 * 优先级：DEEPWORK_HARNESS_CMD > 随包 dsh（一体化安装包）> 仓库内 devDependency
 * 的 dsh（node 直跑 bin.js —— Windows 上 spawn dsh.cmd 会 EINVAL，.cmd 需要
 * shell；与 tools/real-dsh-e2e.js 同一形态）> PATH 里的 dsh（用户全局安装的场景）。
 *
 * `env` 随内核进程一起给出，与启动命令同层：`DSH_PERMISSION_MODE` 是插件**加载期**
 * 读的配置（`dsh-sandbox-policy` 的 mode 默认值就是它），所以它与 `--patch` 一样
 * 属于启动参数，而不是能事后改的运行期指令。
 */
function harnessLaunch(sandboxMode: SandboxMode): {
  command?: string;
  args?: string[];
  env: Record<string, string>;
} {
  const env = sandboxLaunchEnv(sandboxMode);
  if (process.env.DEEPWORK_HARNESS_CMD) {
    return { command: process.env.DEEPWORK_HARNESS_CMD, env };
  }
  const bundled = bundledDshBin();
  if (bundled) {
    return { command: process.execPath, args: [bundled, '--profile', 'acp'], env };
  }
  // __dirname = packages/core-host/dist/adapter；仓库根在它上四级
  const localDsh = path.resolve(__dirname, '../../../../node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (fs.existsSync(localDsh)) {
    return { command: process.execPath, args: [localDsh, '--profile', 'acp'], env };
  }
  return { env };
}
