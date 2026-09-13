import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../logger';

const log = createLogger('browser:cdp');

/**
 * 最小 CDP（Chrome DevTools Protocol）客户端。
 *
 * ── 为什么手写而不是引库 ────────────────────────────────────────────
 * CDP 就是「HTTP 拿目标清单 + WebSocket 上跑 JSON 请求/响应/事件」。
 * Node 22 内置 fetch 与全局 WebSocket（已稳定），协议本身没有别的依赖面 ——
 * 引 ws / chrome-remote-interface 买来的只是我们不用的那九成。
 *
 * ── 两个已知的坑（实现即按它们写，勿改回「更简洁」的写法）─────────────
 *
 * 1. **调试端口只能从 stderr 那行解析。** `--remote-debugging-port=0` 让系统分配
 *    端口，浏览器把实际端口写在 stderr 的一行里：
 *      DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<hash>
 *    这是 CDP 的标准握手。/json/version 在拿到端口之前根本不可达，
 *    「猜端口」没有可猜的对象。
 *
 * 2. **必须带 --user-data-dir。** 新版 Chrome/Edge 只允许非默认 user-data-dir
 *    的实例开远程调试端口（安全限制，不带该参数时调试端口静默不生效）。
 *    我们用宿主家目录下的专用 profile —— 同时保证了不碰用户日常浏览器的数据。
 */

export interface BrowserTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

export interface LaunchedBrowser {
  child: ChildProcess;
  /** stderr 握手行里解析出的浏览器级 WS 地址 */
  browserWsUrl: string;
  port: number;
  /** 浏览器可执行文件路径（用于状态展示与诊断） */
  executable: string;
}

/** 浏览器可执行文件的候选路径。Windows 必有 Edge，Chrome 作为次选。 */
const BROWSER_CANDIDATES: string[] =
  process.platform === 'win32'
    ? [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      ];

/**
 * 找到系统里可用的浏览器；找不到返回 null。
 * 调用方负责把 null 变成一条明确报错 —— 不假装「浏览器已打开」。
 */
export function findBrowserExecutable(): string | null {
  // 显式覆盖优先（测试与非常规安装位置）
  const custom = process.env.DEEPWORK_BROWSER_PATH;
  if (custom && fs.existsSync(custom)) return custom;
  for (const candidate of BROWSER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)/;

/** 拉起浏览器并等它报出调试端口；超时或提前退出都如实报错。 */
export function launchBrowser(options: {
  executable: string;
  userDataDir: string;
  headless?: boolean;
  timeoutMs?: number;
}): Promise<LaunchedBrowser> {
  const { executable, userDataDir, timeoutMs = 20_000 } = options;
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // headless=new：界面无感（不弹窗），与「宿主托管的后台能力」的定位一致
    ...(options.headless === false ? [] : ['--headless=new']),
    'about:blank',
  ];

  log.info(`拉起浏览器: ${executable}`);
  const child = spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  return new Promise<LaunchedBrowser>((resolve, reject) => {
    let stderrBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error(`浏览器在 ${timeoutMs}ms 内没有报出调试端口（DevTools listening 行未出现）`));
    }, timeoutMs);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // 已经退出了就没什么好杀的
      }
      reject(error);
    };

    child.on('error', (error) => fail(new Error(`无法启动浏览器：${error.message}`)));
    child.on('exit', (code) => {
      if (!settled) fail(new Error(`浏览器提前退出（code=${code}）。stderr 尾部：${stderrBuf.slice(-400)}`));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      const match = DEVTOOLS_LINE.exec(stderrBuf);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      const browserWsUrl = match[1];
      const port = Number(new URL(browserWsUrl).port);
      resolve({ child, browserWsUrl, port, executable });
    });
  });
}

/** HTTP GET /json/list：拿当前所有调试目标（page / worker / …） */
export async function listTargets(port: number): Promise<BrowserTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`CDP /json/list 返回 ${response.status}`);
  return (await response.json()) as BrowserTarget[];
}

