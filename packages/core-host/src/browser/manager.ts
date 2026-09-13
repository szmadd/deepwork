import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  BROWSER_ENDPOINT_FILE,
  BROWSER_PROFILE_DIR,
  BROWSER_SHOTS_DIR,
  type BrowserAction,
  type BrowserEndpoint,
  type BrowserState,
} from '@deepwork/protocol';
import { homeDir, readJson, writeJson } from '../paths';
import { CdpClient, findBrowserExecutable, killProcessTree, launchBrowser, probeBrowser } from './cdp';
import {
  logBrowserFailure,
  runBrowserAction,
  type ActionArgs,
  type ActionOutcome,
} from './actions';
import { createLogger } from '../logger';

const log = createLogger('browser:manager');

/**
 * 浏览器生命周期管理（宿主侧）。
 *
 * ── 懒启动 ──────────────────────────────────────────────────────────
 * 宿主启动时不碰浏览器：绝大多数会话根本不用它，而提前拉一个 Chromium
 * 是实打实的几百 MB 内存与一个可见进程。第一次真正需要时才启动。
 *
 * ── 谁拉起谁负责，但「应用级资源」由宿主兜底 ────────────────────────
 * 正常情况下浏览器是本进程拉起的，close() 直接杀自己那个 child。
 * 但内核侧的 MCP 服务也会拉起浏览器（它是另一个进程），此时本进程只是
 * 一个「借用人」—— 借用人不该杀掉别人的进程。所以：
 *  - 我们拉起的 → 杀 child（taskkill /T /F，含渲染子进程）；
 *  - 别人拉起的 → 只断开连接，把杀进程留给它的拉起者；
 *  - 宿主停止（stop）时按 endpoint 文件里记录的 pid 无条件收尾：
 *    宿主退出等于应用退出，此时浏览器是必须清掉的资源，
 *    「谁拉的」这个问题在应用退出时已经没有意义了。
 */

export interface BrowserSession {
  client: CdpClient;
  sessionId: string;
}

export class BrowserManager {
  /** 本进程拉起的浏览器 child；借用的别人的浏览器时为 null */
  private child: ChildProcess | null = null;
  private client: CdpClient | null = null;
  private sessionId: string | null = null;
  /** 最近一次已知的页面信息（面板轮询读这个，不每次去连 CDP） */
  private lastUrl = '';
  private lastTitle = '';
  /** 已经连上但页面会话失效时用它去重连（页面被关掉是常态） */
  private endpoint: BrowserEndpoint | null = null;

  /**
   * @param options.executablePath 指定浏览器可执行文件（测试注入；正常走 findBrowserExecutable）
   * @param options.launchTimeoutMs 等待 stderr 握手行的上限。
   *   测试要验证「启动失败如实报错」，而默认 20 秒的超时会让一次失败断言等满 20 秒。
   */
  constructor(private readonly options: { executablePath?: string; launchTimeoutMs?: number } = {}) {}

  private endpointFile(): string {
    return path.join(homeDir(), BROWSER_ENDPOINT_FILE);
  }

  shotsDir(): string {
    return path.join(homeDir(), BROWSER_SHOTS_DIR);
  }

  private profileDir(): string {
    return path.join(homeDir(), BROWSER_PROFILE_DIR);
  }

  /** 读 endpoint 文件（唯一的跨进程事实来源）；文件不存在或损坏都返回 null */
  private readEndpoint(): BrowserEndpoint | null {
    const value = readJson<BrowserEndpoint | null>(this.endpointFile(), null);
    if (!value || typeof value.port !== 'number' || typeof value.wsUrl !== 'string') return null;
    return value;
  }

  /**
   * 面板用的状态。
   *
   * running 的判据是「endpoint 文件在，且里面的 pid 还活着」——
   * 不靠内存里的 child（借用别人的浏览器时它是 null），
   * 也不每次去探测端口（面板刷新比浏览器命令频繁得多）。
   * pid 活着但端口不通（浏览器正在退出）这种情况会由下一次真实调用暴露出来，
   * 那正是该暴露它的地方。
   */
  state(): BrowserState {
    const endpoint = this.readEndpoint();
    this.endpoint = endpoint;
    if (!endpoint || !isPidAlive(endpoint.pid)) {
      return { running: false, shotCount: countShots(this.shotsDir()) };
    }
    return {
      running: true,
      pid: endpoint.pid,
      port: endpoint.port,
      executable: endpoint.executable,
      url: this.lastUrl || undefined,
      title: this.lastTitle || undefined,
      shotCount: countShots(this.shotsDir()),
    };
  }

