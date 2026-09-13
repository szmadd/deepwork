/**
 * 浏览器自动化契约 —— Agent 打开网页、读取内容、操作页面、截图取证。
 *
 * ── 实现路线（为什么不引 Playwright / Puppeteer）────────────────────
 * 它们会带浏览器下载与原生绑定，违反「装完就能跑」。本机 Windows 必有
 * Edge（Chrome 也常见），而 CDP（Chrome DevTools Protocol）恰好是
 * WebSocket + JSON，Node 22 有内置的全局 WebSocket 客户端 ——
 * 手写一个最小 CDP 客户端即可零依赖驱动系统浏览器。
 *
 * ── 会话模型 ────────────────────────────────────────────────────────
 * 单实例：一台机器上最多存在一个受管的浏览器（专用 profile，见下）。
 * 浏览器的生命周期由宿主管理：宿主停用时整棵进程树被终止，不留孤儿进程。
 *
 * 单实例怎么做到：宿主与内核侧的 MCP 服务是**两个进程**，二者都可能在
 * 没人开浏览器时被叫醒。靠一个 endpoint 文件（`browser-endpoint.json`，
 * 记录 pid / 端口 / ws 地址）共享同一个实例：谁要用浏览器，先读文件并探测
 * 它是否还活着；活着就复用，死了才拉起新的。文件里记的是事实而不是愿望 ——
 * 探测失败一律按「没有浏览器」处理，绝不按「大概还活着」继续。
 *
 * ── 专用 profile ────────────────────────────────────────────────────
 * 新版 Chrome/Edge 只对非默认 user-data-dir 开放远程调试端口（安全限制），
 * 所以必须使用 --user-data-dir。我们把它放到宿主家目录下的
 * browser-profile/ —— 这也意味着它不会碰用户日常浏览器的 Cookie 与登录态，
 * 两条要求是同一个事实的两面。
 *
 * ── 风险分档（browser.* 工具）──────────────────────────────────────
 * navigate / content / screenshot / click / type = confirm（访问网页有外联含义，
 * 点击与输入会改变远端页面状态）；evaluate = danger（在页面上下文里执行任意
 * 脚本，与 shell 同级）。全部走既有 requestApproval 审批链。
 * 分档表放在契约层由两侧共用（BROWSER_TOOL_RISK）：面板里的提示语与内核侧的
 * 审批分级必须是同一份判断，否则「界面说只是打开个网页」而「审批按危险操作拦」
 * 这种自相矛盾迟早会出现。
 *
 * ── 两条入口，授权语义不同，不能合并 ────────────────────────────────
 *  1. UI 面板（browser.state / open / close 三个 RPC）：用户亲手输入 URL 打开
 *     网页，是用户自己的动作，不走审批；
 *  2. Agent 侧六个动作：模型发起，一律过审批网关。
 * 所以 RPC 白名单里只有前三个，工具注册表里只有后六个。
 */

import type { RiskLevel } from './security';

export interface BrowserState {
  /** 浏览器进程是否在运行 */
  running: boolean;
  /** 当前页 URL（运行中且已成功导航过时给出） */
  url?: string;
  /** 当前页标题 */
  title?: string;
  /** 浏览器主进程 pid */
  pid?: number;
  /** 实际使用的浏览器可执行文件路径（诊断用：装了两个浏览器时看得见用的哪个） */
  executable?: string;
  /** 调试端口 */
  port?: number;
  /** 已落盘的截图张数 */
  shotCount?: number;
}

/** 单页可读文本的截断上限（字符）；超出部分如实标注 truncated */
export const BROWSER_CONTENT_LIMIT = 20_000;

/** 截图落盘目录名（位于宿主家目录下；PNG 字节不进事件日志，只记路径） */
export const BROWSER_SHOTS_DIR = 'browser-shots';

/** 专用浏览器 profile 目录名（位于宿主家目录下） */
export const BROWSER_PROFILE_DIR = 'browser-profile';

