#!/usr/bin/env node
/**
 * 沙箱验证用的最小写入器。
 *
 * 为什么单起一个文件而不是 `cmd.exe /c echo x > f`：经 runner 的 argv 前缀包装后，
 * 引号与重定向会被再解析一次（实测 cmd 报「文件名、目录名或卷标语法不正确」，
 * 且三个用例全报同一个错 —— 看起来像「沙箱挡住了」，其实是命令本身没跑起来）。
 * 把目标路径作为独立 argv 传进来，就没有引号与重定向可以出错。
 *
 * 本文件不 spawn 任何子进程：受限令牌下「受限孙进程的管道 stdio」不可用，
 * 多一层 spawn 会引入与被测行为无关的失败。
 *
 * 用法：node sandbox-writer.js <target-path>
 */

'use strict';

const fs = require('node:fs');

const target = process.argv[2];
if (!target) {
  console.error('用法：node sandbox-writer.js <target-path>');
  process.exit(2);
}

fs.writeFileSync(target, 'probe\n', 'utf8');