  /**
   * 确保有一个可用的浏览器与页面会话。
   *
   * 顺序刻意是「先复用、后拉起」：endpoint 文件里如果有一个活着的浏览器
   * （可能是内核侧 MCP 服务拉起的），我们连上去共用它 —— 否则面板与 Agent
   * 会各看一个浏览器，用户看到的页面和模型操作的不是同一个。
   */
  async ensure(): Promise<BrowserSession> {
    if (this.client && this.sessionId) return { client: this.client, sessionId: this.sessionId };

    const existing = this.readEndpoint();
    if (existing && (await probeBrowser(existing.port))) {
      try {
        const session = await this.connect(existing.wsUrl);
        this.endpoint = existing;
        this.child = null; // 借用人：不持有该进程，也就不负责杀它
        log.info(`复用已在运行的浏览器（pid=${existing.pid}, port=${existing.port}）`);
        return session;
      } catch (error) {
        // 复用失败就当作没有：往下走拉起新实例。这里不抛，是因为
        // 「别人的浏览器半死不活」不该让本进程的浏览器能力一起失效。
        log.warn('复用既有浏览器失败，将拉起新实例', String(error));
      }
    }

    const executable = this.options.executablePath ?? findBrowserExecutable();
    if (!executable) {
      throw new Error(
        '未找到可用的浏览器（需要 Microsoft Edge 或 Google Chrome）。' +
          '可用 DEEPWORK_BROWSER_PATH 指定浏览器可执行文件路径。',
      );
    }

    const launched = await launchBrowser({
      executable,
      userDataDir: this.profileDir(),
      // 默认无界面（后台能力不该弹窗）；调试时 DEEPWORK_BROWSER_HEADFUL=1 看得到它
      headless: process.env.DEEPWORK_BROWSER_HEADFUL !== '1',
      ...(this.options.launchTimeoutMs ? { timeoutMs: this.options.launchTimeoutMs } : {}),
    });

    const fresh: BrowserEndpoint = {
      pid: launched.child.pid ?? 0,
      port: launched.port,
      wsUrl: launched.browserWsUrl,
      executable: launched.executable,
      startedAt: Date.now(),
    };

    /**
     * 并发收敛：宿主与内核侧的 MCP 服务可能同时被叫醒（agent 的第一条浏览器
     * 调用正好撞上用户点开面板）。两边各自都做过「先看有没有」的检查，但检查
     * 与写入之间总有一道窗口。写之前再看一眼：如果别人抢先写入了并且是活的，
     * 就把自己刚拉起的这个收掉，改用对方那个 —— 宁可白拉一次，也不要留下
     * 一个没人认领的浏览器进程（它会一直占着内存，直到用户重启机器）。
     */
    const raced = this.readEndpoint();
    if (raced && raced.pid !== fresh.pid && (await probeBrowser(raced.port))) {
      log.warn(`检测到并发拉起（pid=${raced.pid} 抢先），收掉本进程拉起的 pid=${fresh.pid}`);
      killProcessTree(launched.child);
      const session = await this.connect(raced.wsUrl);
      this.endpoint = raced;
      this.child = null;
      return session;
    }

    writeJson(this.endpointFile(), fresh);
    this.endpoint = fresh;
    this.child = launched.child;
    const session = await this.connect(fresh.wsUrl);
    log.info(`浏览器已启动 pid=${fresh.pid} port=${fresh.port} (${launched.executable})`);
    return session;
  }

  private async connect(wsUrl: string): Promise<BrowserSession> {
    const client = new CdpClient(wsUrl);
    await client.connect();
    const { sessionId } = await client.attachToPage();
    this.client = client;
    this.sessionId = sessionId;
    return { client, sessionId };
  }

  /**
   * 执行一个动作（宿主侧工具走这里）。
   * 会话失效（页面被关掉 / 浏览器重启）时重连一次再试 —— 这类失败是常态，
   * 让模型自己重试等于把一次可自愈的抖动变成一次「工具不好使」。
   */
  async run(action: BrowserAction, args: ActionArgs): Promise<ActionOutcome> {
    const first = await this.attempt(action, args, false);
    if (first !== null) return first;
    const second = await this.attempt(action, args, true);
    if (second !== null) return second;
    throw new Error(`浏览器动作 ${action} 失败（重连后仍未成功）`);
  }

