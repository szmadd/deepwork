/**
 * 下一次触发时刻的计算 —— 整个调度系统的正确性核心。
 *
 * 刻意做成纯函数（`from` 显式传入，无 IO、无时钟、无随机）：
 * 调度引擎与存储层都可以注入任意「现在」来重放任意时刻的判定，
 * 月末溢出、当日已过点这类边界因此能被密集单测压住，
 * 而不是靠「等到明天早上看一眼」。
 *
 * 统一口径：
 *  - 返回 strictly > from 的下一个触发时刻；算不出来（once 已过期）返回 null；
 *  - 时刻一律按**本地时间**解释（'HH:MM' 是用户挂钟上的时间）；
 *  - monthly 的 day 超出当月天数时落到当月最后一天（31 日遇到 2 月 = 2 月最后一天）；
 *  - interval 对齐到 everyMinutes 的整点刻度（以 epoch 为基准的整数倍）。
 */

import type { ScheduleSpec } from '@deepwork/protocol';

export function nextFire(spec: ScheduleSpec, from: Date): Date | null {
  switch (spec.kind) {
    case 'once': {
      const at = new Date(spec.at);
      if (Number.isNaN(at.getTime())) return null;
      return at.getTime() > from.getTime() ? at : null;
    }
    case 'daily': {
      const hm = parseTime(spec.time);
      if (!hm) return null;
      for (let offset = 0; offset <= 1; offset += 1) {
        const candidate = atTime(addDays(from, offset), hm);
        if (candidate.getTime() > from.getTime()) return candidate;
      }
      return null;
    }
    case 'weekly': {
      const hm = parseTime(spec.time);
      const weekdays = new Set(spec.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
      if (!hm || weekdays.size === 0) return null;
      // 8 天窗口必然覆盖「下一个命中的星期几」
      for (let offset = 0; offset <= 7; offset += 1) {
        const day = addDays(from, offset);
        if (!weekdays.has(day.getDay())) continue;
        const candidate = atTime(day, hm);
        if (candidate.getTime() > from.getTime()) return candidate;
      }
      return null;
    }
    case 'monthly': {
      const hm = parseTime(spec.time);
      if (!hm || !Number.isInteger(spec.day) || spec.day < 1 || spec.day > 31) return null;
      // 14 个月窗口必然覆盖（包括所有 2 月的情形）
      for (let offset = 0; offset <= 13; offset += 1) {
        const year = from.getFullYear();
        const month = from.getMonth() + offset;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const day = Math.min(spec.day, daysInMonth);
        const candidate = atTime(new Date(year, month, day), hm);
        if (candidate.getTime() > from.getTime()) return candidate;
      }
      return null;
    }
    case 'interval': {
      const step = spec.everyMinutes * 60_000;
      if (!Number.isFinite(step) || step < 60_000) return null;
      // 对齐到 epoch 的整数倍：10 分钟档落在 :00/:10/:20…，而不是「启动时刻 + N」。
      // 严格大于 from：恰好压在刻度上时取下一档。
      return new Date(Math.floor(from.getTime() / step) * step + step);
    }
    default:
      return null;
  }
}

/** 解析 'HH:MM'；非法返回 null */
function parseTime(time: string): { hours: number; minutes: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

function atTime(day: Date, hm: { hours: number; minutes: number }): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hm.hours, hm.minutes, 0, 0);
}

/** 按日历日推进（本地时间），保留跨月/跨年的正确进位 */
function addDays(from: Date, days: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
}
