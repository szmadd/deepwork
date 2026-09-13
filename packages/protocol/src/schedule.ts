/**
 * 自动化调度契约（需求文档 §4.6）。
 *
 * ── 任务与调度解耦 ──────────────────────────────────────────────────
 * `prompt` 是自然语言描述的任务本身，`spec` 是独立配置的时间参数。
 * 改时间不动任务，改任务不动时间。
 *
 * ── 形态边界（如实标注，不是缺陷）────────────────────────────────────
 * 调度只在应用运行期间生效：桌面应用没有常驻守护进程，应用没开就是没跑，
 * 错过的时间不补跑（`lastRunAt` 如实反映上一次真实触发）。
 * 引擎 tick 到的时刻若 nextRunAt 已过，只触发一次，不追补中间的每一次。
 *
 * ── 自动任务不享有特权 ────────────────────────────────────────────────
 * 调度触发产生的 run 走与手动发送完全相同的链路（技能/记忆注入、审批网关），
 * 不绕过审批。触发在事件流里留痕：`schedule.fired` 先于 run.started 落盘，
 * 且带 runId —— 与 skill.attached 同一条归属纪律（不带 runId 会退化成
 * 全局事件，污染其他会话的视图）。
 */

/** 调度时间参数。weekdays 用 0=周日 … 6=周六（与 Date.getDay() 一致） */
export type ScheduleSpec =
  | { kind: 'once'; /** 触发时刻（ISO 8601） */ at: string }
  | { kind: 'daily'; /** 本地时间 'HH:MM' */ time: string }
  | { kind: 'weekly'; weekdays: number[]; time: string }
  | { kind: 'monthly'; /** 每月第几天；超出当月天数时落到当月最后一天 */ day: number; time: string }
  | { kind: 'interval'; /** 每隔多少分钟（对齐到整点刻度） */ everyMinutes: number };

export interface ScheduleTask {
  id: string;
  title: string;
  /** 任务本体：触发时作为一轮真实 run 的用户输入发给内核 */
  prompt: string;
  /** 任务绑定的工作区（新建触发会话时使用） */
  workspace: string;
  spec: ScheduleSpec;
  /** 停用即不触发，但任务与历史保留（与删除区分） */
  enabled: boolean;
  createdAt: string;
  /** 上一次真实触发时刻（ISO）；从未触发过则缺省 —— 错过不补跑，它如实反映 */
  lastRunAt?: string;
  /** 上一次触发的 run 结局；run 结束才写回 */
  lastStatus?: 'completed' | 'failed' | 'aborted';
  /** 触发绑定的会话：存在且会话仍在时复用，否则以「⏰ 标题」新建 */
  lastSessionId?: string;
  /** 累计触发次数（含手动「立即运行」） */
  runCount: number;
  /** 下一次计划触发时刻（ISO）；disabled 或 once 已过期时为 undefined */
  nextRunAt?: string;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * 校验调度参数，返回人读错误信息；合法返回 null。
 * UI 与宿主共用同一份校验，不出现「界面允许但内核拒绝」的两套说法。
 */
export function validateScheduleSpec(spec: ScheduleSpec): string | null {
  switch (spec.kind) {
    case 'once': {
      const at = new Date(spec.at);
      if (Number.isNaN(at.getTime())) return '一次性任务需要合法的触发时刻（ISO 8601）';
      return null;
    }
    case 'daily':
      return TIME_PATTERN.test(spec.time) ? null : '时间格式应为 HH:MM（24 小时制）';
    case 'weekly': {
      if (!Array.isArray(spec.weekdays) || spec.weekdays.length === 0) return '每周任务至少选择一天';
      if (spec.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return '星期取值应在 0（周日）到 6（周六）之间';
      return TIME_PATTERN.test(spec.time) ? null : '时间格式应为 HH:MM（24 小时制）';
    }
    case 'monthly': {
      if (!Number.isInteger(spec.day) || spec.day < 1 || spec.day > 31) return '每月日期应在 1 到 31 之间';
      return TIME_PATTERN.test(spec.time) ? null : '时间格式应为 HH:MM（24 小时制）';
    }
    case 'interval':
      return Number.isInteger(spec.everyMinutes) && spec.everyMinutes >= 1
        ? null
        : '间隔分钟数应为不小于 1 的整数';
    default:
      return '未知的调度类型';
  }
}

const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 调度的人类可读描述（「每周一三五 09:00」）。
 *
 * 共享纯函数：UI 列表与测试断言共用同一份文案来源，
 * 两处不会出现各自拼一句话而漂移的情况。
 */
export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'once': {
      const at = new Date(spec.at);
      if (Number.isNaN(at.getTime())) return `一次性 · ${spec.at}`;
      const pad = (n: number) => String(n).padStart(2, '0');
      return `一次性 · ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }
    case 'daily':
      return `每天 ${spec.time}`;
    case 'weekly': {
      const days = [...spec.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_LABEL[d]).join('');
      return `每周${days} ${spec.time}`;
    }
    case 'monthly':
      return `每月 ${spec.day} 日 ${spec.time}${spec.day > 28 ? '（当月无此日期时落在最后一天）' : ''}`;
    case 'interval':
      return spec.everyMinutes % 60 === 0
        ? `每 ${spec.everyMinutes / 60} 小时`
        : `每 ${spec.everyMinutes} 分钟`;
    default:
      return '未知调度';
  }
}
