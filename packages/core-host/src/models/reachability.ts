/**
 * 端点可达性结论的**缓存**与**措辞**（FR-10.2 后半）。
 *
 * ── 为什么是「最近一次探测」而不是「开跑前测一次」──────────────────────
 * 开跑前现测一次最准确，但代价是每轮多一次网络往返（最坏 8 秒超时）。这里选
 * 「后台探测 + 缓存 + 新鲜期」，开跑时只**读**结论、不阻塞 —— 用户不该为一句提示
 * 等一次网络超时。代价是结论可能过期，所以：
 *
 *   1. 新鲜期（`REACHABILITY_TTL_MS`）之外一律不提示；
 *   2. 换了端点（指纹不同）一律不提示 —— 旧结论与新端点无关；
 *   3. 提示里**必须**带上探测时刻（`basis`）。
 *
 * 第 3 条是这一整块的要害。不写时刻的话，用户会把一条五分钟前的结论当成实时状态：
 * 去查一个早就重启好的服务、或者反过来无视一个真正挂了的东西。
 *
 * ── 为什么只提示、不拦 ──────────────────────────────────────────────
 * 探测打的是 `GET {baseUrl}/models`。**它不是 OpenAI 兼容端点的强制面** ——
 * 有些网关只实现 `/chat/completions`。拿一个非强制面的探测结果去拦下请求，
 * 会把本来能用的部署打断，而用户拿到的是一句「端点不可达」，根本查不出所以然。
 * 所以：说清楚、照常发、把「探不通不等于用不了」写在提示里。
 *
 * ── 为什么只探自定义端点 ────────────────────────────────────────────
 * 官方端点（api.deepseek.com）没配 key 时探测必然 401，那会把「你还没填 key」
 * 说成「端点有问题」。官方端点的可达性是官方的事，我们不下结论。
 */

import type { EndpointFailureKind, EndpointTestResult, ModelEndpoint } from '@deepwork/protocol';
import { endpointRoutingFingerprint } from './endpoint';

/** 一份探测结论的新鲜期。超时就不拿它提示用户。 */
export const REACHABILITY_TTL_MS = 5 * 60_000;

export interface ReachabilityRecord {
  /**
   * 这份结论是就**哪个端点**得出的。
   *
   * 用路由指纹比对而不是 baseUrl 字符串：指纹已经做过归一化（末尾斜杠等），
   * 而「同一条地址的两种写法」被当成改过端点，会让缓存每次都失效。
   * 指纹里含 `official` 与 `custom:<baseUrl>`，所以「从官方切到自定义」也会失效 ——
   * 这正是要的。
   */
  fingerprint: string;
  checkedAt: number;
  result: EndpointTestResult;
}

/** 结论是否还能用于提示：必须**同时**满足「同一个端点」与「没过期」。 */
export function isReachabilityFresh(
  record: ReachabilityRecord,
  endpoint: ModelEndpoint,
  now: number = Date.now(),
  ttlMs: number = REACHABILITY_TTL_MS,
): boolean {
  if (record.fingerprint !== endpointRoutingFingerprint(endpoint)) return false;
  const age = now - record.checkedAt;
  // 时钟回拨（age 为负）按「不可信」处理：宁可不说，也不拿一份来路不明的结论提示用户
  return age >= 0 && age <= ttlMs;
}

/**
 * 失败分类 → 一句话的定性。
 *
 * ── 为什么要分开写「不可达」与「可达但…」────────────────────────────
 * 这五个失败里只有 `unreachable` 是真的连不上；`auth` / `not-found` /
 * `bad-response` / `not-json` 都发生在**连上之后**。把它们一律说成「端点不可达」，
 * 用户会去查网络与服务进程 —— 而真正要改的是 key 或地址后缀。
 * 把「可达」和「不可达」混成一句话，是这个提示最容易犯、也最误导人的错。
 */
const HEADLINE: Record<EndpointFailureKind, string> = {
  'invalid-url': '端点地址不合规',
  unreachable: '端点不可达',
  auth: '端点连上了，但凭据被拒',
  'not-found': '端点连上了，但地址路径不对',
  'bad-response': '端点连上了，但应答异常',
  'not-json': '端点连上了，但不像 OpenAI 兼容端点',
};

export interface EndpointNotice {
  level: 'warn';
  message: string;
  remedy: string;
  basis: string;
}

/**
 * 开跑提示；没有值得说的（没探测过、过期了、换了端点、探测是通的、官方端点）
 * 一律返回 null —— **不编一句「建议检查配置」凑数**：一条永远出现的提示等于没有提示。
 */
export function endpointProbeNotice(input: {
  endpoint: ModelEndpoint;
  record: ReachabilityRecord | null;
  now?: number;
  ttlMs?: number;
}): EndpointNotice | null {
  const { endpoint, record } = input;
  if (endpoint.kind !== 'custom') return null;
  if (record === null) return null;
  if (!isReachabilityFresh(record, endpoint, input.now ?? Date.now(), input.ttlMs)) return null;
  if (record.result.ok) return null;

  const baseUrl = (endpoint.baseUrl ?? '').trim() || '(未填地址)';
  // 探测层给出的 error 已经是一句可行动的中文（见 endpoint-test.ts 的 describeCause），
  // 这里**不再自己写一遍建议** —— 那是把同一份知识抄成两份，改一处漏一处。
  const detail = record.result.error ?? '原因未记录';
  const headline = HEADLINE[record.result.kind ?? 'unreachable'];
  return {
    level: 'warn',
    message: `自定义端点（${baseUrl}）${headline}：${detail}`,
    remedy:
      '这一轮仍会照常把请求发出去 —— /models 不是所有 OpenAI 兼容端点都实现，探不通不等于用不了。' +
      '改完配置可在设置页点「测试连接」重新确认。',
    basis: `依据：${new Date(record.checkedAt).toLocaleString()} 的那次探测，不是此刻的实时状态`,
  };
}
