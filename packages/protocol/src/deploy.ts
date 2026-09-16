/**
 * 部署与安装契约（ROADMAP §八）。
 *
 * 这一节回答两个问题：「装的时候、装完以后运行时从哪来」，以及「目标机上已有的东西怎么办」。
 *
 * 它们**不是文案**，而是安装器与运行时的共同事实来源：
 *   - `apps/desktop/electron-builder.yml` 的 nsis 段必须与 `INSTALL_POLICY` 一致；
 *   - node / python 的解析实现必须与 `RUNTIME_RESOLUTION_ORDER` 一致。
 *
 * 两边对不上时 `tools/installer-test.js` 会红 —— 这正是这份契约存在的理由：
 * 「文档说保留数据、安装器却在删」这种事，靠人读文档是发现不了的。
 */

/** 运行时数据根目录名（位于用户主目录下）。 */
export const DATA_DIR_NAME = '.deepwork';

/** 随包运行时（一体化离线安装包携带的三种） */
export type BundledRuntimeKind = 'node' | 'python' | 'dsh';

/**
 * 随包运行时的钉死版本。
 *
 * 为什么钉死而不跟随最新：目标机离线，升级只能随安装包整体升级
 * （见 `INSTALL_POLICY.runtimeUpgrade`）。版本号是**维护者重建随包目录时要照抄的数**，
 * 所以放在契约里，而不是散落在文档与说明文本中各自表述。
 *
 * **python 为什么是 3.12.10 而不是 3.12 系列最新（3.12.14）**：3.12.11 起 python.org
 * **不再发布 Windows 二进制产物** —— `python-3.12.11..14-embed-amd64.zip` 全部 404，
 * 目录里只剩源码 tarball（2026-09-16 实测，见 DEVLOG）。3.12 已进入 security-only 阶段，
 * 该阶段只发源码。随包需要的是「解压即用的二进制形态」，所以只能停在最后一个
 * 带 Windows 二进制的 3.12 版本。**不要**看到 3.12.14 更新就去改这个数：
 * 改了会得到一个 404。
 */
export const BUNDLED_RUNTIMES: Record<BundledRuntimeKind, string> = {
  node: '24.14.0',
  python: '3.12.10',
  dsh: '0.1.5-rc.1',
};

/** 让应用改用指定运行时（而不是随包那份）的环境变量 */
export const RUNTIME_ENV_OVERRIDE = {
  node: 'DEEPWORK_NODE_BIN',
  python: 'DEEPWORK_PYTHON_BIN',
} as const;

/**
 * 运行时解析顺序（三档，node 与 python 同构）。
 *
 * 顺序即优先级，**随包优先于系统**。理由：目标机上可能装着一个版本不符的系统运行时
 * （比如 Python 3.9），若被优先选中，出问题的方式是「偶发、与环境相关」的 ——
 * 最难定位的那一类。想让应用改用系统运行时，必须用 `RUNTIME_ENV_OVERRIDE` 显式指定，
 * 不能靠 PATH 顺序碰运气。
 */
export const RUNTIME_RESOLUTION_ORDER = ['explicit-env', 'bundled', 'system-path'] as const;

export type RuntimeResolutionSource = (typeof RUNTIME_RESOLUTION_ORDER)[number];

/** 运行时解析结果：给谁用（bin）、怎么用（args/env）、以及**来源的可读说明** */
export interface RuntimeResolution {
  bin: string;
  args: string[];
  env?: Record<string, string>;
  /** 三档之一 —— 测试断言用它，不看文案 */
  source: RuntimeResolutionSource;
  /** 界面上显示的「当前用的是哪一个」（含版本号等细节） */
  label: string;
}

/**
 * 当前运行时状态（界面用的快照）。
 *
 * `bundledDirs` 也一并交出去：解析失败时界面不能只说「没找到」——
 * 那让人不知道该去哪看。把「找过哪几个地方」列出来，
 * 才有「哦，我的随包目录不在这儿」这种能自己往下查的结论。
 */
export interface RuntimeStatus {
  found: boolean;
  source: RuntimeResolutionSource | null;
  label: string;
  bin: string | null;
  bundledDirs: string[];
}

/**
 * 体检项的分级（§8.3）。
 *
 * `block` = 装不下去或跑不起来；`warn` = 能力降级但可用。
 * 分级必须按**实际后果**定，不按「看起来严不严重」：把「随包 Python 缺失」
 * 标成阻断会让用户在没坏的时候不敢装，而标反的另一面是真出问题时装了上去。
 */
export type PreflightLevel = 'block' | 'warn';

export interface PreflightCheck {
  id: string;
  level: PreflightLevel;
  /** 人话标题（报告里直接显示） */
  title: string;
  ok: boolean;
  /** 现状：查到了什么 */
  detail: string;
  /** 怎么办：不通过时给的动作。允许为空话的建议等于把问题原样丢回给用户 */
  remedy: string;
}

export interface PreflightReport {
  /** 无阻断项即为 true —— 有警告仍可安装，只是能力会降级 */
  ok: boolean;
  checks: PreflightCheck[];
  blocked: number;
  warned: number;
}

/**
 * 已安装组件的处置策略（ROADMAP §8.4）。
 *
 * 用户原话：「node、python，以及本身已经安装过的，也要考虑是覆盖还是怎样」。
 * 这一条定错了会动到用户机器上不属于我们的东西，所以逐条写成可断言的字面量。
 */
