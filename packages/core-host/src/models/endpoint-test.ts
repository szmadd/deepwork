/**
 * 端点连通性测试：对 `GET {baseUrl}/models` 发一次真实请求。
 *
 * 为什么要有它：内网部署排障时，「模型无法访问」可能是四层里任何一层 ——
 * 服务没起、地址端口错、key 无效、baseUrl 少了 /v1。没有这个测试时，
 * 用户只能靠发一轮对话去试，换来的是一句端点侧的 "Model not found"，
 * 四层原因共用一个症状。测试把诊断提前到配置的那一刻，且每层给出不同的、
 * 可行动的提示。
 *
 * 实现要点：
 *  - 用 Node 22+ 内置的全局 fetch，不引依赖；`AbortSignal.timeout` 控 8 秒上限；
 *  - 只发 GET /models（OpenAI 兼容端点的必备面），不发 chat —— 测试的语义是
 *    「通不通、有哪些模型」，不是「能不能推理」，后者要真跑一轮才知道；
 *  - key 只放进 Authorization 头，不进 URL、不进返回值 —— 结果对象可以安全地
 *    穿过 RPC 与界面。
 */

import type { EndpointTestResult } from '@deepwork/protocol';

const TEST_TIMEOUT_MS = 8_000;

function fail(latencyMs: number, error: string, httpStatus?: number): EndpointTestResult {
  return { ok: false, latencyMs, models: [], error, ...(httpStatus !== undefined ? { httpStatus } : {}) };
}

/** 把 fetch 的底层异常翻成用户能行动的一句中文。 */
function describeCause(error: unknown): string {
  // undici 的 'fetch failed' 把真因包在 cause 里；多栈解析（IPv4/IPv6 都试）时
  // cause 是 AggregateError，真因在它的 errors[0]。
  let cause = (error as { cause?: unknown })?.cause ?? error;
  if (cause instanceof AggregateError) cause = cause.errors[0] ?? cause;
  const code = (cause as { code?: string })?.code ?? (error as { code?: string })?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return '连接被拒绝：端点服务未在监听。确认服务已启动、地址与端口正确。';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '主机名无法解析：确认地址拼写，或改用 IP。';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return '连接超时：网络不可达（确认两台机器互通、防火墙放行该端口）。';
    default:
      break;
  }
  if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
    return `超过 ${TEST_TIMEOUT_MS / 1000} 秒无响应：网络不可达或服务过载。`;
  }
  return `请求失败：${error instanceof Error ? error.message : String(error)}`;
}

export async function testEndpoint(input: { baseUrl: string; apiKey?: string }): Promise<EndpointTestResult> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    return fail(0, '端点地址需要以 http(s):// 开头，例如 http://127.0.0.1:8000/v1');
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (error) {
    return fail(Date.now() - startedAt, describeCause(error));
  }
  const latencyMs = Date.now() - startedAt;

  if (response.status === 401 || response.status === 403) {
    return fail(latencyMs, '端点拒绝了凭据（401/403）：key 无效或未授权，请在下方重新保存 key。', response.status);
  }
  if (response.status === 404) {
    return fail(
      latencyMs,
      '服务在线，但 /models 返回 404：baseUrl 多半少了 /v1 前缀（应为 http://主机:端口/v1）。',
      response.status,
    );
  }
  if (!response.ok) {
    return fail(latencyMs, `端点返回 HTTP ${response.status}：服务在线但应答异常，请查看端点侧日志。`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fail(latencyMs, '响应不是 JSON：这多半不是一个 OpenAI 兼容端点。', response.status);
  }
  const data = (body as { data?: unknown })?.data;
  const models = Array.isArray(data)
    ? data
        .map((item) => (item as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return { ok: true, httpStatus: response.status, latencyMs, models };
}
