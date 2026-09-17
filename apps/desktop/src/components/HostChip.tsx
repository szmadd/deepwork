import type { HostState } from '@deepwork/protocol';

/**
 * 内核状态 chip。
 *
 * ── 为什么单独抽成一个组件 ──
 * 它在两处出现：会话列表上方（「你现在在跟谁说话」）与输入区工具行右侧
 * （「现在能不能打字」）。两处同框，而「就绪 / 启动中 / 重启中 / 已停止」
 * 这四个词就是同一份判据 —— 各写一遍的结果是它们迟早对不上，
 * 且对不上的那天画面上同时站着两个互相矛盾的结论。
 *
 * 外观差异交给使用方：`.composer-tools` 里靠一条后代规则把边框与留白收掉。
 */
const STATE_LABEL: Record<HostState, string> = {
  starting: '启动中',
  ready: '就绪',
  restarting: '重启中',
  stopped: '已停止',
};

interface HostChipProps {
  state: HostState;
  /** 内核适配器名（真内核是 harness，mock 是 mock） */
  adapter?: string;
  /** 宿主给的补充说明（版本、失败原因），挂在 title 上 */
  detail?: string;
}

export function HostChip({ state, adapter, detail }: HostChipProps) {
  return (
    <span className={`host-chip host-${state}`} title={detail || undefined}>
      <span className="dot" />
      {STATE_LABEL[state]}
      {adapter ? ` · ${adapter}` : ''}
    </span>
  );
}