export interface InstallPolicy {
  /**
   * 应用本体：同 appId 重装 = **修复式覆盖**（同版本允许重装、升级直接覆盖）。
   * 不用「并存多个版本」：内核、dsh 运行时、dsh 家目录三者版本必须一致，
   * 并存会让「哪个 exe 配哪份运行时」变成无人能答的问题。
   */
  appOverwrite: 'repair-in-place';
  /**
   * 降级安装**不静默覆盖**：装一个比已装版本旧的包，安装器拦下并提示。
   * 静默降级会让「用户以为升级了、其实退回了旧版」，而这件事毫无迹象。
   */
  allowDowngrade: boolean;
  /** 用户数据目录名（位于用户主目录下，与安装目录**不同树**） */
  userDataDirName: string;
  /** 覆盖安装（升级/修复）不动用户数据 */
  userDataSurvivesUpgrade: boolean;
  /** 卸载也不动用户数据 */
  userDataSurvivesUninstall: boolean;
  /**
   * 清数据的触发方式。
   *
   * `manual-explicit` = 只有用户显式动作才删，卸载流程的默认分支是保留。
   * 这里刻意**没有**写成「卸载向导里可勾选」：勾选项需要自定义 NSIS 脚本，
   * 而本机没有 NSIS 工具链、无法验收。按「不假装完成」的纪律，
   * 只声明默认保留与显式清理的路径（见 docs/DEPLOY.md）。
   */
  userDataPurge: 'manual-explicit';
  /** 一律不动系统环境：不写 PATH、不写注册表、不做文件关联、不替换系统运行时 */
  systemEnvironmentTouch: 'never';
  /** 随包运行时的升级方式：只能随安装包整体升级，不做热更新（与 M2-K 挂起同源） */
  runtimeUpgrade: 'package-only';
}

export const INSTALL_POLICY: InstallPolicy = {
  appOverwrite: 'repair-in-place',
  allowDowngrade: false,
  userDataDirName: DATA_DIR_NAME,
  userDataSurvivesUpgrade: true,
  userDataSurvivesUninstall: true,
  userDataPurge: 'manual-explicit',
  systemEnvironmentTouch: 'never',
  runtimeUpgrade: 'package-only',
};

/**
 * 内网 pip 源（ROADMAP §8.2）。
 *
 * 场景是**局域网镜像**（devpi / Nexus / 静态目录），不是「换个国内镜像」——
 * 后者的前提是能上公网，而这条需求的前提恰恰是不能上。
 *
 * 未配置时**什么都不做**：不伪造一个默认源、也不悄悄回落到公网 PyPI。
 * 离线机器上 pip 会如实报连不上，那是正确的结果 —— 比「静默换了个源、
 * 装了个来路不明的包」好得多。
 */
export interface PipSource {
  /** 主索引地址，形如 http://nexus.corp/repository/pypi/simple */
  indexUrl: string;
  /**
   * 受信主机（单个主机名，不带 scheme），对应 pip 的 `--trusted-host`。
   *
   * 内网源常见 http 或自签证书，pip 默认会拒；必须显式列出才算授权 ——
   * 这是刻意的：产品不替用户做「全都信」的决定。
   */
  trustedHost?: string;
}

/**
 * pip 源参数校验。
 *
 * 只校验「是不是一个 http(s) 地址」和「trustedHost 是不是光秃秃的主机名」——
 * 不做「这个地址通不通」的判断，那是设置页「测试」按钮的职责
 * （与模型端点同一分工：校验管形状，测试管连通）。
 */
export function validatePipSource(source: PipSource): void {
  if (!source || typeof source.indexUrl !== 'string' || !source.indexUrl.trim()) {
    throw new Error('pip 源地址不能为空');
  }
  if (!/^https?:\/\/[^\s]+$/i.test(source.indexUrl.trim())) {
    throw new Error('pip 源地址必须以 http:// 或 https:// 开头（例如 http://nexus.corp/repository/pypi/simple）');
  }
  if (source.trustedHost !== undefined) {
    const host = source.trustedHost.trim();
    if (!host) throw new Error('受信主机不能是空字符串（不需要就留空，不要填空白）');
    // 带 scheme 或带端口的写法 pip 不接受，且报错发生在安装中途 —— 在这里拦下
    if (/[/:]/.test(host)) {
      throw new Error('受信主机只填主机名，不带 http:// 也不带端口（例如 nexus.corp）');
    }
  }
}

/**
 * 把 pip 源翻译成 pip 命令行参数。
 *
 * **一律走命令行参数，永不写目标机的 `pip.ini`**：写配置文件等于污染用户环境，
 * 且会在「为什么这台机器的 pip 行为跟别的不一样」这种问题上留下无法追溯的痕迹
 * （与「一律不动系统环境」同源，见 INSTALL_POLICY.systemEnvironmentTouch）。
 *
 * 未配置时返回空数组 —— 一个参数都不加，让 pip 自己按默认行为走。
 */
export function pipSourceArgs(source: PipSource | undefined): string[] {
  if (!source || !source.indexUrl) return [];
  const args = ['--index-url', source.indexUrl.trim()];
  if (source.trustedHost && source.trustedHost.trim()) {
    args.push('--trusted-host', source.trustedHost.trim());
  }
  return args;
}

/** pip 源的一句话说明，供设置页与日志显示（未配置时如实说「未配置」） */
export function describePipSource(source: PipSource | undefined): string {
  if (!source || !source.indexUrl) return '未配置（pip 走它自己的默认源）';
  return source.trustedHost ? `${source.indexUrl}（受信主机 ${source.trustedHost}）` : source.indexUrl;
}
