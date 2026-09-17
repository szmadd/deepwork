/**
 * 桌面通知契约（M2-F 遗留）。
 *
 * ── 一条克制到只有一句话的规则 ────────────────────────────────────
 * **只在用户看不到的时候通知。**
 *
 * 这条规则替掉了一堆「什么事件值得通知」的清单：定时任务触发、长跑完成、
 * 运行失败 —— 它们全都适用同一条判据。理由很实在：窗口就在眼前时弹系统通知
 * 是纯噪音（用户已经在看结果了），而噪音的代价不是「烦一下」，
 * 是用户关掉通知总开关之后再也不会打开它 —— 那时真正需要提醒的场景
 * （切走了、最小化了、去干别的了）也一起失效。
 *
 * ── 为什么判定放契约层 ────────────────────────────────────────────
 * 它要读两个渲染环境才有的东西（窗口可见性、当前会话），所以很容易被写成
 * 「事件处理里的一个 if」。但那样它就没法测：通知发错时（比如用户明明在看，
 * 却弹了三次）只能靠人去发现。放在这里、由渲染层把两个事实喂进来，
 * 逻辑就是纯的、可断言的。
 */

import type { AgentEvent } from './events';

/** 通知内容 */
export interface NotificationRequest {
  /** 通知标题（系统会在通知中心里按标题分组） */
  title: string;
  body: string;
}

/**
 * 通知的发送结果。
 *
 * `shown` 只表示**我们成功把请求交给了系统** —— Windows / macOS 都可能因为
 * 专注模式、应用未打包、通知权限被关而在之后丢弃它，而我们没有任何 API
 * 能知道最终有没有真的弹出来。界面上必须按这个口径说话，
 * 不能把「已发送」说成「已通知」。
 */
export interface NotificationResult {
  shown: boolean;
  /** shown=false 时的原因（环境不支持 / 请求被拒） */
  reason?: string;
}

export interface NotifyContext {
  /**
   * 主窗口当前是否可见。
   * 不可见 = 最小化、被别的窗口盖住或被切走（浏览器口径：document.hidden 或失焦）。
   */
  windowVisible: boolean;
  /** 事件所属会话是否就是界面正在看的那一个 */
  isCurrentSession: boolean;
  /** 该会话的标题（通知正文里要能认出来是哪个会话） */
  sessionTitle: string;
}

/**
 * 通知长度的硬上限：系统会截断，但截断后的样子（半句话）比我们自己截更难读。
 * 上限套在**拼好的整句**上（含「任务完成：」这类前缀），不是套在变量上 ——
 * 只裁变量时前缀会把长度顶出上限，而我们对此毫无察觉。
 */
const MAX_TITLE = 60;
const MAX_BODY = 160;

function clip(text: string, limit: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/**
 * 这个事件该不该弹通知；不该则返回 null。
 *
 * 覆盖三类事件，其余一律不通知：
 *  - `schedule.fired`：定时任务触发（无人值守场景的主角）；
 *  - `run.completed`：一轮跑完；
 *  - `run.failed`：一轮失败（失败必须能追到，尤其当用户已经切走）；
 *  - `run.notice` 只在 level === 'warn' 时通知（提示类信息不值得打断）。
 */
export function notificationFor(event: AgentEvent, ctx: NotifyContext): NotificationRequest | null {
  // 窗口可见且正在看这个会话 —— 用户就在看着它发生，不打扰。
  // 注意两个条件是「且」：可见但已经切到别的会话时，这轮结束依然值得提醒。
  if (ctx.windowVisible && ctx.isCurrentSession) return null;

  switch (event.type) {
    case 'schedule.fired':
      return {
        // 裁剪套在**拼好的整句**上，而不是只裁任务名 ——
        // 只裁变量时，前缀（「定时任务已触发：」）会把长度顶出上限，
        // 而系统的截断比我们自己的难读得多（它会切在半个字上）
        title: clip(`定时任务已触发：${event.task.title}`, MAX_TITLE),
        body: clip(`会话「${ctx.sessionTitle}」已开始执行`, MAX_BODY),
      };
    case 'run.completed': {
      const seconds = (event.durationMs / 1000).toFixed(1);
      const failed = event.status === 'failed';
      const aborted = event.status === 'aborted';
      return {
        title: clip(
          `${failed ? '任务失败' : aborted ? '任务已中断' : '任务完成'}：${ctx.sessionTitle}`,
          MAX_TITLE,
        ),
        // 中断通常是人自己按的，不值得当作「完成」来报；措辞上如实分开
        body: clip(aborted ? '这一轮已中断' : `耗时 ${seconds}s`, MAX_BODY),
      };
    }
    case 'run.failed':
      return {
        title: clip(`运行失败：${ctx.sessionTitle}`, MAX_TITLE),
        body: clip(event.message, MAX_BODY),
      };
    case 'run.notice':
      // level 只有 info / warn 两档；info 是过程性播报，不值得打断用户
      if (event.level !== 'warn') return null;
      return {
        title: clip(`需要注意：${ctx.sessionTitle}`, MAX_TITLE),
        body: clip(event.message, MAX_BODY),
      };
    default:
      return null;
  }
}
