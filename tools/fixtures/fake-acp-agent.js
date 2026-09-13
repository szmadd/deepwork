#!/usr/bin/env node
/**
 * 参考 ACP agent（测试替身）。
 *
 * 它存在的理由：真实 dsh 启动一次要几秒、还要模型端点，不适合放在每条断言里跑。
 * 但「我们的客户端是否符合 ACP 规格」这件事必须可验证 —— 否则所谓校准
 * 只是把一组占位字符串换成另一组，仍然没有证据。
 *
 * 因此这里按 ACP 规格实现一个最小 agent：stdin 收协议、stdout 回协议、
 * 诊断走 stderr。一致性测试用它驱动完整一轮，断言客户端行为。
 *
 * ── 形状要跟着真实内核走（2026-09-12 起）─────────────────────────
 * 真实 dsh 实测后（tools/real-dsh-probe.js）暴露了三处与规格示例不同的写法，
 * 本 agent **两种形状都发**，让断言能同时看守规格路径与 dsh 路径：
 *   1. 权限请求的工具 id 在 `toolCall.toolCallId`，选项 id 键是 `optionId`；
 *   2. tool_call 的 `kind` 恒为 "other"，工具名在 `title`、入参在 `rawInput`；
 *   3. tool_call_update 的 `content` 是 { type:'content', content: 块 } 包装。
 * 只按一种形状写测试，就会在另一种形状上静默失效。
 *
 * 两条纪律：
 *  1. stdout 只允许出现协议帧 —— 往 stdout 打日志会让客户端解析失败，
 *     而这正是 ACP 接入最容易踩的坑；
 *  2. 只有一个 stdin 分派器。多个监听器会各自维护 buffer 互相抢数据，
 *     表现为偶发丢帧，比彻底不通更难查。
 */

const fs = require('node:fs');
const path = require('node:path');

const LOG = process.env.FAKE_ACP_LOG;
const SCENARIO = process.env.FAKE_ACP_SCENARIO || 'allow';

function logEvent(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    /* 日志失败不能影响协议 */
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

/** 本 agent 主动向客户端发出、正在等待应答的请求 */
const pendingOut = new Map();
const sessions = new Map();
let nextSession = 1;
let buffer = '';

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = 100000 + Math.floor(Math.random() * 899999);
    pendingOut.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void dispatch(line);
    index = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => process.exit(0));

async function dispatch(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`[fake-agent] 收到非 JSON: ${line}\n`);
    return;
  }

  const { id, method, params, result, error } = message;

  // 客户端对我们请求的应答：id 必须在 pendingOut 里
  if (id !== undefined && pendingOut.has(id)) {
    const pending = pendingOut.get(id);
    pendingOut.delete(id);
    if (error) pending.reject(new Error(error.message ?? '未知错误'));
    else pending.resolve(result);
    return;
  }

  // 客户端发来的通知（session/cancel 等）
  if (id === undefined && method) {
    logEvent({ kind: 'notification', method, params });
    return;
  }

  // 客户端发来的请求
  try {
    if (method === 'initialize') {
      logEvent({ kind: 'initialize', params });
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
        },
      });
      return;
    }

    if (method === 'session/new') {
      const sessionId = `s${nextSession++}`;
      sessions.set(sessionId, { cwd: params?.cwd });
      logEvent({ kind: 'session/new', params, sessionId });
      send({ jsonrpc: '2.0', id, result: { sessionId } });
      return;
    }

    if (method === 'session/prompt') {
      logEvent({ kind: 'prompt', params });
      await runTurn(params);
      send({
        jsonrpc: '2.0',
        id,
        result: { stopReason: SCENARIO === 'refusal' ? 'refusal' : 'end_turn' },
      });
      return;
    }

    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现: ${method}` } });
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(err && err.message) } });
  }
}

/**
 * 一轮任务：按场景发出事件流与反向请求。
 * 刻意覆盖全部四类载荷，让断言能覆盖映射表的每一条分支。
 */
async function runTurn(params) {
  const sessionId = params?.sessionId;
  const workspace = sessions.get(sessionId)?.cwd ?? process.cwd();

  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看一下工程结构' } },
  });

  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: '读取 package.json',
      kind: 'read',
      status: 'in_progress',
    },
  });

  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'text', text: '{ "name": "demo" }' }],
    },
  });

  // 第二个工具调用刻意用 **dsh 的形状**：kind 恒为 other、工具名在 title、
  // 入参在 rawInput。客户端若只会按 kind 判风险，这里就会落到默认档。
  const target =
    SCENARIO === 'outside'
      ? path.join(path.dirname(workspace), 'OUTSIDE-NOTES.md')
      : path.join(workspace, 'AGENT-NOTES.md');

  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'write',
      kind: 'other',
      status: 'in_progress',
      rawInput: { path: target },
    },
  });

  // 权限请求：客户端必须程序化应答。工具 id 放在 toolCall 里（dsh 实测形状）
  const permission = await request('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 'tc-2' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  });
  logEvent({ kind: 'permission.result', result: permission });

  // 读文件：只读路径不该惊动用户，但要能真的取回内容
  try {
    const readResult = await request('fs/read_text_file', {
      sessionId,
      path: path.join(workspace, 'package.json'),
    });
    logEvent({ kind: 'read.result', ok: true, result: readResult });
  } catch (err) {
    logEvent({ kind: 'read.result', ok: false, error: String(err && err.message) });
  }

  // 写文件：ACP 把它交给客户端执行 —— 这里正是审批网关的落点之一。
  // 注意：真实 dsh 不走这条（它不支持客户端文件系统操作），
  // 但别的内核可能走，所以实现与断言都保留。
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  // partial 场景刻意让两处改动**相隔足够远**：挨在一起的话差异引擎会合并成一个 hunk，
  // 逐块授权就没有东西可选，测试也就验不出「只写入被采纳的那块」。
  const content =
    SCENARIO === 'partial'
      ? [
          '# 运行笔记',
          '',
          '- 已完成初步分析',
          '',
          '- 说明一',
          '- 说明二',
          '- 说明三',
          '- 说明四',
          '- 说明五',
          '- 说明六',
          '',
          '',
        ].join('\n')
      : ['# 运行笔记', '', '- 已完成初步分析', '', '- 无（本轮已收尾）', ''].join('\n');

  try {
    const writeResult = await request('fs/write_text_file', { sessionId, path: target, content });
    logEvent({ kind: 'write.result', ok: true, result: writeResult, before, target });
  } catch (err) {
    logEvent({ kind: 'write.result', ok: false, error: String(err && err.message), before, target });
  }

  // 工具结束：刻意用 dsh 的嵌套 content 包装，验证取文本时两种形状都认
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-2',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '已写入' } }],
    },
  });

  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已梳理完工程结构：' } },
  });
  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '包含三个包与一个壳。' } },
  });
}
