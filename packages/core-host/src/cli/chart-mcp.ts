import { startChartMcpServer } from '../chart/mcp-server';
import { createLogger } from '../logger';

/**
 * 图表能力 MCP 服务的进程入口。
 *
 * 由内核（dsh）按宿主生成的 --patch 以 stdio 方式拉起，不对外暴露端口。
 * 也可以手工运行来调试：直接往 stdin 喂一行 initialize 消息即可。
 *
 * 环境变量：
 *   DEEPWORK_WORKSPACE   工作区根目录（宿主写进补丁的 env，与内核自己的边界同值）
 *   DEEPWORK_LOG_LEVEL   debug | info | warn | error
 */

const log = createLogger('chart-mcp');

try {
  startChartMcpServer();
} catch (error) {
  // 启动失败必须是一次明确的退出，而不是留一个「活着但不响应」的进程 ——
  // 后者在客户端看来是「MCP 服务连上了但工具永远超时」，比直接失败难查得多
  log.error('图表 MCP 服务启动失败', error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
