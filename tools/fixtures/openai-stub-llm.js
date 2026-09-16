'use strict';

/**
 * OpenAI 兼容的本地模型端点（测试替身）。
 *
 * 它只替代「模型的脑子」，不替代协议栈：dsh 是真的、ACP 是真的、工具是真的、
 * 权限请求是真的、落盘是真的。之所以需要它，是因为端到端验证不该依赖云端凭据——
 * 没有它，M2 的「真实内核」就只能跑到 control plane 为止，剩下的全是假设。
 *
 * 剧本由 STUB_SCRIPT 指定（JSON 数组），每一项是一次 assistant 回复：
 *   { "text": "..." }                                   纯文本
 *   { "tool": { "pick": "write", "args": {...} } }      按语义挑一个真实工具调用
 * pick 的取值：write / read / shell / any，从 dsh 请求体里的 tools 中挑选。
 *
 * 剧本步进按「对话里已出现几个工具结果」算，而不是按「请求序号」：
 * 前者只认真正跑完的工具，后者会被标题生成一类的旁路请求推歪 —— 那种情况下
 * 剧本会提前一步，而「模型提前说不出话」在测试里表现得像内核挂了。
 */

const fs = require('node:fs');
const http = require('node:http');

/** 从 dsh 发来的 tools 列表里按语义挑一个工具名。挑不到就返回 null。 */
function pickTool(tools, kind) {
  if (!Array.isArray(tools)) return null;
  const flat = tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean);
  const exact = flat.find((n) => n === kind) ?? flat.find((n) => n === `${kind}_file`);
  if (exact) return exact;
  // 词边界匹配：避免「create_goal」被「create」命中（这是真实工具名冲突）
  const boundary = new RegExp(`(^|_)${kind}(_|$)`);
  const matched = flat.find((n) => boundary.test(n));
  return matched ?? null;
}

function sse(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function base(id, model) {
  return { id, object: 'chat.completion.chunk', created: 0, model };
}

/**
 * 粗估一段内容的 token 数（≈4 字符 1 token）。
 *
 * 替身端点报的用量必须是**可复算的**，不能是一个「看起来像样」的常量：
 * 常量会让「端点自报的用量真的进了链路」与「链路上某个写死的数」无法区分，
 * 而那正是需要被验的那件事。
 */
function roughTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.max(1, Math.round(text.length / 4));
}

/** 请求侧 prompt 的 token 粗估：逐条消息的内容长度之和，外加每条的角色/分隔开销。 */
function estimatePromptTokens(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const chars = messages.reduce((sum, m) => {
    const c = m?.content;
    const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
    return sum + text.length + 4;
  }, 0);
  return Math.max(1, Math.round(chars / 4));
}

/**
 * 启动替身端点。
 * @param {object} options
 * @param {Array<object>} options.script 逐轮回复剧本
 * @param {string} [options.model] 对外自报的模型名
 * @param {(entry: object) => void} [options.onRequest] 每次收到请求时回调（取证用）
 * @returns {Promise<{ url: string, port: number, requests: Array<object>, close: () => Promise<void> }>}
 */
