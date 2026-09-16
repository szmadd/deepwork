# 深边AI Work

本地优先、模型无关的桌面级通用 AI Agent 工作台。

**架构定位：** DeepSeek Harness 提供 Agent 运行时（主循环 / 工具调度 / 会话日志 / 子智能体 / MCP），Electron 提供壳与体验，两者之间由一层 `harness-adapter` 强隔离。

| 文档 | 看什么 |
|---|---|
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | **改代码前先看**：架构硬约束、分层纪律、验证基线、本机开发环境坑位 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 设计决策：界面布局、差异审阅、终端、浏览器、分叉回放、沙箱安全模型 |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | 验证与验收：自检套件清单、demo / smoke、UI 截图验收 |
| [docs/PACKAGING.md](docs/PACKAGING.md) | 打包与分发：产物、硬约束、内网部署后的模型配置 |
| [docs/REAL-HARNESS.md](docs/REAL-HARNESS.md) | 接入真实内核（dsh / ACP）的方式与协议验证 |
| [docs/REFERENCE.md](docs/REFERENCE.md) | 参考：环境变量全表、数据存放布局 |
| [docs/DEVLOG.md](docs/DEVLOG.md) | 逐次开发记录（目标 / 改动 / 验证 / 踩坑 / 遗留 / 下一步）与里程碑快照 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 后续研发规划：剩余功能清单、内核能力取证结论、每项的范围与判据 |
| [docs/SESSIONS/](docs/SESSIONS/) | 会话决策纪要：为什么这么定（翻代码看不出来的取舍） |

## 目录结构

```
deepwork/
├─ packages/
│  ├─ protocol/          三方共享的类型契约（事件流 / RPC / 会话 / 安全模型）
│  └─ core-host/         内核宿主：适配层、会话日志、审批网关、工具注册表、stdio JSON-RPC
├─ apps/
│  └─ desktop/           Electron 壳 + React 渲染层
├─ docs/                 工程约定 / 架构决策 / 验证 / 打包 / 开发日志 / 规划 / 决策纪要
├─ skills/               内置技能（SKILL.md）
└─ tools/                不依赖 GUI 的验证脚本
```

## 分层与进程模型

```
渲染进程 (React)
   │  contextBridge 白名单 API
Electron 主进程
   │  spawn + stdio NDJSON JSON-RPC
core-host 子进程  ── harness-adapter ──►  DeepSeek Harness 子进程
                                            （回环 HTTP + SSE + 一次性 token）
```

三条不可绕过的约束：

1. **Harness 不跑在 Electron 主进程内。** Electron 内置 Node 版本通常低于内核要求的 22.19+。
2. **所有内核调用只经过 `harness-adapter`。** 内核 0.1.x 接口未冻结，升级风险被限制在一个目录内。
3. **写操作必须过审批网关。** `Guard.assess()` 是不可绕过的路径，`danger` 级别直接阻断；
   真实内核下另有内核沙箱（`workspace-write` 默认）在执行时强制越界拦截。

设计细节（界面布局 / 差异审阅 / 分叉回放 / 沙箱两层模型等）见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

要求 Node.js ≥ 22.19。

```bash
npm install
npm run build        # 编译 protocol 与 core-host
npm run demo         # 不起 Electron，先验证内核链路
npm run smoke        # 不启 GUI，验证壳层 ↔ core-host 的 stdio IPC 链路
npm run dev          # 启动 Electron（Vite 开发服务器 + 桌面窗口）
```

**UI 出问题不代表内核链路出问题，先跑 demo 是最快的定位手段。**

提交前必须跑通：

```bash
npm run verify       # 全套无 GUI 自检（差异 / 写工具 / 回放 / IPC / 终端 / ACP / 技能 /
                     # 记忆 / 调度 / 连接器 / 用量 / 浏览器 / Office / 模型端点 / 沙箱等）
npm run demo
```

各套件覆盖范围与 UI 截图验收见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

### 疑难：启动即报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`

说明当前 shell 里带着 `ELECTRON_RUN_AS_NODE=1`（Electron 会退化成纯 Node 运行）。
部分开发环境（例如宿主本身跑在 Electron 上）会继承这个变量，清掉即可：

```bash
unset ELECTRON_RUN_AS_NODE
```

## 打包与分发

```bash
npm run dist          # NSIS 安装包 + 免安装 zip → release/
npm run test:package  # 验收打包产物（--launch 会真的启动应用截图）
```

产物形态、三条硬约束与内网部署说明见 [docs/PACKAGING.md](docs/PACKAGING.md)。

## 切换到真实内核

真实内核是 DeepSeek Harness（dsh），通过 ACP 接入：

```bash
npm i -g @deepseek-ai/dsh
DEEPWORK_ADAPTER=harness npm run dev
```

默认仍是 mock —— 真实内核要下载运行时并配置模型凭据，没有显式要求时静默去拉取，
会让「装好就能跑」变成碰运气。为什么是 ACP、协议正确性如何验证，见
[docs/REAL-HARNESS.md](docs/REAL-HARNESS.md)。

## 当前进度

- **M0 POC / M1 MVP**：✅ 完成（壳 + 内核链路 / 多会话 / 差异审阅 / 终端 / 审批三档 / 打包 / ACP 接入）
- **M2 V1**：✅ 收口（技能系统 + 审计、三层记忆、自动化调度、连接器管理 MCP、用量面板、
  浏览器自动化、Office 生成与 OFD 原生读取；M2-K 自动更新显式挂起——需要发布通道服务）
- **M2+ 补强**：✅ 完成（模型目录以内核真帧为准、推理档位、上下文占用、用量口径如实化、
  一体化离线安装包、内网自定义模型配置链路）
- **需求矩阵漏项**：🔶 进行中（FR-10.2 模型路由主干已落地；**FR-3.5 沙箱二期已完成**——
  内核沙箱接出到界面，真内核端到端证明越界写入被拦且拒绝在界面上说人话；
  剩 FR-3.8 图表与沙箱模式切换入口）

逐项清单与判据见 [docs/ROADMAP.md](docs/ROADMAP.md)，逐次开发记录见
[docs/DEVLOG.md](docs/DEVLOG.md)（顶部有里程碑状态快照）。

## 开发与提交

- **每次开发会话结束前必须追加一条 DEVLOG 记录**（固定六段：目标 / 改动 / 验证 / 踩坑与修复 / 遗留 / 下一步）。
- 提交信息：`feat|fix|test|docs|chore|refactor(scope): 改了什么`，正文写「为什么」。
- **换行符固定 LF**（`.gitattributes` + 仓库级 `core.autocrlf=false`）——本项目多处依赖逐字节比对，
  CRLF 转换会让回放 / 差异 / 分叉断言以「内容不一致」的形式失败而真实原因是行尾。

完整约定见 [docs/CONVENTIONS.md](docs/CONVENTIONS.md)。
