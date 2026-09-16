# 接入真实内核（DeepSeek Harness / ACP）

真实内核是 **DeepSeek Harness（dsh）**，通过 **ACP（Agent Client Protocol）** 接入：
`dsh --profile acp` 会以一个 stdio 上的 JSON-RPC 服务运行，本项目作为客户端驱动它。

```bash
# 1. 安装内核（Node ^22.19 || >=24）
npm i -g @deepseek-ai/dsh

# 2. 用真实内核启动（失败即报错，不静默降级到 mock）
DEEPWORK_ADAPTER=harness npm run dev

# 或指定自己的启动命令，例如源码构建的 dsh
DEEPWORK_HARNESS_CMD="/path/to/dsh" DEEPWORK_HARNESS_ARGS="--profile acp" DEEPWORK_ADAPTER=harness npm run dev
```

默认仍是 mock —— 不是因为契约没校准，而是真实内核要下载完整运行时并配置模型凭据，
在没有显式要求时静默去拉取，会让「装好就能跑」变成碰运气。

## 为什么是 ACP

dsh 的出口是 profile 制（`web` / `headless` / `sdk` / `sdk-minimal` / `acp`）。
`headless` 只适合「跑一个任务、打印结果、退出」；ACP 才提供本工作台需要的
会话创建、流式事件、中断与**程序化权限应答**。

关键的一点：ACP 把 `fs/write_text_file` 交给**客户端**执行。这与本项目的审批网关天然咬合 ——
内核想写文件时，差异预览、逐 hunk 取舍、越界拦截全部照常生效，
内核不会多出一条绕过 diff 审阅的旁路。

| ACP 消息 | 本项目侧 |
|---|---|
| `initialize` | 协商协议版本；声明由客户端代管文件读写 |
| `session/new`（cwd 绝对） | 会话与工作区绑定 |
| `session/prompt` | 一轮任务；附件以 `resource_link` 传路径 |
| `session/update`（通知） | 归一化事件（思考 / 消息 / 工具调用） |
| `session/request_permission` | 审批网关（映射 `allow_once` / `reject_once`） |
| `fs/read_text_file` | 直接满足，不打扰用户 |
| `fs/write_text_file` | **差异审阅 + 逐 hunk 授权 + 越界拦截** |
| `session/cancel` | 中断 |

契约来源：[ACP 官方规格](https://agentclientprotocol.com/protocol) ·
dsh 官方 bundle `@deepseek-ai/dsh-acp-app` · 本机实测 `dsh --help`。

## 协议正确性如何验证

真实 dsh 要下载运行时、要模型凭据，没法全靠 CI。两层验证相互独立：

- **`npm run test:acp`** —— 协议层。用 `tools/fixtures/fake-acp-agent.js`（按规格实现的
  最小 ACP agent）驱动完整一轮并断言。覆盖握手、事件映射、权限应答、只读、
  写入审批、逐 hunk 授权、越界拦截、中断、「不可用时不伪装成功」，以及 dsh 实测形状
  （`prompt` 键、`fs` 能力、嵌套 content、kind 恒为 other）。
- **`npm run test:real-dsh`** —— 真实内核。本地 OpenAI 兼容替身 + 真实 `dsh --profile acp`
  + 审批网关 + 真实落盘。dsh 缺席时 SKIP，不让沙箱里装不上的机器把 verify
  整条拉红。两套加起来就是「规格 + 真内核」。

`tools/real-dsh-probe.js` 是取证工具：把真实 dsh 的每一帧打出来，让任何字段
「先看一眼真帧再写代码」。dsh 的五处与文档假设不同的写法，全是被它抓出来的。
