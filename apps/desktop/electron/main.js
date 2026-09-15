'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { CoreHostClient } = require('./core-host-client');

/**
 * Electron 主进程。
 *
 * 职责（只做这五件事，业务逻辑一律下沉到 core-host）：
 *  1. 窗口与生命周期；
 *  2. 托管内核宿主子进程（启动 / 崩溃重启 / 退出清理）；
 *  3. 权限网关：渲染层能调用哪些方法，由这里的白名单决定；
 *  4. 事件与终端数据转发；
 *  5. 壳层专属能力（系统对话框、附件读取）—— 这些渲染层在 sandbox 下拿不到，
 *     但它们**不经过 core-host**，因为附件通常在工作区之外，不属于内核的边界概念。
 */

const CH_INVOKE = 'deepwork:invoke';
const CH_EVENT = 'deepwork:event';
const CH_TERMINAL = 'deepwork:terminal';
const CH_HOST_STATE = 'deepwork:host-state';
/**
 * 目录选择通道。
 * 它不走 core-host —— 选目录是纯壳层能力（渲染层在 sandbox 下拿不到 dialog），
 * 因此必须在主进程里单独开一条通道，而不是混进 RPC 方法白名单。
 * 通道名与 packages/protocol/src/rpc.ts 的 IPC 常量保持一致。
 */
const CH_PICK_WORKSPACE = 'deepwork:pick-workspace';
/** 多选附件与附件预览，同样属于壳层能力 */
const CH_PICK_ATTACHMENTS = 'deepwork:pick-attachments';
const CH_PREVIEW_ATTACHMENT = 'deepwork:preview-attachment';
/** 浏览器截图清单与读取（截图落在工作区之外，同样由壳层处理） */
const CH_BROWSER_SHOTS = 'deepwork:browser-shots';
const CH_BROWSER_SHOT_READ = 'deepwork:browser-shot-read';

/** 渲染层可调用的方法白名单。新增方法必须先加到 packages/protocol 的 RpcContract。 */
const ALLOWED_METHODS = new Set([
  'host.status',
  'config.get',
  'config.set',
  'guard.get',
  'guard.set',
  'models.list',
  'models.refresh',
  'models.testEndpoint',
  'model.apiKey.status',
  'model.apiKey.set',
  'model.apiKey.clear',
  'session.list',
  'session.create',
  'session.rename',
  'session.delete',
  'session.events',
  'session.fork',
  'run.send',
  'run.abort',
  'fs.tree',
  'fs.preview',
  'terminal.open',
  'terminal.run',
  'terminal.write',
  'terminal.interrupt',
  'terminal.close',
  'approval.respond',
  'skills.list',
  'skills.install',
  'skills.uninstall',
  'skills.audit',
  'skills.toggle',
  'memory.list',
  'memory.add',
  'memory.remove',
  'memory.stats',
  'memory.setProfile',
  'schedule.list',
  'schedule.add',
  'schedule.remove',
  'schedule.toggle',
  'schedule.runNow',
  'connectors.list',
  'connectors.add',
  'connectors.remove',
  'connectors.toggle',
  'kernel.restart',
  'usage.summary',
  // 浏览器面板用的三个方法。模型侧的六个动作不在这里 —— 它们走内核的
  // MCP 服务并强制过审批，把可写动作放进这条白名单等于给出一条绕过审批的旁路。
  'browser.state',
  'browser.open',
  'browser.close',
]);

/** 附件预览读取上限；超过就只回报体积，不把内容塞进渲染层 */
const ATTACHMENT_MAX_BYTES = 200_000;

/**
 * 附件白名单。
 *
 * 附件在工作区之外，无法用工作区边界约束；如果给渲染层一个「读任意路径」的通道，
 * 那就等于把主进程的读权限整个送出去了。
 * 折中方案：只有**用户本人在本次运行中亲手在系统对话框里选中过**的路径才可读。
 * 这是一个很小的机制，但它把「渲染层能读什么」从「任意」收紧到「用户点过的那几个」。
 */
const attachmentAllowlist = new Set();

