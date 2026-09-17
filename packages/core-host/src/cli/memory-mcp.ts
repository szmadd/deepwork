import { startMemoryMcpServer } from '../memory/mcp-server';
import { createLogger } from '../logger';

/**
 * 记忆能力 MCP 服务的进程入口。
 *
 * 由内核（dsh）按宿主生成的 --patch 以 stdio 方式拉起，不对外暴露端口。
 * 也可以手工运行来调试：直接往 stdin 喂一行 initialize 消息即可。
 *
 * 环境变量：
 *   DEEPWORK_HOME        记忆文件根目录（<home>/memory），与宿主同源
 *   DEEPWORK_WORKSPACE   工作区根目录（工作区层记忆按它归属）
 *   DEEPWORK_LOG_LEVEL   debug | info | warn | error
 */

const log = createLogger('memory-mcp');

try {
  startMemoryMcpServer();
} catch (error) {
  // 启动失败必须是一次明确的退出，而不是留一个「活着但不响应」的进程 ——
  // 后者在客户端看来是「MCP 服务连上了但工具永远超时」，比直接失败难查得多
  log.error('记忆 MCP 服务启动失败', error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
