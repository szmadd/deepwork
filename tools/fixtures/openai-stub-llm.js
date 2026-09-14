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

      const entry = {
        model: body.model,
        tools: (body.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean),
        messages: (body.messages ?? []).map((m) => ({ role: m.role, kind: typeof m.content === 'string' ? 'text' : 'blocks' })),
        hasToolResult: (body.messages ?? []).some((m) => m.role === 'tool'),
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
      };
      requests.push(entry);
      options.onRequest?.(entry);
      if (bodyLog) bodyLog.write(`${JSON.stringify({ tools: body.tools, firstUserContent: body.messages?.find?.((m) => m.role === 'user') ?? null })}\n`);

      // 剧本推进：请求里出现 tool 结果就说明上一轮的工具已经跑完，进入下一项
      const turn = Math.min(entry.hasToolResult ? 1 : 0, script.length - 1);
      const step = script[turn] ?? { text: '' };
      const id = `stub-${++seq}`;

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      if (step.text !== undefined) {
        sse(res, { ...base(id, model), choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] });
        sse(res, { ...base(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else if (step.tool) {
        const name = pickTool(body.tools, step.tool.pick);
        if (!name) {
          // 挑不到就退化成纯文本，并留下可诊断的痕迹，而不是静默什么都不做
          sse(res, { ...base(id, model), choices: [{ index: 0, delta: { role: 'assistant', content: 'stub: 未找到匹配的工具' }, finish_reason: null }] });
          sse(res, { ...base(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        } else {
          const callId = `call_stub_${seq}`;
          sse(res, {
            ...base(id, model),
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(step.tool.args ?? {}) } }],
              },
              finish_reason: null,
            }],
          });
          sse(res, { ...base(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        }
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
