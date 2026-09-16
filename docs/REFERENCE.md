# 参考：环境变量与数据存放

## 环境变量

### 运行时

| 变量 | 作用 | 默认 |
|---|---|---|
| `DEEPWORK_HOME` | 运行时数据目录（会话日志、配置、日志） | `~/.deepwork` |
| `DEEPWORK_WORKSPACE` | 默认工作区 | 用户主目录下的 `deepwork-workspace` |
| `DEEPWORK_ADAPTER` | `mock` / `harness` / `auto` | `auto` |
| `DEEPWORK_HARNESS_CMD` | 真实内核启动命令。设置后 auto 模式会优先尝试 | 空 |
| `DEEPWORK_HARNESS_ARGS` | 真实内核启动参数（与 `DEEPWORK_HARNESS_CMD` 搭配） | `--profile acp` |
| `DEEPWORK_NODE_BIN` | 指定跑 core-host 用的 Node 可执行文件 | 优先 PATH 上的 node |
| `DEEPWORK_SANDBOX_MODE` | 内核沙箱档位：`read-only` / `workspace-write` / `danger-full-access`（优先级高于内核自身的 `DSH_PERMISSION_MODE`，非法值回落默认并在界面留痕） | `workspace-write` |
| `DEEPWORK_SEARCH_URL` | `web.search` 工具的检索端点 | 空（未配置则明确报错，不伪造结果） |
| `DEEPWORK_BROWSER_PATH` | 指定浏览器可执行文件（不设则按 Edge / Chrome 常见路径探测） | 空 |
| `DEEPWORK_BROWSER_HEADFUL` | 置 `1` 时浏览器有界面（默认无界面，后台能力不弹窗） | 空 |
| `DEEPWORK_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `DEEPWORK_LOG_FILE` | 设置后主进程日志同时写入该文件（打包后的应用没有 stdout，报障靠它） | 空 |

### 开发与验收

| 变量 | 作用 |
|---|---|
| `DEEPWORK_DEV` | 置 `1` 表示开发模式（Electron 主进程内部使用） |
| `DEEPWORK_CAPTURE` 系列 | UI 截图验收，见 [VERIFICATION.md](VERIFICATION.md) |
| `DEEPWORK_MOCK_SANDBOX_DENIAL` | 置 `1` 时 mock 内核造一帧「被沙箱拦下」的工具结果（真帧逐字副本），用于验收界面的沙箱拒绝渲染路径 |
| `DEMO_DENY` | 置 `1` 时 demo 走拒绝审批分支 |

## 数据存放

```
~/.deepwork/
├─ config.json                       界面偏好、默认模式与模型、模型单价表、视图记忆
├─ guard.json                        审批策略与「始终允许」前缀
├─ logs/core-host.log                宿主日志（stdout 专供协议，日志一律走 stderr）
├─ runtime/kernel.patch.yml          dsh 插件补丁（连接器 + 模型端点 + 内置浏览器服务），每次拉起内核前重建
├─ browser-endpoint.json             当前浏览器实例的 pid / 端口 / wsUrl（宿主与内核侧服务据此共享单实例）
├─ browser-profile/                  浏览器专用 user-data-dir（隔离于用户日常浏览器）
├─ browser-shots/                    浏览器截图落盘处（事件日志只记文件名与大小，不记字节）
└─ sessions/<sessionId>/
   ├─ meta.json                      会话元数据
   └─ events.jsonl                   append-only 事件流（唯一事实来源）
```

会话日志只追加、不修改，因此进程崩溃后可完整重建对话与 Trajectory，也是 fork / 回放的基础。