const isDev = process.env.DEEPWORK_DEV === '1';
const DEV_SERVER_URL = 'http://127.0.0.1:5173';
/** 调试用：设置后启动隐藏窗口、截屏落盘、自动退出（用于 CI 或人工快速验收 UI） */
const CAPTURE_PATH = process.env.DEEPWORK_CAPTURE;
const CAPTURE_DELAY_MS = Number(process.env.DEEPWORK_CAPTURE_DELAY ?? 7000);
/**
 * 截图前在渲染层执行的脚本（一段 IIFE 字符串）。
 *
 * 为什么需要它：面板类界面（文件树、终端、设置）默认是收起的，
 * 不点开就截不到。没有这个开关时，验收截图要么截不到新功能，
 * 要么得临时改代码 —— 后者会让「截图证明的东西」与「提交的代码」之间出现一道缝。
 */
const CAPTURE_SCRIPT = process.env.DEEPWORK_CAPTURE_SCRIPT;

/**
 * 日志落盘。
 *
 * 打包后的应用是 GUI 子系统程序，stdout/stderr 无处可去 —— 一旦出问题，
 * 用户能描述的只有「打不开」，排查的人手里没有任何线索。
 * 设 DEEPWORK_LOG_FILE 后日志同时写进文件，用于本地自助排查与远程报障。
 *
 * 只接管 console：内核子进程的日志本来就经由 stderr 转到这里（见 startHost），
 * 统一走一条路，避免两套日志机制。
 */
