import { startBrowserMcpServer } from '../browser/mcp-server';
import { createLogger } from '../logger';

/**
 * 浏览器能力 MCP 服务的进程入口。
 *
 * 由内核（dsh）按宿主生成的 --patch 以 stdio 方式拉起，不对外暴露端口。
 * 也可以手工运行来调试：直接往 stdin 喂一行 initialize 消息即可。
 *
 * 环境变量：
 *   DEEPWORK_HOME           运行时数据目录（必须与宿主一致，否则会各拉一个浏览器）
 *   DEEPWORK_BROWSER_PATH   指定浏览器可执行文件（非常规安装位置 / 测试）
 *   DEEPWORK_BROWSER_HEADFUL=1  弹出可见窗口（默认无界面）
 *   DEEPWORK_LOG_LEVEL      debug | info | warn | error
 */

const log = createLogger('browser-mcp');

try {
  startBrowserMcpServer();
} catch (error) {
  // 启动失败必须是一次明确的退出，而不是留一个「活着但不响应」的进程：
  // 后者在客户端看来是「MCP 服务连上了但工具永远超时」，比直接失败难查得多。
  log.error('浏览器 MCP 服务启动失败', error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