  /** 返回 null 表示「会话失效，值得重连一次再试」 */
  private async attempt(
    action: BrowserAction,
    args: ActionArgs,
    isRetry: boolean,
  ): Promise<ActionOutcome | null> {
    try {
      const { client, sessionId } = await this.ensure();
      const outcome = await runBrowserAction({
        client,
        sessionId,
        action,
        args,
        shotsDir: this.shotsDir(),
      });
      if (outcome.url) this.lastUrl = outcome.url;
      if (outcome.title !== undefined) this.lastTitle = outcome.title;
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logBrowserFailure(action, error);
      // 会话类错误（连接断开、页面目标没了）重连一次；参数类错误（元素没找到、
      // URL 不合法）重试没有任何意义，直接如实报出。
      if (!isRetry && isSessionError(message)) {
        this.dropConnection();
        return null;
      }
      throw error;
    }
  }

  /** 断开连接与页面会话（不杀进程） */
  private dropConnection(): void {
    try {
      this.client?.close();
    } catch {
      // 已经断开就没什么可关的
    }
    this.client = null;
    this.sessionId = null;
  }

  /**
   * 关闭浏览器（面板上的「关闭」按钮）。
   *
   * 只关自己拉起的那个；借用的别人的实例只断开连接 —— 面板没有权限替
   * 另一个进程做主。返回文案里如实说明是哪种，避免用户按了「关闭」却发现
   * 进程还在（那看起来就像一个没生效的按钮）。
   */
  close(): { ok: true; message: string } {
    const endpoint = this.readEndpoint();
    if (!endpoint) {
      this.dropConnection();
      return { ok: true, message: '浏览器未在运行' };
    }

    if (this.child && this.child.pid === endpoint.pid) {
      killProcessTree(this.child);
      this.child = null;
    } else {
      // 不是本进程拉起的：本次调用只断开连接
      this.dropConnection();
      return {
        ok: true,
        message: `已断开与浏览器（pid=${endpoint.pid}）的连接。该实例由内核侧的浏览器服务拉起，进程会随它一起退出。`,
      };
    }

    this.dropConnection();
    try {
      fs.rmSync(this.endpointFile(), { force: true });
    } catch (error) {
      log.warn('删除浏览器端点文件失败', String(error));
    }
    this.lastUrl = '';
    this.lastTitle = '';
    log.info(`浏览器已关闭 pid=${endpoint.pid}`);
    return { ok: true, message: `已关闭浏览器（pid=${endpoint.pid}）` };
  }

  /**
   * 进程退出时的收尾。
   *
   * 只收**本进程拉起的**那个浏览器。这一段是有意与「按 endpoint 文件收尾」
   * 划清界限的：端点的持有方可能是另一个进程（内核侧的 MCP 服务），
   * 而「我要退出了」并不等于「那个浏览器可以杀了」—— 宿主退出时内核随即退出、
   * MCP 服务跟着退出，它会在自己的收尾里把浏览器收掉，链路是闭合的。
   * 反过来若在这里按 endpoint 的 pid 无条件杀，借用方的一次退出就会让
   * 另一个进程正在用的浏览器凭空消失，而它要等到下一次调用才发现。
   */
  async shutdown(): Promise<void> {
    const owned = this.child;
    this.dropConnection();
    this.child = null;
    if (!owned || !owned.pid) return;

    const pid = owned.pid;
    killProcessTree(owned);
    this.endpoint = null;
    this.lastUrl = '';
    this.lastTitle = '';
    try {
      const endpoint = readJson<BrowserEndpoint | null>(this.endpointFile(), null);
      // 只删「这个端点确实是自己的」那一份：万一它已经被别人接管，删掉会把
      // 一个仍然有效的实例信息抹掉，下一个调用者会白拉一个浏览器
      if (!endpoint || endpoint.pid === pid) fs.rmSync(this.endpointFile(), { force: true });
    } catch (error) {
      log.warn('清理浏览器端点文件失败', String(error));
    }
    log.info(`宿主停止：已终止浏览器进程树 pid=${pid}`);
  }
}

/** pid 是否活着（Windows 上 signal 0 同样可用于探测） */
function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function countShots(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.png')).length;
  } catch {
    return 0;
  }
}

/**
 * 哪些错误属于「会话问题」（值得重连一次）。
 *
 * 判据是错误文案里的连接类信号，而不是错误类型 —— CDP 的错误都走
 * 普通 Error。宁可多列几个（多一次重连的代价很小），也不要漏掉
 * 「连接已关闭」这类最常见的抖动。
 */
function isSessionError(message: string): boolean {
  return /CDP 连接|连接已关闭|连接未建立|没有可用的页面目标|target closed|Session with given id not found/i.test(
    message,
  );
}
