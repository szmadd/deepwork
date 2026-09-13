import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_CONTENT_LIMIT, type BrowserAction } from '@deepwork/protocol';
import { CdpClient } from './cdp';
import { createLogger } from '../logger';

const log = createLogger('browser:actions');

/**
 * 六个浏览器动作的实现 —— 宿主侧工具与内核侧 MCP 服务**共用这一份**。
 *
 * 为什么不各写一份：两个入口面对的是同一个浏览器、同一批动作、同一套
 * 成功/失败语义。写两份的必然结局是「面板里能点开、Agent 点不开」（或反过来），
 * 而且这种偏差不会以报错的形式出现，只会以「有时候不好使」的形式出现。
 *
 * 本模块只有一个依赖面：一个已连接的 CdpClient。它不知道浏览器是谁拉起的、
 * 也不知道调用方是宿主还是 MCP 服务 —— 进程与生命周期的事都在 manager/mcp-server 里。
 */

/** 动作参数（registry 工具的入参与 MCP tools/call 的 arguments 都归一到这个形状） */
export interface ActionArgs {
  url?: unknown;
  selector?: unknown;
  text?: unknown;
  submit?: unknown;
  expression?: unknown;
  name?: unknown;
}

export interface ActionOutcome {
  ok: boolean;
  /** 给模型/用户看的正文（文本内容、求值结果、或状态说明） */
  text: string;
  truncated?: boolean;
  url?: string;
  title?: string;
  /** 截图落盘路径（PNG 字节不进事件日志、不回正文） */
  shotPath?: string;
}

const PAGE_TIMEOUT_MS = 30_000;
/** 点击/输入后给页面一点时间跑脚本（表单提交、路由跳转都是异步的） */
const SETTLE_MS = 400;

