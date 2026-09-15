import { SANDBOX_MODES, type SandboxMode, type SandboxModeSource } from '@deepwork/protocol';

/**
 * 内核沙箱模式：产品在哪决定它、怎么交给内核、以及平台边界。
 *
 * ── 为什么不「不设它，让内核用默认」───────────────────────────────────
 * 这是 2026-09-15 取证后的结论。此前产品从未设置 `DSH_PERMISSION_MODE`，
 * 于是内核一直跑在它自己的默认值 `workspace-write` 上 —— 沙箱**一直在生效**，
 * 但产品侧查不到这件事：界面上没有一处能回答「模型的写入到底受什么约束」。
 * 「依赖一个我们没读过的默认值」与「产品显式声明一个值」在行为上等价，
 * 在可核验性上不等价：前者内核改默认的那天我们会静默跟着变。
 *
 * 因此本模块显式给出模式，并把它记下来交给 `HostStatus`。
 *
 * ── 模式为什么只能在启动时定 ──────────────────────────────────────────
 * `dsh-permission-presets` 与 `dsh-sandbox-policy` 都支持逐会话切换，但那是
 * 内核自己 UI 的能力；ACP 面明确把它列为**不暴露**（`dsh-acp` README 的
 * 「已知限制」：mode 不属于此自动化界面；`session/set_config_option` 只认
 * `model` 与 `reasoning_effort`）。所以对我们而言它是**进程级**的启动参数，
 * 与端点补丁同一形态：改了要重启内核才生效。
 */

/** 传给内核的键。名字由内核拥有（`dsh-sandbox-policy` 的 mode 来源）。 */
export const KERNEL_SANDBOX_ENV = 'DSH_PERMISSION_MODE';

/** 产品侧覆盖入口。与 `DEEPWORK_ADAPTER` / `DEEPWORK_HARNESS_CMD` 同一族的运维开关。 */
export const SANDBOX_MODE_ENV = 'DEEPWORK_SANDBOX_MODE';

/**
 * 产品默认 = 内核默认。
 *
 * 取证（`tools/sandbox-test.js`，2026-09-15）确认本机 Windows 上该默认值确实
 * 由 ACL 受限令牌强制执行：`workspace-write` 下工作区内写成功、工作区外写
 * `EPERM`；`read-only` 下连工作区内写也 `EPERM`。
 *
 * **不要**为了「更安全」把它静悄悄改成 `read-only`：那会让模型连工作区都写不了，
 * 整个产品的主要用途（改代码）当场失效。要改必须是一个明示的产品决策。
 */
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write';

export interface SandboxModeResolution {
  mode: SandboxMode;
  source: SandboxModeSource;
  /**
   * 覆盖值给了但不可用时的原值（界面据此提示「你设的值没被采用」）。
   * 非法的覆盖**不会**被静默采纳，也不会被静默丢弃 —— 它落到默认值，
   * 同时留下痕迹。`danger-full-access` 这种打错的宽值尤其不能默默生效。
   */
  rejected?: string;
}

/**
 * 解析本次启动要用的沙箱模式。
 *
 * 优先级：
 *   1. `DEEPWORK_SANDBOX_MODE` —— 产品侧显式覆盖（推荐入口）
 *   2. `DSH_PERMISSION_MODE`   —— 用户直接设的内核变量
 *   3. 产品默认
 *
 * 第 2 条必须认，否则会出事：我们总是把 `DSH_PERMISSION_MODE` 叠加进内核环境，
 * 若只认第 1 条，一个已经在环境里设了 `DSH_PERMISSION_MODE=read-only` 的用户
 * 会被我们用产品默认**静默改回去** —— 用户设的值不生效、界面上还看不出来。
 *
 * 非法值一律回落到 `DEFAULT_SANDBOX_MODE` 并带上 `rejected`，不抛异常：
 * 一个拼错的环境变量不该让整个应用起不来，但也不能没有任何痕迹。
 */
export function resolveSandboxMode(env: NodeJS.ProcessEnv = process.env): SandboxModeResolution {
  const raw = env[SANDBOX_MODE_ENV] ?? env[KERNEL_SANDBOX_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { mode: DEFAULT_SANDBOX_MODE, source: 'product-default' };
  }
  const value = raw.trim();
  if ((SANDBOX_MODES as readonly string[]).includes(value)) {
    return { mode: value as SandboxMode, source: 'env-override' };
  }
  return { mode: DEFAULT_SANDBOX_MODE, source: 'product-default', rejected: value };
}

/**
 * 交给内核子进程的环境变量增量。
 *
 * `AcpClient` 把这份增量**叠加**在 `process.env` 之上（不是替换），
 * 所以这里只需要给出我们明确要改的那一个键。
 */
export function sandboxLaunchEnv(mode: SandboxMode): Record<string, string> {
  return { [KERNEL_SANDBOX_ENV]: mode };
}

/**
 * 该平台的**已知边界**说明；没有已知边界的平台返回 null。
 *
 * ⚠️ 这是**平台级的事实**，来自内核包的自述，不是运行时测量值：
 *  - win32：`dsh-sandbox-windows-acl` README「已知限制」—— 该档报告
 *    `enforcement: 'partial'`，因为受限令牌必须保留 Everyone 才能完成进程初始化
 *    （授予 Everyone 写访问的外部对象仍可写），且 NTFS 硬链接会让工作区路径与
 *    外部路径指向同一文件对象；另外它**只交叉检查写访问**，读、网络与进程可见性不受限。
 *  - 其他平台：不声明，返回 null（宁可不说，也不把没读过的平台说成已知）。
 *
 * 它可以显示给用户，但**不要**把它写成「运行时观测到的强制执行等级」——
 * ACP 面不暴露这个事实，我们拿不到，编一个出来就是第二个 `contextWindow: 256_000`。
 */
export function sandboxPlatformNote(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') {
    return '本平台为部分强制：只限制写入，读/网络不受限；Everyone 与 NTFS 硬链接是已知例外';
  }
  return null;
}
