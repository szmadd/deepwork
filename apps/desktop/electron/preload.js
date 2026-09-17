'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染层唯一的对外通道。
 *
 * 安全约定（与架构文档 §5 一致）：
 *  - contextIsolation 开启、nodeIntegration 关闭，渲染层拿不到 require / process；
 *  - 这里只暴露语义化方法，不暴露 ipcRenderer 本身，渲染层无法伪造任意通道；
 *  - 方法名白名单在主进程侧二次校验（main.js），preload 不是可信边界。
 *
 * 通道名与 packages/protocol/src/rpc.ts 的 IPC 常量必须保持一致。
 */

const CH_INVOKE = 'deepwork:invoke';
const CH_EVENT = 'deepwork:event';
const CH_TERMINAL = 'deepwork:terminal';
const CH_HOST_STATE = 'deepwork:host-state';
const CH_PICK_WORKSPACE = 'deepwork:pick-workspace';
const CH_PICK_ATTACHMENTS = 'deepwork:pick-attachments';
const CH_PREVIEW_ATTACHMENT = 'deepwork:preview-attachment';
const CH_BROWSER_SHOTS = 'deepwork:browser-shots';
const CH_BROWSER_SHOT_READ = 'deepwork:browser-shot-read';
const CH_NOTIFY = 'deepwork:notify';

contextBridge.exposeInMainWorld('deepwork', {
  /** 调用内核宿主方法，method 必须在主进程白名单内 */
  invoke: (method, params = {}) => ipcRenderer.invoke(CH_INVOKE, { method, params }),

  /** 弹出系统目录选择框；返回绝对路径，取消返回 null */
  pickWorkspace: () => ipcRenderer.invoke(CH_PICK_WORKSPACE),

  /**
   * 多选文件作为附件；返回绝对路径数组。
   * 选中的路径会在主进程记入白名单，之后才允许被 previewAttachment 读取。
   */
  pickAttachments: () => ipcRenderer.invoke(CH_PICK_ATTACHMENTS),

  /** 读取已选附件的内容（只读、有体积上限、非白名单路径会被拒绝） */
  previewAttachment: (target) => ipcRenderer.invoke(CH_PREVIEW_ATTACHMENT, target),

  /** 列出浏览器截图（时间倒序）；截图目录不存在时返回空数组 */
  browserShots: () => ipcRenderer.invoke(CH_BROWSER_SHOTS),

  /** 读取一张浏览器截图，返回 dataUrl（只允许截图目录下的 PNG） */
  browserShotRead: (target) => ipcRenderer.invoke(CH_BROWSER_SHOT_READ, target),

  /**
   * 发系统通知；返回 { shown, reason? }。
   * shown 只表示请求已交给系统 —— 是否真的弹出来由系统决定，见 main.js 的注释。
   */
  notify: (request) => ipcRenderer.invoke(CH_NOTIFY, request),

  /** 订阅归一化事件流，返回取消订阅函数 */
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(CH_EVENT, listener);
    return () => ipcRenderer.removeListener(CH_EVENT, listener);
  },

  /** 订阅终端数据（高频、易失，与事件流分开） */
  onTerminal: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(CH_TERMINAL, listener);
    return () => ipcRenderer.removeListener(CH_TERMINAL, listener);
  },

  /** 订阅宿主进程状态（starting / ready / restarting / stopped） */
  onHostState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(CH_HOST_STATE, listener);
    return () => ipcRenderer.removeListener(CH_HOST_STATE, listener);
  },

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
