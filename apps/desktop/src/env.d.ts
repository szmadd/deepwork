import type {
  AgentEvent,
  AttachmentPreview,
  BrowserShotImage,
  BrowserShotInfo,
  HostState,
  RpcMethod,
  RpcParams,
  RpcResult,
  TerminalChunk,
} from '@deepwork/protocol';

/**
 * 渲染层对 Electron 桥接层的类型声明。
 * 实现见 apps/desktop/electron/preload.js —— 通道名必须与 protocol 的 IPC 常量一致。
 */

export interface DeepworkBridge {
  invoke<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>>;
  /** 弹出系统目录选择框；用户取消时返回 null */
  pickWorkspace(): Promise<string | null>;
  /** 多选文件作为附件；用户取消时返回空数组 */
  pickAttachments(): Promise<string[]>;
  /** 读取已选附件内容；路径必须来自 pickAttachments */
  previewAttachment(target: string): Promise<AttachmentPreview>;
  /** 列出浏览器截图（时间倒序）；截图目录不存在时返回空数组 */
  browserShots(): Promise<BrowserShotInfo[]>;
  /** 读取一张浏览器截图，返回 dataUrl；仅限截图目录下的 PNG */
  browserShotRead(target: string): Promise<BrowserShotImage>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  onTerminal(handler: (chunk: TerminalChunk) => void): () => void;
  onHostState(handler: (payload: { state: HostState; detail?: string }) => void): () => void;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
}

declare global {
  interface Window {
    deepwork?: DeepworkBridge;
  }
}

export {};
