'use strict';

/**
 * 最小 MCP server（测试 fixture）：stdio 传输，换行分隔 JSON-RPC 2.0。
 *
 * 按 MCP 官方规格实现 initialize / notifications 忽略 / ping / tools/list /
 * tools/call 的最小闭环，只发布一个 echo 工具（入参 { text }，原样回显）。
 * 用途：证明真实 dsh 的 dsh-mcp-client 插件能把外部 server 的工具
 * 注册为 mcp__<serverName>__echo 并把调用路由回来 —— 替的是「外部工具
 * 提供方」，dsh、ACP、适配层全是真的。
 */

const readline = require('node:readline');

const PROTOCOL_VERSION = '2024-11-05';

const ECHO_TOOL = {
  name: 'echo',
  description: '原样回显入参 text（测试用）',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
  // 通知（无 id）不应答
  if (request.id === undefined || request.id === null) return;

  const reply = (result) => send({ jsonrpc: '2.0', id: request.id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id: request.id, error: { code, message } });

  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: request.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-server', version: '0.0.1' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: [ECHO_TOOL] });
    case 'tools/call': {
      const name = request.params?.name;
      if (name !== 'echo') return fail(-32602, `unknown tool: ${String(name)}`);
      const text = request.params?.arguments?.text;
      return reply({ content: [{ type: 'text', text: `echo:${String(text ?? '')}` }] });
    }
    default:
      return fail(-32601, `method not found: ${String(request.method)}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch (error) {
    // 解析失败也要有应答形状，否则客户端会一直等到超时
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error?.message ?? error) } });
  }
});
