import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger';
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
}

/**
 * 适配器选择策略。
 *
 * 默认仍是 mock，但理由与「契约未校准」无关 —— ACP 契约已于 2026-09-12 校准
 * （见 harness-sidecar.ts 顶部）。默认 mock 是因为真实内核要下载完整运行时
 * 并配置模型凭据：在没有显式要求的情况下静默去拉取，会让「装好就能跑」变成碰运气。
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
    const adapter = new HarnessSidecarAdapter({ ...options, ...harnessLaunch() });
    await adapter.start();
    return adapter;
  }

  if (process.env.DEEPWORK_HARNESS_CMD) {
    try {
      const adapter = new HarnessSidecarAdapter({ ...options, ...harnessLaunch() });
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
 * 真实内核的启动方式。
 *
 * 优先用仓库内 devDependency 的 dsh（node 直跑 bin.js —— Windows 上 spawn dsh.cmd
 * 会 EINVAL，.cmd 需要 shell；与 tools/real-dsh-e2e.js 同一形态）。
 * 找不到再退回 PATH 里的 dsh（用户全局安装的场景，比如打包后的应用）。
 * DEEPWORK_HARNESS_CMD 显式指定时尊重它（比如指向源码构建的 dsh）。
 */
function harnessLaunch(): { command?: string; args?: string[] } {
  if (process.env.DEEPWORK_HARNESS_CMD) {
    return { command: process.env.DEEPWORK_HARNESS_CMD };
  }
  // __dirname = packages/core-host/dist/adapter；仓库根在它上四级
  const localDsh = path.resolve(__dirname, '../../../../node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (fs.existsSync(localDsh)) {
    return { command: process.execPath, args: [localDsh, '--profile', 'acp'] };
  }
  return {};
}