/** 截断到上限，并如实标注 —— 与内置工具的 truncate 同一语义 */
function clip(text: string, limit = BROWSER_CONTENT_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n... [内容已截断，原长 ${text.length} 字符]`, truncated: true };
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`缺少参数 ${field}`);
  return text;
}

/**
 * 把值转成可读文本。
 *
 * 求值结果可能是对象/数组（`returnByValue` 会给出结构化值），
 * 用 JSON 序列化保留结构；不可序列化的（循环引用、函数）退回 description，
 * 最后兜底 String()。三种路径都覆盖，是为了让「拿到 undefined 却不知道为什么」
 * 这种最难查的失败不出现。
 */
export function renderValue(value: unknown, description?: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) {
    // returnByValue 对不可序列化的值返回 undefined，此时 description 是唯一的线索
    return description ?? String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return description ?? String(value);
  }
}

/**
 * Runtime.evaluate 的薄封装：统一处理异常上报。
 *
 * 页面里抛出的异常**必须**变成我们的异常：CDP 的 `exceptionDetails` 是
 * 「这次 execute 成功了，但脚本炸了」——不看这个字段的话，点击没生效、
 * 元素没找到都会表现为「成功」。
 */
async function evaluateRaw(
  client: CdpClient,
  sessionId: string,
  expression: string,
  awaitPromise = true,
): Promise<string> {
  const response = (await client.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise },
    PAGE_TIMEOUT_MS,
    sessionId,
  )) as {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };

  if (response.exceptionDetails) {
    const detail =
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? '未知异常';
    // 只取首行：CDP 会把整段调用栈塞进来，而工具输出里那几十行栈没有信息增量
    throw new Error(`页面脚本抛出异常：${detail.split('\n')[0]}`);
  }
  return renderValue(response.result?.value, response.result?.description);
}

/** 当前页的 url 与 title */
async function pageInfo(
  client: CdpClient,
  sessionId: string,
): Promise<{ url: string; title: string }> {
  const url = await evaluateRaw(client, sessionId, 'location.href', false);
  const title = await evaluateRaw(client, sessionId, 'document.title', false);
  return { url, title };
}

/** 把一个字符串安全地嵌进页面表达式（唯一允许拼接的地方，必须走 JSON.stringify） */
function literal(value: string): string {
  return JSON.stringify(value);
}

/**
 * 文案里的 URL 截断。
 *
 * data: URL 可以长到几千字符（它是页面内容本身），原样塞进工具输出会把
 * 真正的信息（标题、状态）挤出模型视野。完整 URL 仍然在结构化字段里给出去，
 * 只有给人/模型看的那句话收短。
 */
function shortUrl(url: string, limit = 120): string {
  return url.length <= limit ? url : `${url.slice(0, limit)}…(${url.length} 字符)`;
}

/** 在表达式里查元素，查不到就抛 —— 让「选择器写错」与「页面没渲染完」都有一句人话 */
function selectorPrelude(selector: string): string {
  return `const el = document.querySelector(${literal(selector)}); if (!el) throw new Error('未找到元素: ' + ${literal(selector)});`;
}

/**
 * 打开一个 URL 并等页面加载。
 *
 * 等待策略是「等 Page.loadEventFired，或超时如实降级」：
 * 有些页面（前端路由、长连接页面）永远不触发 load，硬等会把一次可用的
 * 导航变成一次失败；但静默不等又会让紧随其后的 content 读到空白。
 * 所以超时后**继续**，并在返回文案里说明「未等到加载事件」。
 */
async function navigate(
  client: CdpClient,
  sessionId: string,
  args: ActionArgs,
): Promise<ActionOutcome> {
  const url = requireText(args.url, 'url');
  if (!/^(https?|file|data):/i.test(url) && !/^about:/.test(url)) {
    throw new Error(`不支持的 URL 协议（仅 http/https/file/data）：${url}`);
  }

  await client.send('Page.enable', {}, PAGE_TIMEOUT_MS, sessionId);
  const loaded = client.waitEvent('Page.loadEventFired', 15_000).then(
    () => true,
    () => false,
  );
  const result = (await client.send('Page.navigate', { url }, PAGE_TIMEOUT_MS, sessionId)) as {
    errorText?: string;
  };
  if (result.errorText) throw new Error(`导航失败：${result.errorText}`);

  const ok = await loaded;
  const info = await pageInfo(client, sessionId);
  return {
    ok: true,
    ...info,
    text: ok
      ? `已打开 ${shortUrl(info.url)}${info.title ? `（标题：${info.title}）` : ''}`
      : `已打开 ${shortUrl(info.url)}，但未在 15s 内等到加载完成事件（前端路由或长连接页面属正常）`,
  };
}

/** 读取页面（或某个元素）的可读文本 */
async function content(
  client: CdpClient,
  sessionId: string,
  args: ActionArgs,
): Promise<ActionOutcome> {
  const selector = typeof args.selector === 'string' && args.selector ? args.selector : null;
  const expression = selector
    ? `(() => { ${selectorPrelude(selector)} return el.innerText ?? el.textContent ?? ''; })()`
    : `(() => document.body ? (document.body.innerText || document.body.textContent || '') : '')()`;

  const raw = await evaluateRaw(client, sessionId, expression);
  const info = await pageInfo(client, sessionId);
  const { text, truncated } = clip(raw);
  return {
    ok: true,
    ...info,
    text: text.trim() ? text : '(页面没有可读文本)',
    truncated,
  };
}

/** 点击一个元素 */
async function click(
  client: CdpClient,
  sessionId: string,
  args: ActionArgs,
): Promise<ActionOutcome> {
  const selector = requireText(args.selector, 'selector');
  await evaluateRaw(
    client,
    sessionId,
    `(() => { ${selectorPrelude(selector)}
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'clicked';
    })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const info = await pageInfo(client, sessionId);
  return { ok: true, ...info, text: `已点击 ${selector}${args.submit === true ? ' 并提交表单' : ''}` };
}

/**
 * 往输入框里输入文本。
 *
 * 用原生 setter + 派发 input/change 事件，而不是 `Input.dispatchKeyEvent` 逐键模拟：
 * 后者需要先让元素获得焦点、逐字符派发，慢且对中文/粘贴不友好。
 * 而**必须**走原生 setter 的原因在另一头：React 等受控输入框会拦截
 * `el.value = x` 的赋值，直接赋值后框架读到的仍是旧值 —— 表现为
 * 「输入框里看着有字，提交上去是空的」。这个坑在截图脚本里已经踩过一次。
 */