function startStubLlm(options = {}) {
  const script = options.script ?? [{ text: 'OK' }];
  const model = options.model ?? 'stub-model';
  const requests = [];
  const bodyLog = options.bodyLog ? fs.createWriteStream(options.bodyLog, { flags: 'a' }) : null;
  let seq = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';

      if (req.method === 'GET' && /\/models/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'stub' }] }));
        return;
      }

      if (req.method !== 'POST' || !/\/chat\/completions$/.test(url)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `stub: 不支持 ${req.method} ${url}` } }));
        return;
      }

      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }

      const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool');
      /**
       * 已发生的工具结果条数 —— 剧本的步进游标。
       *
       * 以「工具真的跑完了几个」为准，而不是「这是第几次请求」：内核可能为了
       * 标题、摘要一类的事另发请求，按请求序号步进会让剧本提前一格。
       * 2 步剧本下与旧的 `hasToolResult ? 1 : 0` 完全等价（≥1 就停在最后一格），
       * 所以既有用例的行为不变；3 步以上（如「拒绝 → 升级重试 → 收尾」）才推得动。
       */
      const toolResults = (body.messages ?? []).filter((m) => m.role === 'tool').length;
      /**
       * dsh 是否显式要求用量（`stream_options.include_usage`）。
       *
       * 真 OpenAI 只在被要求时才回那帧 usage，替身也必须这样 —— 无条件回 usage 的话，
       * 「内核确实要了用量」这件事就永远验不到，而它正是链路里最关键的一环。
       */
      const askedUsage = body.stream_options?.include_usage === true;

      const entry = {
        model: body.model,
        tools: (body.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean),
        /**
         * 各工具发过来的 parameters（JSON Schema）。
         *
         * 存在的理由与 `extra` 同：内核「有没有把某个参数广告给模型」是个**可观测量**，
         * 只断言「我们有这个能力」是不够的 —— 沙箱升级参数（`sandbox_permissions`
         * 与 `justification`）是按「是否挂了限制性文件系统后端」门控的，
         * 那些字段没被广告出去时，模型永远不可能申请升级，而链路上看不出任何异常。
         */
        toolParams: Object.fromEntries(
          (body.tools ?? [])
            .map((t) => [t?.function?.name ?? t?.name, t?.function?.parameters ?? null])
            .filter(([name]) => Boolean(name)),
        ),
        messages: (body.messages ?? []).map((m) => ({ role: m.role, kind: typeof m.content === 'string' ? 'text' : 'blocks' })),
        hasToolResult,
        toolResults,
        /**
         * 除大件（messages / tools）以外的请求字段。
         *
         * 存在的理由：内核到底把「推理档位」编成哪个请求字段，规格里没写、
         * 只能看真请求。留下它，测试就能把这件事记录下来而不是猜 ——
         * 断言「我们设了档位」和断言「档位真的到了请求里」是两件事。
         */
        extra: Object.fromEntries(
          Object.entries(body).filter(([key]) => !['messages', 'tools', 'model', 'stream', 'stream_options'].includes(key)),
        ),
        /** dsh 是否要求用量；false 时本替身不会回 usage 帧（与真端点一致） */
        askedUsage,
        /** 本次自报的用量，测试据此复算 —— null 表示这一轮没回 usage */
        reportedUsage: null,
      };
      requests.push(entry);
      options.onRequest?.(entry);
      if (bodyLog) bodyLog.write(`${JSON.stringify({ tools: body.tools, firstUserContent: body.messages?.find?.((m) => m.role === 'user') ?? null })}\n`);

      // 剧本推进：游标是「已跑完的工具结果数」（见上面的说明）
      const turn = Math.min(toolResults, script.length - 1);
      const step = script[turn] ?? { text: '' };
      const id = `stub-${++seq}`;

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      /** 本轮实际发出的助手内容，用量按它复算 */
      let completionText = '';

      if (step.text !== undefined) {
        completionText = step.text;
        sse(res, { ...base(id, model), choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] });
        sse(res, { ...base(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else if (step.tool) {
        const name = pickTool(body.tools, step.tool.pick);
        if (!name) {
          // 挑不到就退化成纯文本，并留下可诊断的痕迹，而不是静默什么都不做
          completionText = 'stub: 未找到匹配的工具';
          sse(res, { ...base(id, model), choices: [{ index: 0, delta: { role: 'assistant', content: completionText }, finish_reason: null }] });
          sse(res, { ...base(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        } else {
          const callId = `call_stub_${seq}`;
          completionText = JSON.stringify(step.tool.args ?? {});
          sse(res, {
            ...base(id, model),
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: completionText } }],
              },
              finish_reason: null,
            }],
          });
          sse(res, { ...base(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        }
      }

      if (askedUsage) {
        const promptTokens = estimatePromptTokens(body);
        const completionTokens = roughTokens(completionText);
        // 收尾用量帧的形状与 OpenAI 一致：choices 为空数组、usage 在顶层。
        // dsh 同时认「附在 finish 帧上」和「独立尾帧」两种形状，这里给后者。
        entry.reportedUsage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        };
        sse(res, { ...base(id, model), choices: [], usage: entry.reportedUsage });
      }

      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        port,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startStubLlm, pickTool };