/** 单实例端点文件名（位于宿主家目录下） */
export const BROWSER_ENDPOINT_FILE = 'browser-endpoint.json';

/**
 * 内置浏览器服务在 dsh 里的 serverName。
 *
 * 模型侧看到的工具名是 `mcp__<serverName>__<tool>`，所以这个字符串是
 * **用户可见**的一部分，放在契约层而不是某个实现文件里。
 * 用下划线而非连字符：工具名要过模型 API 的 function name 字符集限制
 * （`^[a-zA-Z0-9_-]{1,64}$` 一类），越少特殊字符越安全。
 *
 * 它是**保留名**，但不需要额外的校验去保它：用户连接器名的字符集是
 * `CONNECTOR_NAME_PATTERN`（`^[a-z0-9][a-z0-9-]{0,31}$`，见 mcp.ts），
 * 不含下划线 —— 所以「用下划线」这一个决定同时买到了两件事：
 * 绕开模型 API 的字符集限制，且天然占用不到用户的名字空间。
 * 反过来若写成 `deepwork-browser`，用户就能建一个同名连接器，
 * 内核会拿到两个同名 MCP 服务、工具名撞在一起，表现为「偶尔调用到错的那一个」。
 */
export const BROWSER_MCP_SERVER_NAME = 'deepwork_browser';

/**
 * 端点文件形状。
 *
 * 它被两个进程读写（宿主、内核拉起的 MCP 服务），所以形状必须放在契约层 ——
 * 一处定义、两侧共用；否则「谁写的字段谁才知道」会在其中一个进程升级后静默错位。
 */
export interface BrowserEndpoint {
  pid: number;
  port: number;
  /** 浏览器级 WebSocket 调试地址（从 stderr 的 DevTools listening 行解析而来） */
  wsUrl: string;
  executable: string;
  startedAt: number;
}

/** Agent 侧可用的六个浏览器动作 */
export type BrowserAction = 'navigate' | 'content' | 'click' | 'type' | 'evaluate' | 'screenshot';

export const BROWSER_ACTIONS: readonly BrowserAction[] = [
  'navigate',
  'content',
  'click',
  'type',
  'evaluate',
  'screenshot',
];

/**
 * 宿主工具注册表里的工具名（与既有 `fs.list` / `shell.run` 同风格）。
 * 这只是**本地**名字，不经模型 API，所以点号可以留。
 */
export function browserToolName(action: BrowserAction): string {
  return `browser.${action}`;
}

/**
 * 内核侧（MCP）暴露的工具名：点号换成下划线。
 *
 * 换的理由是硬约束而非风格：模型 API 对 function name 有
 * `^[a-zA-Z0-9_-]{1,64}$` 一类的字符集限制，点号不在其中 —— 带点的工具名会被
 * API 直接拒绝，而症状是「内核报了一个与浏览器毫无关系的参数错误」，排查成本极高。
 * dsh 侧注册后的公开名是 `mcp__<serverName>__<rawName>`，rawName 即本函数返回值。
 *
 * 不手写第二张映射表：两套名字是机械对应，多一张表就多一处会改漏的地方。
 */
export function browserMcpToolName(action: BrowserAction): string {
  return `browser_${action}`;
}

/** 六个动作的风险档（UI 提示与内核分级共用同一份判断） */
export const BROWSER_TOOL_RISK: Record<BrowserAction, RiskLevel> = {
  navigate: 'confirm',
  content: 'confirm',
  screenshot: 'confirm',
  click: 'confirm',
  type: 'confirm',
  // 在页面上下文里执行任意脚本：与 shell 同级 —— 页面能读到的、能发出去的
  // 都由这段脚本决定，包括把页面里的凭据带出去
  evaluate: 'danger',
};

/** 浏览器截图清单条目（大字节不进事件日志，由壳层按需读取） */
export interface BrowserShotInfo {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

/** 浏览器截图内容：dataUrl 直接喂给 <img>，渲染层不接触文件路径以外的原语 */
export interface BrowserShotImage {
  path: string;
  dataUrl: string;
  size: number;
}
