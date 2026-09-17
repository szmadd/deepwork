import type {
  AttachmentPreview,
  BrowserShotImage,
  BrowserShotInfo,
  NotificationRequest,
  NotificationResult,
  RpcMethod,
  RpcParams,
  RpcResult,
} from '@deepwork/protocol';

/** 是否运行在 Electron 壳内。在普通浏览器里打开会退化为只读提示页。 */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.deepwork?.invoke === 'function';
}

export function bridge() {
  const value = window.deepwork;
  if (!value) {
    throw new Error('未检测到 Electron 桥接层：请在桌面应用内运行（npm run dev / npm start）');
  }
  return value;
}

export function invoke<M extends RpcMethod>(
  method: M,
  params?: RpcParams<M>,
): Promise<RpcResult<M>> {
  return bridge().invoke(method, params);
}

/** 弹出系统目录选择框；用户取消返回 null */
export function pickWorkspace(): Promise<string | null> {
  return bridge().pickWorkspace();
}

/** 多选附件；用户取消返回空数组 */
export function pickAttachments(): Promise<string[]> {
  return bridge().pickAttachments();
}

/** 读取已选附件内容（主进程侧有白名单把关） */
export function previewAttachment(target: string): Promise<AttachmentPreview> {
  return bridge().previewAttachment(target);
}

/** 列出浏览器截图（时间倒序，主进程只扫截图目录） */
export function browserShots(): Promise<BrowserShotInfo[]> {
  return bridge().browserShots();
}

/** 读取一张浏览器截图（主进程只放行截图目录下的 PNG） */
export function browserShotRead(target: string): Promise<BrowserShotImage> {
  return bridge().browserShotRead(target);
}

/**
 * 发系统通知。
 *
 * 注意 shown 的口径：它表示「主进程已把请求交给系统」，不表示用户看到了。
 * 调用方（useAgent）据此决定要不要在界面上补一条提示 —— 通知发不出去时
 * 静默失败是最糟的结果：用户以为「切走了也会被提醒」，而实际上不会。
 */
export function notify(request: NotificationRequest): Promise<NotificationResult> {
  const value = window.deepwork;
  if (!value?.notify) return Promise.resolve({ shown: false, reason: '当前环境没有通知通道' });
  return value.notify(request);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Electron 会把主进程抛出的异常包一层 "Error invoking remote method ..."
    return error.message.replace(/^Error invoking remote method '[^']+':\s*/, '');
  }
  return String(error);
}

/** 把字节数写成人类可读的短文本，用于附件与文件树 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