const LOG_FILE = process.env.DEEPWORK_LOG_FILE;
if (LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const render = (arg) =>
      typeof arg === 'string' ? arg : arg instanceof Error ? arg.stack || arg.message : JSON.stringify(arg);
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        try {
          fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${args.map(render).join(' ')}\n`);
        } catch {
          // 落盘失败不能反过来让应用崩掉
        }
        original(...args);
      };
    }
    console.log(
      `[boot] 主进程启动 pid=${process.pid} capture=${CAPTURE_PATH || 'off'} dev=${isDev} exe=${process.execPath}`,
    );
  } catch {
    // 同上
  }
}

let win = null;
let client = null;
let hostState = 'stopped';
let hostDetail = '';
let restartTimer = null;
let quitting = false;

function defaultWorkspace() {
  const candidate = path.join(os.homedir(), 'deepwork-workspace');
  try {
    fs.mkdirSync(candidate, { recursive: true });
    return candidate;
  } catch {
    return os.homedir();
  }
}

function setHostState(state, detail = '') {
  hostState = state;
  hostDetail = detail;
  win?.webContents.send(CH_HOST_STATE, { state, detail });
}

function startHost() {
  if (client) return;

  const workspace = process.env.DEEPWORK_WORKSPACE || defaultWorkspace();
  client = new CoreHostClient();

  client.on('event', (event) => {
    win?.webContents.send(CH_EVENT, event);
    if (event.type === 'host.ready') setHostState('ready', `${event.adapter} · ${event.adapterVersion}`);
  });

  // 终端数据单独转发：它高频且易失，与事件流混在同一条通道上会互相拖累
  client.on('terminal', (chunk) => {
    win?.webContents.send(CH_TERMINAL, chunk);
  });

  client.on('crashed', ({ code, signal }) => {
    if (quitting) return;
    const restarts = (client?.restarts ?? 0) + 1;
    setHostState('restarting', `内核宿主异常退出 (code=${code}, signal=${signal})，第 ${restarts} 次重启`);
    client = null;
    // 指数退避，上限 15s，避免内核持续崩溃时把 CPU 打满
    const delay = Math.min(1000 * 2 ** Math.min(restarts - 1, 4), 15000);
    restartTimer = setTimeout(() => {
      if (quitting) return;
      startHost();
      if (client) client.restarts = restarts;
    }, delay);
  });

  setHostState('starting', '正在启动内核宿主');
  client.start({ workspace });
}

async function stopHost() {
  clearTimeout(restartTimer);
  if (client) {
    const current = client;
    client = null;
    await current.stop().catch(() => undefined);
  }
  setHostState('stopped', '');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#111318',
    title: '深边AI Work',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 截屏模式下不弹窗，跑完即退
  win.once('ready-to-show', () => {
    if (!CAPTURE_PATH) win.show();
  });

  // 外链一律交给系统浏览器，禁止在应用内导航到外部站点
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isDev && !url.startsWith('file://')) event.preventDefault();
    if (isDev && !url.startsWith(DEV_SERVER_URL) && !url.startsWith('file://')) event.preventDefault();
  });

  win.on('closed', () => {
    win = null;
  });

  if (isDev) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.webContents.on('did-finish-load', () => {
    // 窗口加载完成时补一次状态：host.ready 可能在窗口存在之前就已经发出，
    // 只靠事件推送会让 UI 永远停在「启动中」。
    void syncHostState();
    if (CAPTURE_PATH) scheduleCapture();
  });
}

/** 主动向内核查一次状态并对齐 UI，避免依赖「事件恰好被窗口收到」 */
async function syncHostState() {
  if (!client) {
    setHostState('stopped', '内核宿主未启动');
    return;
  }
  try {
    const status = await client.invoke('host.status', {}, 10_000);
    setHostState('ready', `${status.adapter} · ${status.version}`);
  } catch (error) {
    setHostState('starting', error instanceof Error ? error.message : String(error));
  }
}

/** 截屏调试：把窗口内容写入 DEEPWORK_CAPTURE 指定路径后退出 */
function scheduleCapture() {
  setTimeout(async () => {
    try {
      await runCapturePrompt();
      await new Promise((resolve) => setTimeout(resolve, 3500));
      await runCaptureScript();
      await focusCaptureTarget();
      const image = await win?.webContents.capturePage();
      if (image) {
        fs.mkdirSync(path.dirname(CAPTURE_PATH), { recursive: true });
        fs.writeFileSync(CAPTURE_PATH, image.toPNG());
        console.log(`[capture] 已写入 ${CAPTURE_PATH}`);
      }
    } catch (error) {
      console.error('[capture] 失败', error);
    } finally {
      process.exitCode = 0;
      quitting = true;
      await stopHost();
      app.exit(0);
    }
  }, CAPTURE_DELAY_MS);
}

/**
 * 截图前把画面滚到关注的位置。
 *
 * 会话一长，视口就停在末尾，能证明问题的那个元素往往在视野外 ——
 * 于是验收截图变成「看起来在跑」，什么也证明不了。
 * DEEPWORK_CAPTURE_FOCUS 传一个 CSS 选择器，取最后一个匹配项滚到视野中央。
 */
async function focusCaptureTarget() {
  const selector = process.env.DEEPWORK_CAPTURE_FOCUS;
  if (!selector || !win) return;
  try {
    const found = await win.webContents.executeJavaScript(
      `(() => {
        const nodes = document.querySelectorAll(${JSON.stringify(selector)});
        if (nodes.length === 0) return false;
        nodes[nodes.length - 1].scrollIntoView({ block: 'center' });
        return true;
      })()`,
    );
    if (!found) console.warn(`[capture] 未找到待聚焦元素: ${selector}`);
  } catch (error) {
    console.warn('[capture] 聚焦失败', error);
  }
}

/**
 * 截图前在渲染层跑一段脚本，把界面切到要验收的状态。
 *
 * 脚本内容由环境变量给出，跑完即弃，不落盘 —— 它是「验收工具」，
 * 不是产品能力，不应该长在应用里。返回值与异常都打日志，方便定位选择器写错。
 */
async function runCaptureScript() {
  if (!CAPTURE_SCRIPT || !win) return;
  try {
    const result = await win.webContents.executeJavaScript(`(async () => { ${CAPTURE_SCRIPT} })()`);
    console.log(`[capture] 脚本执行结果: ${JSON.stringify(result)}`);
  } catch (error) {
    console.warn('[capture] 脚本执行失败', error);
  }
  // 交给 React 完成一次渲染
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

/** 截图前先跑一轮真实任务，让画面里有对话、工具卡片与审批弹窗 */
async function runCapturePrompt() {
  const prompt = process.env.DEEPWORK_CAPTURE_PROMPT;
  if (!prompt || !client) return;

  /**
   * 把「可逐块取舍」的那次审批留着不应答，好让弹窗留在画面上。
   * 其余审批立即放行 —— 否则第一个弹窗就会挡住后面所有步骤，
   * 等到截图时画面上是空会话，什么也证明不了。
   */
  const holdPartial = process.env.DEEPWORK_CAPTURE_HOLD_PARTIAL === '1';

  client.on('event', (event) => {
    if (event.type === 'approval.requested') {
      if (holdPartial && event.request.selectable) return;
      // 延迟放行，方便截图时把审批弹窗留在画面上
      const delay = Number(process.env.DEEPWORK_CAPTURE_APPROVE_DELAY ?? 0);
      setTimeout(() => {
        client
          .invoke('approval.respond', { requestId: event.request.id, decision: 'allow' })
          .catch(() => undefined);
      }, delay);
    }
  });

  /**
   * 等渲染层把会话建出来，再把任务发进去。
   *
   * 会话是由渲染层在装载时创建的（列表为空就自动建一个），这里拿不到就说明它还没好。
   * 早先直接取一次 `session.list[0]`，赶上渲染层还没完成装载就会静默什么都不做 ——
   * 截图照样产出，只是拍了一个空会话，看起来像「功能没实现」。
   */
  const session = await waitForSession();
  if (!session) {
    console.warn('[capture] 等待超时：渲染层尚未创建会话，本轮不发送任务');
    return;
  }
  await client.invoke('run.send', { sessionId: session.id, text: prompt });
}

/** 轮询等待渲染层建出的第一个会话，最多约 8 秒 */
async function waitForSession() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const sessions = await client.invoke('session.list');
    if (sessions[0]) return sessions[0];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

/**
 * 读取附件内容。
 *
 * 只允许读白名单内的路径（即用户自己选过的），并区分「不存在」「是目录」「二进制」「过大」四种结果 ——
 * 全部笼统地返回空文本，界面就会把一份读不到的文件显示成空文件。
 */
function readAttachment(target) {
  const name = path.basename(target);
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      return { path: target, name, size: 0, text: '', binary: false, truncated: false, error: '这是一个目录' };
    }
    if (stat.size > ATTACHMENT_MAX_BYTES) {
      return { path: target, name, size: stat.size, text: '', binary: false, truncated: true };
    }
    const buffer = fs.readFileSync(target);
    if (buffer.includes(0)) {
      return { path: target, name, size: stat.size, text: '', binary: true, truncated: false };
    }
    return {
      path: target,
      name,
      size: stat.size,
      text: buffer.toString('utf8'),
      binary: false,
      truncated: false,
    };
  } catch (error) {
    return {
      path: target,
      name,
      size: 0,
      text: '',
      binary: false,
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 单张截图读取上限：超过就不读，避免把一份几十 MB 的长页截图塞进渲染层 */
const BROWSER_SHOT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 浏览器截图目录。
 *
 * 规则必须与 core-host/src/paths.ts 的 homeDir() 逐字一致（DEEPWORK_HOME 优先，
 * 否则 ~/.deepwork）。不一致时不会报任何错 —— 面板只是永远空着，
 * 而「空列表」与「确实还没截过图」在界面上长得一模一样。
 */
function browserShotsDir() {
  const custom = process.env.DEEPWORK_HOME;
  const home = custom && custom.trim() ? path.resolve(custom.trim()) : path.join(os.homedir(), '.deepwork');
  return path.join(home, 'browser-shots');
}

/** 截图清单，按时间倒序（最新的在最上面）；目录不存在时返回空数组 */
function listBrowserShots() {
  const dir = browserShotsDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const shots = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.png')) continue;
    const abs = path.join(dir, name);
    try {
      const stat = fs.statSync(abs);
      shots.push({ path: abs, name, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      // 读不到 stat（刚被删/被占用）就跳过这一张，不让整个清单失败
    }
  }
  return shots.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 读取一张截图，返回 dataUrl 供 <img> 直接显示。
 *
 * 校验用「父目录必须恰好等于截图目录」而不是「路径以截图目录开头」：
 * 后者对 `<截图目录>/../../secret.png` 这类路径是放行的（字符串前缀确实匹配），
 * 而 path.resolve 会把 `..` 归一化 —— 归一化之后必须落在同一个目录里，才谈得上安全。
 */
function readBrowserShot(target) {
  if (typeof target !== 'string' || !target) throw new Error('缺少截图路径');
  const dir = browserShotsDir();
  const abs = path.resolve(target);
  if (path.dirname(abs) !== path.resolve(dir) || !abs.toLowerCase().endsWith('.png')) {
    throw new Error(`只允许读取 ${dir} 下的 PNG 截图，拒绝: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (stat.size > BROWSER_SHOT_MAX_BYTES) {
    throw new Error(`截图过大（${stat.size} 字节，上限 ${BROWSER_SHOT_MAX_BYTES}），拒绝读取`);
  }
  return {
    path: abs,
    size: stat.size,
    dataUrl: `data:image/png;base64,${fs.readFileSync(abs).toString('base64')}`,
  };
}

function registerIpc() {
  ipcMain.handle(CH_INVOKE, async (_event, payload) => {
    const { method, params } = payload || {};
    if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
      throw new Error(`方法未授权: ${String(method)}`);
    }
    if (!client) {
      throw new Error('内核宿主未就绪，请稍候重试');
    }
    return client.invoke(method, params || {});
  });

  ipcMain.handle(`${CH_INVOKE}:runtime`, () => ({
    runtime: client ? client.runtimeSource : '未启动',
  }));

  /**
   * 弹出系统目录选择框，返回所选绝对路径；取消返回 null。
   *
   * 只返回路径，不在这里做任何校验或记录 —— 工作区是否可用由会话创建时判断，
   * 主进程不对业务规则做二次解释，避免规则分散在两处。
   */
  ipcMain.handle(CH_PICK_WORKSPACE, async () => {
    // 截屏验收模式下不弹对话框，否则会把自动化流程卡死
    if (CAPTURE_PATH) return null;
    const result = await dialog.showOpenDialog(win, {
      title: '选择工作区目录',
      buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /** 多选附件；选中的路径同时记入白名单，后续才允许被预览 */
  ipcMain.handle(CH_PICK_ATTACHMENTS, async () => {
    if (CAPTURE_PATH) return [];
    const result = await dialog.showOpenDialog(win, {
      title: '选择要附加给 Agent 的文件',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    for (const file of result.filePaths) attachmentAllowlist.add(path.resolve(file));
    return result.filePaths;
  });

  /**
   * 预览附件内容。
   *
   * 刻意不做「路径是否在工作区内」的校验 —— 附件本来就在工作区之外。
   * 取而代之的是白名单：只有用户在对话框里亲手选过的路径才读得到。
   * 这样渲染层即使被注入脚本，也拿不到一个任意文件读取原语。
   */
  ipcMain.handle(CH_PREVIEW_ATTACHMENT, async (_event, target) => {
    if (typeof target !== 'string' || !target) throw new Error('缺少附件路径');
    const abs = path.resolve(target);
    if (!attachmentAllowlist.has(abs)) {
      throw new Error(`该路径不在已选附件中，拒绝读取: ${abs}`);
    }
    return readAttachment(abs);
  });

  /**
   * 浏览器截图：列清单与读内容。
   *
   * 与附件的白名单机制不同 —— 附件靠「用户亲手点过」，截图目录不依赖用户的
   * 任何一次点击（截图是模型或面板自己产生的），所以必须靠路径本身收窄：
   * 只有 <home>/browser-shots 下的 .png 可读。只判「以截图目录开头」是不够的，
   * 见 readBrowserShot 的注释。
   */
  ipcMain.handle(CH_BROWSER_SHOTS, async () => listBrowserShots());
  ipcMain.handle(CH_BROWSER_SHOT_READ, async (_event, target) => readBrowserShot(target));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    startHost();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    await stopHost();
    app.quit();
  });

  process.on('uncaughtException', (error) => {
    dialog.showErrorBox('未捕获异常', String(error?.stack || error));
  });
}