async function type(
  client: CdpClient,
  sessionId: string,
  args: ActionArgs,
): Promise<ActionOutcome> {
  const selector = requireText(args.selector, 'selector');
  const value = requireText(args.text, 'text');
  const submit = args.submit === true;

  await evaluateRaw(
    client,
    sessionId,
    `(() => { ${selectorPrelude(selector)}
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${literal(value)});
      else if ('value' in el) el.value = ${literal(value)};
      else { el.textContent = ${literal(value)}; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'typed';
    })()`,
  );

  if (submit) {
    // 有归属表单就走 requestSubmit（等价于用户点提交按钮，会触发校验）；
    // 没有表单才退回派发 Enter —— 直接派发 Enter 对表单外的输入框毫无作用，
    // 那种「输入了但没提交」如果不说出来，下一次调用只会看到页面没变。
    await evaluateRaw(
      client,
      sessionId,
      `(() => { ${selectorPrelude(selector)}
        if (el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(); return 'submitted'; }
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'enter';
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }

  const info = await pageInfo(client, sessionId);
  return { ok: true, ...info, text: `已向 ${selector} 输入 ${value.length} 个字符${submit ? ' 并提交' : ''}` };
}

/** 在页面上下文里求值（danger 档：模型给的表达式会拿到页面的一切） */
async function evaluate(
  client: CdpClient,
  sessionId: string,
  args: ActionArgs,
): Promise<ActionOutcome> {
  const expression = requireText(args.expression, 'expression');
  const raw = await evaluateRaw(client, sessionId, expression);
  const { text, truncated } = clip(raw);
  return { ok: true, text, truncated };
}

/** 截图落盘。PNG 字节不进事件日志、不进工具正文，回传的只有路径。 */
async function screenshot(
  client: CdpClient,
  sessionId: string,
  args: ActionArgs,
  shotsDir: string,
): Promise<ActionOutcome> {
  const response = (await client.send(
    'Page.captureScreenshot',
    { format: 'png' },
    PAGE_TIMEOUT_MS,
    sessionId,
  )) as { data?: string };
  if (!response.data) throw new Error('浏览器没有返回截图数据');

  const buffer = Buffer.from(response.data, 'base64');
  fs.mkdirSync(shotsDir, { recursive: true });
  const file = path.join(shotsDir, shotName(args.name));
  fs.writeFileSync(file, buffer);

  const info = await pageInfo(client, sessionId);
  return {
    ok: true,
    ...info,
    shotPath: file,
    text: `已截图并保存到 ${file}（${buffer.length} 字节）`,
  };
}

/**
 * 截图文件名。
 *
 * 名字来自模型/用户，所以必须过一遍白名单字符集：`..` 与路径分隔符
 * 在别处也许只是「不合规范」，在这里是**写出目录之外**。
 * 不合规的名字不报错，改为忽略它并用时间戳兜底 —— 截图这件事本身
 * 不该因为一个名字不好看而失败。
 */
function shotName(raw: unknown): string {
  const fallback = `shot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const base = trimmed.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!base || base === '.png') return fallback;
  return base.toLowerCase().endsWith('.png') ? base : `${base}.png`;
}

/**
 * 统一动作入口：把「哪个动作」与「参数」落到具体实现。
 *
 * 两个入口（宿主 registry 工具、内核 MCP 服务）都调它，于是
 * 「有哪些动作」「参数叫什么」「报错怎么说」只有一份定义。
 */
export async function runBrowserAction(input: {
  client: CdpClient;
  sessionId: string;
  action: BrowserAction;
  args: ActionArgs;
  /** 截图落盘目录（宿主与 MCP 服务各自按自己的家目录算出来传进来） */
  shotsDir: string;
}): Promise<ActionOutcome> {
  const { client, sessionId, action, args, shotsDir } = input;
  switch (action) {
    case 'navigate':
      return navigate(client, sessionId, args);
    case 'content':
      return content(client, sessionId, args);
    case 'click':
      return click(client, sessionId, args);
    case 'type':
      return type(client, sessionId, args);
    case 'evaluate':
      return evaluate(client, sessionId, args);
    case 'screenshot':
      return screenshot(client, sessionId, args, shotsDir);
    default: {
      // 动作表是封闭的；真出现未知动作时明确报错，而不是静默返回一个空成功
      const never: never = action;
      throw new Error(`未知的浏览器动作：${String(never)}`);
    }
  }
}

/** 供调用方复用的日志出口（失败原因值得留痕：浏览器的问题是「偶发」的重灾区） */
export function logBrowserFailure(action: BrowserAction, error: unknown): void {
  log.warn(`动作 ${action} 失败`, error instanceof Error ? error.message : String(error));
}

/** 六个动作的中文描述（面板与工具说明共用） */
export const BROWSER_ACTION_LABEL: Record<BrowserAction, string> = {
  navigate: '打开网址',
  content: '读取页面文本',
  click: '点击元素',
  type: '输入文本',
  evaluate: '执行页面脚本',
  screenshot: '截图',
};
