import { useState } from 'react';
import type { ScheduleSpec, ScheduleTask } from '@deepwork/protocol';
import { describeSchedule, validateScheduleSpec } from '@deepwork/protocol';
import { describeError } from '../api';

interface SchedulesPanelProps {
  /** 当前会话绑定的工作区（新建任务的默认落点） */
  workspace: string | null;
  schedules: ScheduleTask[];
  onRefresh: () => Promise<void>;
  onAdd: (input: { title: string; prompt: string; workspace: string; spec: ScheduleSpec }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onRunNow: (id: string) => Promise<void>;
  onClose: () => void;
}

const KIND_LABEL: Record<ScheduleSpec['kind'], string> = {
  once: '一次性',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  interval: '间隔',
};

const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'] as const;

const STATUS_LABEL = { completed: '完成', failed: '失败', aborted: '已中断' } as const;

/**
 * 自动化调度面板。
 *
 * ── 形态边界必须写明白 ──
 * 调度只在应用运行期间生效（桌面应用没有常驻守护进程）。这不是缺陷而是形态，
 * 面板顶部直接写明，而不是等用户发现「昨晚的任务没跑」。
 *
 * ── 任务与调度解耦 ──
 * 任务本体是自然语言提示词，时间参数是独立配置的 spec ——
 * 表单里两者是分开的控件，互不嵌套。
 */
export function SchedulesPanel({
  workspace,
  schedules,
  onRefresh,
  onAdd,
  onRemove,
  onToggle,
  onRunNow,
  onClose,
}: SchedulesPanelProps) {
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page-mask">
      <div className="page">
        <div className="page-head">
          <button type="button" className="icon-btn page-back" onClick={onClose} title="返回对话">
            ←
          </button>
          <span className="page-title-text">自动化</span>
          <span className="panel-spacer" />
        </div>

        <div className="page-body">
          {error ? <div className="banner banner-error">{error}</div> : null}

          <div className="modal-hint">
            定时任务到点会派生一轮真实运行（走正常的技能/记忆注入与审批网关，不享有特权）。
            <strong>调度只在本应用运行期间生效</strong>：应用没开就是没跑，错过的时间不会补跑，
            「上次触发」如实反映最近一次真实运行。
          </div>

          {schedules.length === 0 && !showForm ? (
            <div className="empty-hint">还没有定时任务。点击「新建任务」，用自然语言描述任务，再独立配置触发时间。</div>
          ) : null}

          {schedules.map((task) => (
            <div className={`schedule-item${task.enabled ? '' : ' schedule-item-off'}`} key={task.id}>
              <div className="schedule-row">
                <label className="modal-check">
                  <input
                    type="checkbox"
                    checked={task.enabled}
                    disabled={busyId === task.id}
                    onChange={(event) => void act(task.id, () => onToggle(task.id, event.target.checked))}
                  />
                  <span className="schedule-title">{task.title}</span>
                </label>
                <span className="panel-spacer" />
                <button
                  type="button"
                  className="btn-tiny"
                  disabled={busyId === task.id}
                  title="立即触发一次（不改变计划与启停状态）"
                  onClick={() => void act(task.id, () => onRunNow(task.id))}
                >
                  立即运行
                </button>
                <button
                  type="button"
                  className="btn-tiny btn-danger"
                  disabled={busyId === task.id}
                  onClick={() => void act(task.id, () => onRemove(task.id))}
                >
                  删除
                </button>
              </div>
              <div className="schedule-desc">{describeSchedule(task.spec)}</div>
              <div className="schedule-meta">
                {task.enabled && task.nextRunAt
                  ? `下次触发：${formatLocal(task.nextRunAt)}`
                  : task.enabled
                    ? '下次触发：—'
                    : '已停用'}
                {' · '}已触发 {task.runCount} 次
                {task.lastRunAt
                  ? ` · 上次：${formatLocal(task.lastRunAt)}${task.lastStatus ? `（${STATUS_LABEL[task.lastStatus]}）` : ''}`
                  : ' · 尚未触发过'}
              </div>
              <div className="schedule-prompt" title={task.prompt}>
                {task.prompt}
              </div>
            </div>
          ))}

          {showForm ? (
            <ScheduleForm
              workspace={workspace}
              onSubmit={async (input) => {
                setError(null);
                try {
                  await onAdd(input);
                  setShowForm(false);
                } catch (cause) {
                  setError(describeError(cause));
                }
              }}
              onCancel={() => setShowForm(false)}
            />
          ) : null}
        </div>

        <div className="page-foot">
          <button type="button" className="btn" onClick={() => void onRefresh()}>
            刷新
          </button>
          <span className="panel-spacer" />
          {!showForm ? (
            <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
              新建任务
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            返回对话
          </button>
        </div>
      </div>
    </div>
  );
}

/** ISO → 本地「MM-DD HH:MM」短格式 */
function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 新建表单：任务本体（标题 + 提示词）与调度参数（类型选择器 + 对应控件）分开 */
function ScheduleForm({
  workspace,
  onSubmit,
  onCancel,
}: {
  workspace: string | null;
  onSubmit: (input: { title: string; prompt: string; workspace: string; spec: ScheduleSpec }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<ScheduleSpec['kind']>('daily');
  const [onceAt, setOnceAt] = useState('');
  const [time, setTime] = useState('09:00');
  const [weekdays, setWeekdays] = useState<number[]>([1, 3, 5]);
  const [monthDay, setMonthDay] = useState(1);
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildSpec = (): ScheduleSpec => {
    switch (kind) {
      case 'once':
        // datetime-local 给的是本地时刻，落成 ISO（带时区）交给内核
        return { kind, at: onceAt ? new Date(onceAt).toISOString() : '' };
      case 'daily':
        return { kind, time };
      case 'weekly':
        return { kind, weekdays: [...weekdays].sort((a, b) => a - b), time };
      case 'monthly':
        return { kind, day: monthDay, time };
      case 'interval':
        return { kind, everyMinutes };
    }
  };

  const spec = buildSpec();
  const invalid = validateScheduleSpec(spec) ?? (kind === 'once' && !onceAt ? '请选择触发时刻' : null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ title, prompt, workspace: workspace ?? '', spec });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="schedule-form">
      <div className="modal-label">新建定时任务</div>
      {error ? <div className="banner banner-error">{error}</div> : null}

      <input
        className="settings-input"
        placeholder="任务标题（如：每日晨会纪要）"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        className="settings-input settings-textarea"
        rows={3}
        placeholder="任务内容：用自然语言描述要内核做什么，到点会作为一轮真实运行发出…"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <div className="schedule-meta">
        工作区：{workspace ?? '（当前无会话工作区，无法创建）'}
      </div>

      <div className="schedule-form-row">
        <label className="control">
          <span>调度</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as ScheduleSpec['kind'])}>
            {(Object.keys(KIND_LABEL) as ScheduleSpec['kind'][]).map((k) => (
              <option value={k} key={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>

        {kind === 'once' ? (
          <label className="control">
            <span>时刻</span>
            <input type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} />
          </label>
        ) : null}

        {kind === 'daily' || kind === 'weekly' || kind === 'monthly' ? (
          <label className="control">
            <span>时间</span>
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </label>
        ) : null}

        {kind === 'monthly' ? (
          <label className="control">
            <span>日期</span>
            <input
              type="number"
              min={1}
              max={31}
              value={monthDay}
              onChange={(event) => setMonthDay(Number(event.target.value))}
            />
          </label>
        ) : null}

        {kind === 'interval' ? (
          <label className="control">
            <span>每 N 分钟</span>
            <input
              type="number"
              min={1}
              value={everyMinutes}
              onChange={(event) => setEveryMinutes(Number(event.target.value))}
            />
          </label>
        ) : null}
      </div>

      {kind === 'weekly' ? (
        <div className="schedule-weekdays">
          {WEEKDAY_LABEL.map((label, day) => (
            <label className="modal-check" key={day}>
              <input
                type="checkbox"
                checked={weekdays.includes(day)}
                onChange={(event) =>
                  setWeekdays((prev) =>
                    event.target.checked ? [...prev, day] : prev.filter((item) => item !== day),
                  )
                }
              />
              <span>周{label}</span>
            </label>
          ))}
        </div>
      ) : null}

      <div className="modal-hint">
        {invalid ? invalid : `将创建：${describeSchedule(spec)}`}
      </div>

      <div className="schedule-form-foot">
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || Boolean(invalid) || !title.trim() || !prompt.trim() || !workspace}
          onClick={() => void submit()}
        >
          {busy ? '创建中…' : '创建任务'}
        </button>
      </div>
    </div>
  );
}
