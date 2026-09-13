'use strict';

/**
 * 真实 dsh 探针 —— 把真实内核的实际帧打印出来。
 *
 *   node tools/real-dsh-probe.js
 *
 * 用途：契约校准不能靠读 README 猜，必须让真实进程自己说出来 ——
 * 尤其是协议版本号、能力集、session/prompt 的参数形状、update 的字段形状。
 *
 * 本脚本刻意不做断言：它是取证工具，不是测试。断言住在 real-dsh-e2e.js。
 * 模型端点默认指向本地替身（tools/fixtures/openai-stub-llm.js），
 * 设置 DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY 即可换成真实或自建的 OpenAI 兼容端点。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startStubLlm } = require('./fixtures/openai-stub-llm');

const DSH_BIN = path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

/** 候选的 session/prompt 参数形状。真实内核会明确拒绝错的那个，以它为准。 */
const PROMPT_SHAPES = {
  'content 数组': (sessionId, text) => ({ sessionId, content: [{ type: 'text', text }] }),
  'prompt=块数组': (sessionId, text) => ({ sessionId, prompt: [{ type: 'text', text }] }),
  'prompt=轮次数组': (sessionId, text) => ({ sessionId, prompt: [{ role: 'user', content: [{ type: 'text', text }] }] }),
};

function frame(label, value) {
  console.log(`\n─── ${label} ───`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const useStub = !process.env.DEEPSEEK_BASE_URL;
  const stub = useStub ? await startStubLlm({ script: [{ text: 'OK' }] }) : null;
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? stub.url;

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-dsh-probe-'));
  console.log('workspace:', workspace);
  console.log('dsh bin  :', DSH_BIN, fs.existsSync(DSH_BIN) ? '(ok)' : '(缺失)');
  console.log('model url:', baseUrl, useStub ? '(本地替身)' : '(外部端点)');

  const child = spawn(process.execPath, [DSH_BIN, '--profile', 'acp'], {
    cwd: workspace,
    env: { ...process.env, DEEPSEEK_BASE_URL: baseUrl, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'stub-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let nextId = 1;
  const pending = new Map();
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let i = buffer.indexOf('\n');
    while (i >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) {
        try {
          handle(JSON.parse(line));
        } catch {
          console.log('[非 JSON 行]', line.slice(0, 300));
        }
      }
      i = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    process.stdout.write(`[stderr] ${chunk.toString('utf8').trimEnd()}\n`);
  });
  child.on('exit', (code) => console.log(`\n[exit] code=${code}`));

  function handle(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      console.log(`\n[收到] ${msg.method}`);
      console.log(JSON.stringify(msg.params, null, 2));
      if (msg.id !== undefined) {
        // 反向请求：如实回答「未实现」，让内核自己暴露它到底需要什么
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'probe: 未实现' } })}\n`,
        );
      }
    }
  }

  function request(method, params, timeoutMs = 60_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: 'deepwork-probe', version: '0.1.0' },
  });
  frame('initialize 结果', init);

  const created = await request('session/new', { cwd: workspace, mcpServers: [] });
  frame('session/new 结果', created);

  const sessionId = created.sessionId;

  for (const [label, build] of Object.entries(PROMPT_SHAPES)) {
    try {
      const result = await request('session/prompt', build(sessionId, '回复 OK 两个字即可'), 90_000);
      frame(`session/prompt 成功 —— ${label}`, result);
      break; // 第一个被接受的形状就是真契约
    } catch (error) {
      frame(`session/prompt 被拒 —— ${label}`, String(error.message).slice(0, 900));
    }
  }

  frame('模型端点收到的请求', stub ? stub.requests : '(未使用本地替身)');

  try {
    frame('session/list 结果', await request('session/list', {}));
  } catch (error) {
    frame('session/list 失败', String(error.message).slice(0, 600));
  }

  try {
    frame('session/close 结果', await request('session/close', { sessionId }));
  } catch (error) {
    frame('session/close 失败', String(error.message).slice(0, 600));
  }

  child.stdin.end();
  await stub?.close();
  setTimeout(() => child.kill(), 3000);
}

main().catch((error) => {
  console.error('\n[探针异常]', error);
  process.exitCode = 1;
});
