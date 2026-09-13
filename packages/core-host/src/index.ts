import path from 'node:path';
import { DeepworkHost } from './host';
import { createLogger } from './logger';
import { startStdioServer } from './rpc/stdio-server';

/**
 * core-host 入口。
 *
 * 由 Electron 主进程以子进程方式拉起；也可单独运行用于调试：
 *   DEEPWORK_WORKSPACE=D:\some\project node packages/core-host/dist/index.js
 *
 * 环境变量：
 *   DEEPWORK_HOME         运行时数据目录（默认 ~/.deepwork）
 *   DEEPWORK_WORKSPACE    默认工作区
 *   DEEPWORK_ADAPTER      mock | harness | auto（默认 auto）
 *   DEEPWORK_HARNESS_CMD  真实内核启动命令
 *   DEEPWORK_LOG_LEVEL    debug | info | warn | error
 */

const log = createLogger('main');

async function main(): Promise<void> {
  const workspace = path.resolve(process.env.DEEPWORK_WORKSPACE ?? process.cwd());
  const host = new DeepworkHost();

  /**
   * 顺序是刻意的：先建通道，再等宿主启动。
   *
   * 反过来写的话，host.start() 内部发出的 host.ready 会早于通道建立，
   * 这个事件就永久丢失了 —— 而壳层重启内核之后正是靠 host.ready 把 UI
   * 从「启动中」恢复成「就绪」，丢了它就永远卡在那里。
   *
   * 通道先开、请求排队（gate）：既不漏启动期的事件，也不会在内核还没初始化完
   * 的时候就把调用放进来。启动失败时 gate 同样放行 —— 让请求自己拿到错误响应，
   * 而不是永远挂在那里。
   */
  const starting = host.start(workspace);
  startStdioServer(host, starting.catch(() => undefined));

  const status = await starting;
  log.info(
    `宿主启动完成: adapter=${status.adapter} node=${status.nodeVersion} home=${status.home} workspace=${workspace}`,
  );
}

main().catch((error: unknown) => {
  log.error('宿主启动失败', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
