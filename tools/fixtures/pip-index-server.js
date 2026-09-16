#!/usr/bin/env node
/**
 * 假的 pip 索引服务器（§8.2 验收用）。
 *
 * 为什么需要一个**独立进程**：pip 是在 `spawnSync` 里跑的，那段时间宿主进程的
 * 事件循环被完全阻塞 —— 同进程内的 http server 根本来不及应答，pip 会超时，
 * 于是「源连不上」和「测试写错了」变成同一个现象。放进子进程就没有这个问题。
 *
 * 响应一律是**合法的空 simple 索引**（200 + 零个链接）。这样 pip 会得出
 * 「源通了，但里面没有这个包」—— 正是 `classifyPipFailure` 要区分的那个结论，
 * 而不是一句笼统的连接失败。
 *
 * 用法（由 tools/pip-test.js 调用，不手工执行）：
 *   node tools/fixtures/pip-index-server.js <请求日志文件>
 * 端口从 stdout 的 `LISTENING <port>` 行交回给父进程。
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');

const logFile = process.argv[2];
if (!logFile) {
  console.error('用法: node tools/fixtures/pip-index-server.js <请求日志文件>');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  // 记下**每一条**请求：判据就是「请求真的打到了这个源」，
  // 而这只能从服务端侧观察 —— 客户端说它用了这个源，不算证据。
  fs.appendFileSync(logFile, `${req.method} ${req.url}\n`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html><head><title>Simple Index</title></head><body></body></html>');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`LISTENING ${address.port}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
