import {
  addUsage,
  emptyUsageTotals,
  estimateCost,
  type ModelPrice,
  type Usage,
  type UsageDayRow,
  type UsageModelRow,
  type UsageSessionRow,
  type UsageSummary,
  type UsageTotals,
} from '@deepwork/protocol';

/**
 * 用量聚合（M2-J）。
 *
 * ── 为什么不新建存储 ──
 * 用量的事实来源有两个且都已在磁盘上：会话 meta 的 `usage`（累计）与日志里的
 * `usage` 事件（逐轮）。再落一份「用量表」就是同一件事的第二个事实来源 ——
 * 两份数据必然漂移，而漂移时没有任何一方是权威，界面上的数字也就无法解释。
 * 因此这里只做**只读聚合**：扫既有会话存储，算完即弃。
 *
 * ── 为什么是纯函数 ──
 * `summarizeUsage` 不读文件、不看时钟、不取时区默认值（日切函数由调用方注入，
 * 与 `nextFire` 同一条纪律）。聚合口径是契约语义：宿主算出来的数、测试对拍的数、
 * 界面显示的数必须是同一套规则的结果，否则「分组之和 = 总数」这条等式
 * 只会在某一条路径上成立。
 *
 * ── 模型归属从哪来 ──
 * `usage` 事件本身不带模型名，所以按**该 run 的 `run.started.model`** 归属，
 * 而不是按「会话当前的 model」—— 一个会话可以在中途换模型，
 * 用后者会把换模型之前的用量算到新模型头上，那正是用量面板最该答对的题。
 */

export interface UsageSample {
  sessionId: string;
  runId: string;
  /** 该 run 使用的模型 */
  model: string;
  ts: number;
  usage: Usage;
}

export interface UsageSessionMeta {
  id: string;
  title: string;
  workspace: string;
  updatedAt: number;
}

export interface SummarizeInput {
  sessions: UsageSessionMeta[];
  samples: UsageSample[];
  prices: Record<string, ModelPrice>;
  /** 汇总时刻（注入点） */
  now: number;
  /** 日切函数（注入点）：生产用本地时区，测试用固定实现 */
  dayOf?: (ts: number) => string;
}

/** 本地时区的日键（YYYY-MM-DD）。「今天花了多少」必须是用户所在时区的今天。 */
export function localDayKey(ts: number): string {
  const date = new Date(ts);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 单价表清洗：单价必须是有限非负数。
 *
 * 坏值不能静默通过 —— 一个 NaN 单价会让整张估算表变成 NaN，而界面上只会显示
 * 一个 NaN，没人能从这里反推出是哪条配置写坏了。因此坏条目直接丢弃，
 * 丢弃后的模型会落进 `unpricedModels`，在界面上表现为「未定价」而不是假的数字。
 */
export function sanitizeModelPrices(input: unknown): Record<string, ModelPrice> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, ModelPrice> = {};
  for (const [model, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!model.trim()) continue;
    if (!raw || typeof raw !== 'object') continue;
    const price = raw as Record<string, unknown>;
    // 只认真正的数字：`Number(null)` 是 0、`Number('')` 也是 0，
    // 「顺手转一下」会把一份坏配置变成「单价 0」，也就是把「不知道」变成「免费」
    if (typeof price.promptPer1k !== 'number' || typeof price.completionPer1k !== 'number') continue;
    const { promptPer1k, completionPer1k } = price;
    if (!Number.isFinite(promptPer1k) || promptPer1k < 0) continue;
    if (!Number.isFinite(completionPer1k) || completionPer1k < 0) continue;
    out[model] = { promptPer1k, completionPer1k };
  }
  return out;
}

interface Bucket {  totals: UsageTotals;
  /** 只累加「有单价」的那部分估算值 */
  estimated: number;
  /** 无单价的模型集合；非空 ⇒ 该桶的估算不可用（返回 null，不假装 0） */
  unpriced: Set<string>;
}

function newBucket(): Bucket {
  return { totals: emptyUsageTotals(), estimated: 0, unpriced: new Set() };
}

function bucketCost(bucket: Bucket): number | null {
  return bucket.unpriced.size > 0 ? null : Number(bucket.estimated.toFixed(6));
}

function addSample(bucket: Bucket, sample: UsageSample, prices: Record<string, ModelPrice>): void {
  bucket.totals = addUsage(bucket.totals, sample.usage);
  const cost = estimateCost(sample.usage, prices[sample.model]);
  if (cost === null) bucket.unpriced.add(sample.model);
  else bucket.estimated += cost;
}

export function summarizeUsage(input: SummarizeInput): UsageSummary {
  const dayOf = input.dayOf ?? localDayKey;
  const { prices } = input;

  const totals = newBucket();
  const byDay = new Map<string, Bucket>();
  const byModel = new Map<string, Bucket>();
  const bySession = new Map<string, Bucket>();

  for (const sample of input.samples) {
    addSample(totals, sample, prices);

    const dayKey = dayOf(sample.ts);
    const dayBucket = byDay.get(dayKey) ?? newBucket();
    addSample(dayBucket, sample, prices);
    byDay.set(dayKey, dayBucket);

    const modelBucket = byModel.get(sample.model) ?? newBucket();
    addSample(modelBucket, sample, prices);
    byModel.set(sample.model, modelBucket);

    const sessionBucket = bySession.get(sample.sessionId) ?? newBucket();
    addSample(sessionBucket, sample, prices);
    bySession.set(sample.sessionId, sessionBucket);
  }

  const meta = new Map(input.sessions.map((session) => [session.id, session]));

  const dayRows: UsageDayRow[] = [...byDay.entries()]
    .map(([date, bucket]) => ({ date, totals: bucket.totals, estimatedCostCny: bucketCost(bucket) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const modelRows: UsageModelRow[] = [...byModel.entries()]
    .map(([model, bucket]) => ({ model, totals: bucket.totals, estimatedCostCny: bucketCost(bucket) }))
    // token 降序；同 token 时按名称升序，保证同一份数据每次渲染的顺序都相同
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || a.model.localeCompare(b.model));

  const sessionRows: UsageSessionRow[] = [...bySession.entries()]
    .map(([sessionId, bucket]) => {
      const info = meta.get(sessionId);
      return {
        sessionId,
        // 会话被删掉后日志也随之消失，理论上取不到 info；退化成 id 而不是空白，
        // 至少让「这是哪条会话」这件事还能被追。
        title: info?.title ?? sessionId,
        workspace: info?.workspace ?? '',
        updatedAt: info?.updatedAt ?? 0,
        totals: bucket.totals,
        estimatedCostCny: bucketCost(bucket),
      };
    })
    .sort(
      (a, b) => b.totals.totalTokens - a.totals.totalTokens || a.sessionId.localeCompare(b.sessionId),
    );

  return {
    totals: totals.totals,
    estimatedCostCny: bucketCost(totals),
    byDay: dayRows,
    byModel: modelRows,
    bySession: sessionRows,
    unpricedModels: [...totals.unpriced].sort(),
    generatedAt: input.now,
  };
}