/**
 * 探测某个端口上是否还有活着的浏览器。
 *
 * 只用它回答一个问题：「endpoint 文件里那个浏览器还在吗」。
 * 因此任何异常都归为 false（超时、连接被拒、端口被别的程序占了但不说 CDP）——
 * 把「探测不了」当成「没有」是安全的，代价只是重新拉一个；
 * 反过来把「探测不了」当成「有」会让后续每条命令都失败在一次含糊的超时上。
 */
export async function probeBrowser(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 一个 WS 连接上的 CDP 会话：请求按 id 配对，事件按方法名分发。
 * 连接关闭时拒绝所有在途请求 —— 悬挂的 Promise 比报错更难查。
 */
export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;

  constructor(private readonly wsUrl: string) {}

  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket 连接超时（${timeoutMs}ms）`)), timeoutMs);
      const ws = new WebSocket(this.wsUrl);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 连接失败：${this.wsUrl}`));
      });
      ws.addEventListener('message', (event) => {
        this.dispatch(typeof event.data === 'string' ? event.data : String(event.data));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`CDP 连接已关闭，${pending.method} 未得到应答`));
        }
        this.pending.clear();
      });
    });
  }

  /**
   * 发送一条 CDP 命令；超时如实报错，不静默悬挂。
   *
   * `sessionId` 用于页面级命令：我们是接在**浏览器级** WS 上的，
   * 页面域（Page / Runtime / DOM）的命令必须先 `Target.attachToTarget`
   * 拿到会话 id，再逐条带上（flatten 模式）。不带 sessionId 时这些命令
   * 会被浏览器以「'Runtime.evaluate' wasn't found」拒绝 —— 报错指向的
   * 方法名本身没错，所以异常信息里必须带上「是否已附着页面」这个上下文。
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.closed || !this.ws) return Promise.reject(new Error('CDP 连接未建立或已关闭'));
    const id = this.nextId++;
    const ws = this.ws;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /**
   * 附着一个页面目标，返回页面会话 id。
   *
   * 优先挑已经导航过的 page（url 不是 about:blank）—— 浏览器启动时带的
   * about:blank 只是占位；如果同时存在多个 page（例如用户自己开了一个新标签），
   * 挑错页面会让「读取当前页」读到一张白纸，而所有命令都成功返回。
   */
  async attachToPage(): Promise<{ sessionId: string; targetId: string }> {
    const { targetInfos } = (await this.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    const pages = targetInfos.filter((item) => item.type === 'page');
    if (pages.length === 0) throw new Error('浏览器里没有可用的页面目标（page target 为空）');
    const target = pages.find((item) => item.url && item.url !== 'about:blank') ?? pages[0];
    const { sessionId } = (await this.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    return { sessionId, targetId: target.targetId };
  }

  /** 订阅 CDP 事件（如 Page.loadEventFired） */
  on(method: string, handler: (params: unknown) => void): void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(handler);
    this.listeners.set(method, set);
  }

  /** 等一条事件；超时拒绝。一次性订阅，收到即移除。 */
  waitEvent(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        set.delete(handler);
        reject(new Error(`等待 CDP 事件 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const handler = (params: unknown) => {
        clearTimeout(timer);
        set.delete(handler);
        resolve(params);
      };
      const set = this.listeners.get(method) ?? new Set();
      set.add(handler);
      this.listeners.set(method, set);
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // 已经断开就没什么可关的
    }
    this.ws = null;
  }

  private dispatch(raw: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method} 被浏览器拒绝：${message.error.message ?? '未知错误'}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      for (const handler of this.listeners.get(message.method) ?? []) {
        try {
          handler(message.params);
        } catch (error) {
          log.warn(`CDP 事件 ${message.method} 的监听器抛异常`, String(error));
        }
      }
    }
  }
}

/** 终止浏览器整棵进程树（与终端管理器同一条纪律：Windows 上 child.kill 只杀直接子进程） */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  killPidTree(child.pid);
}

/**
 * 按 pid 终止整棵进程树。
 *
 * 与 killProcessTree 分开，是因为「宿主停止」要按 endpoint 文件里的 pid 收尾 ——
 * 那个浏览器可能是另一个进程拉起的，我们手里没有它的 ChildProcess 句柄。
 */
export function killPidTree(pid: number): void {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      try {
        process.kill(pid);
      } catch {
        // 已经退出了
      }
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 已经退出了
  }
}
