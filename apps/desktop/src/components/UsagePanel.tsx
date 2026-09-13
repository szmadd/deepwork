import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ModelPrice, UsageSummary, UsageTotals } from '@deepwork/protocol';
import { describeError } from '../api';
import { PanelPage } from './PanelPage';

interface UsagePanelProps {
  summary: UsageSummary | null;
  loading: boolean;
  /** 已配置的模型单价表（来自 config，不在渲染层另存一份） */
  prices: Record<string, ModelPrice>;
  onRefresh: () => Promise<void>;
  onSavePrices: (prices: Record<string, ModelPrice>) => Promise<void>;
  /** 跳到产生这些用量的会话 */
  onOpenSession: (sessionId: string) => Promise<void> | void;
  onClose: () => void;
}

/** 图表只画最近这些天；汇总数字恒为全量 —— 两者口径不同，界面上必须说清楚 */
const CHART_DAYS = 14;

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatCost(value: number | null): string {
  // null 不等于 0：它意味着「算不出来」（有模型没配单价），必须显示成文字而不是数字
  if (value === null) return '未定价';
  if (value === 0) return '¥0';
  return `¥${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

/**
 * 用量面板（M2-J）。
 *
 * ── 三个口径必须同时在场 ──
 * 同一个数字在不同口径下含义不同，所以面板同时给出：
 *  - **内核累计花费**：内核自己上报的 costCny（本地模型恒 0，这是真的，不是缺失）；
 *  - **估算花费**：拿配置里的单价表按 token 重算（换模型、调价之后这个才跟得上）；
 *  - **token 数**：唯一与价格无关、永远可比的量。
 * 只显示其中一个，都会在「刚换了模型」这段窗口里给出自相矛盾的结论。
 *
 * ── 未定价不显示成 0 ──
 * 有模型没配单价时估算返回 null，界面显示「未定价」并单独列出这些模型。
 * 显示 0 会被读成「免费」，那是把「不知道」伪装成「知道」。
 */
export function UsagePanel({
  summary,
  loading,
  prices,
  onRefresh,
  onSavePrices,
  onOpenSession,
  onClose,
}: UsagePanelProps) {
  const [priceDraft, setPriceDraft] = useState<Record<string, { prompt: string; completion: string }>>({});
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceSaved, setPriceSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const models = useMemo(() => summary?.byModel.map((row) => row.model) ?? [], [summary]);

  // 单价草稿以配置为准重建：模型清单或配置变化后，草稿不该保留一份已过期的输入
  useEffect(() => {
    const next: Record<string, { prompt: string; completion: string }> = {};
    for (const model of models) {
      const price = prices[model];
      next[model] = {
        prompt: price ? String(price.promptPer1k) : '',
        completion: price ? String(price.completionPer1k) : '',
      };
    }
    setPriceDraft(next);
    setPriceSaved(false);
  }, [models.join('\n'), JSON.stringify(prices)]);

  const savePrices = async () => {
    setBusy(true);
    setPriceError(null);
    try {
      const payload: Record<string, ModelPrice> = {};
      for (const [model, draft] of Object.entries(priceDraft)) {
        if (!draft.prompt.trim() && !draft.completion.trim()) continue;
        const promptPer1k = Number(draft.prompt);
        const completionPer1k = Number(draft.completion);
        if (!Number.isFinite(promptPer1k) || promptPer1k < 0) throw new Error(`${model} 的 prompt 单价不是有效的非负数`);
        if (!Number.isFinite(completionPer1k) || completionPer1k < 0) {
          throw new Error(`${model} 的 completion 单价不是有效的非负数`);
        }
        payload[model] = { promptPer1k, completionPer1k };
      }
      await onSavePrices(payload);
      setPriceSaved(true);
    } catch (cause) {
      setPriceError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const totals = summary?.totals ?? null;

  return (
    <PanelPage
      title="用量"
      subtitle="跨会话聚合 · 数据来自会话存储，不另存一份"
      onBack={onClose}
      actions={
        <button type="button" className="btn btn-tiny" onClick={() => void onRefresh()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      }
    >
      {!summary ? (
        <div className="empty-hint">正在汇总用量…</div>
      ) : summary.totals.runs === 0 ? (
        <div className="empty-hint">
          还没有用量数据。跑一轮对话之后，这里会按日 / 按模型 / 按会话三个维度聚合。
        </div>
      ) : (
        <>
          <div className="usage-cards">
            <StatCard
              label="总 token"
              value={formatTokens(totals!.totalTokens)}
              sub={`${formatTokens(totals!.promptTokens)} 输入 · ${formatTokens(totals!.completionTokens)} 输出`}
            />
            <StatCard
              label="内核累计花费"
              value={`¥${totals!.costCny.toFixed(4)}`}
              sub="内核上报；本地模型恒为 0"
            />
            <StatCard
              label="估算花费"
              value={formatCost(summary.estimatedCostCny)}
              sub={summary.unpricedModels.length > 0 ? `${summary.unpricedModels.length} 个模型未定价` : '按配置单价重算'}
            />
            <StatCard
              label="规模"
              value={`${summary.bySession.length} 会话`}
              sub={`${totals!.runs} 次模型调用 · ${summary.byDay.length} 天`}
            />
          </div>

          {summary.unpricedModels.length > 0 ? (
            <div className="modal-hint modal-hint-warn">
              以下模型没有配置单价，估算花费会把它们漏掉并显示为「未定价」：
              <code>{summary.unpricedModels.join(' · ')}</code>
              —— 在页面底部填上单价即可。
            </div>
          ) : null}

          <DayChart summary={summary} />

          <SectionTitle>按模型</SectionTitle>
          <table className="usage-table">
            <thead>
              <tr>
                <th>模型</th>
                <th className="num">输入</th>
                <th className="num">输出</th>
                <th className="num">合计</th>
                <th className="num">占比</th>
                <th className="num">估算花费</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((row) => (
                <tr key={row.model}>
                  <td className="mono">{row.model}</td>
                  <td className="num">{formatTokens(row.totals.promptTokens)}</td>
                  <td className="num">{formatTokens(row.totals.completionTokens)}</td>
                  <td className="num">{formatTokens(row.totals.totalTokens)}</td>
                  <td className="num">{share(row.totals, totals!)}</td>
                  <td className="num">{formatCost(row.estimatedCostCny)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <SectionTitle>按会话</SectionTitle>
          <div className="usage-sessions">
            {summary.bySession.map((row) => (
              <button
                type="button"
                className="usage-session"
                key={row.sessionId}
                onClick={() => void onOpenSession(row.sessionId)}
                title={`跳到会话 ${row.sessionId}`}
              >
                <div className="usage-session-main">
                  <span className="usage-session-title">{row.title}</span>
                  <span className="usage-session-path">{baseName(row.workspace) || '—'}</span>
                </div>
                <span className="usage-session-tokens">{formatTokens(row.totals.totalTokens)}</span>
                <span className="usage-session-cost">{formatCost(row.estimatedCostCny)}</span>
              </button>
            ))}
          </div>

          <SectionTitle>模型单价（元 / 千 token）</SectionTitle>
          <div className="modal-hint">
            价格会变，所以不写进代码 —— 留空的模型按「未定价」处理，不会被当成 0。
          </div>
          <table className="usage-table">
            <thead>
              <tr>
                <th>模型</th>
                <th className="num">输入 / 千</th>
                <th className="num">输出 / 千</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model}>
                  <td className="mono">{model}</td>
                  <td className="num">
                    <input
                      className="settings-input usage-price-input"
                      inputMode="decimal"
                      placeholder="例如 0.001"
                      value={priceDraft[model]?.prompt ?? ''}
                      onChange={(event) => {
                        setPriceDraft((prev) => ({
                          ...prev,
                          [model]: { ...prev[model], prompt: event.target.value },
                        }));
                        setPriceSaved(false);
                      }}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="settings-input usage-price-input"
                      inputMode="decimal"
                      placeholder="例如 0.002"
                      value={priceDraft[model]?.completion ?? ''}
                      onChange={(event) => {
                        setPriceDraft((prev) => ({
                          ...prev,
                          [model]: { ...prev[model], completion: event.target.value },
                        }));
                        setPriceSaved(false);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {priceError ? <div className="modal-hint modal-hint-warn">{priceError}</div> : null}
          {priceSaved ? <div className="modal-hint skill-clean">单价已保存</div> : null}
          <div className="usage-price-foot">
            <button type="button" className="btn btn-primary btn-tiny" disabled={busy} onClick={() => void savePrices()}>
              {busy ? '保存中…' : '保存单价'}
            </button>
          </div>
        </>
      )}
    </PanelPage>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="page-section">{children}</div>;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="usage-card">
      <div className="usage-card-label">{label}</div>
      <div className="usage-card-value">{value}</div>
      <div className="usage-card-sub">{sub}</div>
    </div>
  );
}

function share(row: UsageTotals, totals: UsageTotals): string {
  if (totals.totalTokens <= 0) return '—';
  return `${((row.totalTokens / totals.totalTokens) * 100).toFixed(1)}%`;
}

function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * 按日柱状图。
 *
 * 手写 SVG 而不是引图表库：需求只有「一根柱一天、看得见趋势」，
 * 引一个几十 KB 的库换来的动效与交互，代价是这个项目多一个依赖。
 *
 * 它只画最近 {@link CHART_DAYS} 天：柱子多到看不清时，趋势就没人看了 ——
 * 但**合计与分组恒为全量**，所以标题里明确写出「只画最近 N 天」，
 * 不让「图上的和加起来对不上」变成一个需要用户自己发现的坑。
 */
function DayChart({ summary }: { summary: UsageSummary }) {
  const days = summary.byDay.slice(-CHART_DAYS);
  if (days.length === 0) return null;

  const W = 680;
  const H = 170;
  const left = 46;
  const bottom = 24;
  const top = 12;
  const max = Math.max(...days.map((day) => day.totals.totalTokens), 1);
  const slot = (W - left - 8) / days.length;
  const barW = Math.min(38, slot * 0.62);

  return (
    <div className="usage-chart">
      <div className="usage-chart-head">
        <span>{days.length < CHART_DAYS ? `按日（共 ${days.length} 天）` : `按日（只画最近 ${CHART_DAYS} 天）`}</span>
        <span className="panel-spacer" />
        <span className="usage-chart-legend">实心 = 该日 token 量</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="按日 token 用量">
        {[0, 0.5, 1].map((ratio) => {
          const y = top + (H - top - bottom) * (1 - ratio);
          return (
            <g key={ratio}>
              <line x1={left} y1={y} x2={W - 8} y2={y} stroke="var(--border)" strokeWidth="1" />
              <text x={left - 8} y={y + 4} textAnchor="end" className="usage-axis">
                {formatTokens(Math.round(max * ratio))}
              </text>
            </g>
          );
        })}
        {days.map((day, index) => {
          const height = ((H - top - bottom) * day.totals.totalTokens) / max;
          const x = left + slot * index + (slot - barW) / 2;
          const y = H - bottom - height;
          return (
            <g key={day.date}>
              <rect x={x} y={y} width={barW} height={Math.max(height, day.totals.totalTokens > 0 ? 2 : 0)} rx="3" fill="var(--accent)" opacity="0.85">
                <title>
                  {day.date} · {formatTokens(day.totals.totalTokens)} token · {day.totals.runs} 次调用 ·{' '}
                  {formatCost(day.estimatedCostCny)}（估算）
                </title>
              </rect>
              <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="usage-axis">
                {day.date.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
