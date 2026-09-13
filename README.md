# 深边AI Work

本地优先、模型无关的桌面级通用 AI Agent 工作台。

**架构定位：** DeepSeek Harness 提供 Agent 运行时（主循环 / 工具调度 / 会话日志 / 子智能体 / MCP），Electron 提供壳与体验，两者之间由一层 `harness-adapter` 强隔离。

完整方案见 `docs/` 与立项文档《深边AI-Work-开发需求与架构方案 v1.0》。

| 文档 | 看什么 |
|---|---|
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | **改代码前先看**：架构硬约束、分层纪律、验证基线、本机开发环境坑位 |
| [docs/DEVLOG.md](docs/DEVLOG.md) | 逐次开发记录（目标 / 改动 / 验证 / 踩坑 / 遗留 / 下一步）与里程碑快照 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 后续研发规划：剩余功能清单、内核能力取证结论、每项的范围与判据 |
| [docs/SESSIONS/](docs/SESSIONS/) | 会话决策纪要：为什么这么定（翻代码看不出来的取舍） |

---

## 目录结构

```
deepwork/
├─ packages/
│  ├─ protocol/          三方共享的类型契约（事件流 / RPC / 会话 / 安全模型）
│  └─ core-host/         内核宿主：适配层、会话日志、审批网关、工具注册表、stdio JSON-RPC
├─ apps/
│  └─ desktop/           Electron 壳 + React 渲染层
├─ docs/                 CONVENTIONS（工程约定）/ DEVLOG（开发日志）/ ROADMAP（后续规划）/ SESSIONS（决策纪要）
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
3. **写操作必须过审批网关。** `Guard.assess()` 是不可绕过的路径，`danger` 级别直接阻断。

## 界面布局

```
[活动栏] [会话列表] [主区视图]
  56px     268px        flex
```

三条布局决定，每一条都是为了解决一个具体问题：

1. **功能入口是竖排活动栏（rail），不是标题栏里的横排按钮。**
   原先「文件 / 终端 / Trajectory / 技能 / 记忆 / 自动化 / 连接器 / 设置」是标题栏里的一排
   文字按钮，问题不在难看，而在**宽度随功能数量增长** —— 加到第八个时只能换行，把标题挤成一列字。
   竖排栏宽度固定 56px，第 10 个功能与第 1 个占用同样的空间。
   图标是内联 SVG，不引图标库（多一个依赖就多一份体积与供应链面）。
2. **管理类功能是整页视图，不是居中弹窗。**
   弹窗的语义是「打断你，处理完再回来」——它适合审批。而技能 / 记忆 / 自动化 / 连接器 / 用量 / 设置
   这些页面用户是**专门去管理**的：放在弹窗里等于同时承受可用面积被压到 620px 宽，
   以及背后那些「看起来还在、其实点不到」的元素。
   于是只有审批是弹窗（`ApprovalDialog`），其余全部搬进主区。
3. **会话列表只在对话视图出现。** 管理页要把主区全部让出来，否则它们又要和会话列表争宽度 ——
   而那正是它们从弹窗里搬出来要解决的问题。

活动栏分两组：上组是「这台机器上正在发生什么」（对话 / 文件 / 终端 / 浏览器 / 轨迹），
下组是「配置与账本」（技能 / 记忆 / 自动化 / 连接器 / 用量），设置固定在底部。
对话视图与文件视图带角标（待审批数、本次会话改动的文件数）——角标回答的是「为什么卡住了」。

### 用量面板

数据来自**既有会话存储**（`meta.usage` 与日志里的 `usage` 事件），不另存一份「用量表」：
同一件事有两个事实来源必然漂移，而漂移时没有任何一方是权威。面板因此每次现算。

- **按日 / 按模型 / 按会话三个维度同时在场**，各自的合计必须与总数逐项相等 ——
  这是测试里那条最硬的等式（分组之和 ≠ 总数说明有样本没被归进去，而用户在界面上看不出来）。
- **模型归属按 `run.started.model`**，不按会话当前模型：一个会话可以中途换模型，
  用后者会把换模型之前的用量算到新模型头上 —— 而那正是用量面板最该答对的题。
- **费用有两个口径**：`costCny` 是内核上报的实际花费（本地模型恒 0，这是真的不是缺失），
  `estimatedCostCny` 是拿 config 里的单价表按 token 重算。单价表不写进代码：价格会变，
  写死的价格表会以「看起来很精确的数字」腐烂掉；单价缺失时显示**未定价**而不是 0 ——
  0 会被读成「免费」，那是把「不知道」伪装成「知道」。

## 写操作与差异审阅

Agent 能改代码之后，「改动」本身就是最需要用户看见的东西。
因此写类工具（`fs.write` / `fs.edit`）共用同一套流程，每一步都不可跳过：

1. **预检** —— 读旧内容、算出新内容、生成结构化差异，**不落盘**；
2. **共享快照** —— 预检结果存进 `ctx.cache`，执行阶段复用同一次读取。
   两趟各自读文件不仅多一次 IO，更糟的是两趟之间文件可能被改动，
   让「用户看到的差异」和「实际写下去的内容」分叉 —— 那是审批链路最不能接受的失效模式；
3. **提前预览** —— 差异在 `tool.started` **之前**就算好，工具卡片在「执行中」阶段就能显示改动，
   而不是等文件已经落盘了再补一份差异；
4. **看过才授权** —— 差异随 `approval.requested` 送到审批弹窗。
   批准一个写操作的语义是「我读过这份差异了」，让用户对着一个路径点允许是没有意义的；
5. **落盘** —— 授权通过才写入。无变化的写入会在第 1 步后直接短路，不打扰用户。

差异不是一段 unified diff 字符串，而是结构化 hunk（`DiffLine` / `DiffHunk` / `FileDiff`）。
字符串会逼着 UI 再解析一次（转义、行号都要重算）；结构化数据既能渲染，也能直接算增删统计，回放时同样稳定。

三道防线保证差异本身可信：

- **剥公共前后缀**后再进 Myers 主循环 —— 局部编辑场景下输入极小，通常微秒级；
- **规模阈值** —— 剩余规模过大时退化为整体替换，不做精细 diff，不卡住宿主；
- **结果自检** —— 产物必须能把旧文还原成新文，否则退化为整体替换。
  宁可给出「整文件重写」这种粗糙但正确的差异，也不能让用户看到一份错的改动预览。

`npm run test:diff` 用极小字母表（刻意制造大量重复行）随机对拍，专打这类算法的软肋。

### 逐块取舍

一份差异可能包含多处互不相邻的改动，而它们的风险并不相同 ——
把「改注释」和「改配置默认值」绑在一起要求用户一次点头，等于逼用户要么全接受、要么全放弃。

因此在满足三个条件时，审批弹窗会把差异拆成可逐个勾选的 hunk：
**改动不止一处、不是新建文件、差异没有被截断**。此时：

- 默认全选，不改变原有的操作习惯；
- 未勾选的块**灰显但完整保留** —— 不显示就等于用户无法判断自己拒掉的是什么；
- 统计给两个数：整体改了多少、本次实际会写入多少，按钮措辞也随之变成「只应用选中的 N 处」；
- 空勾选 = 放弃本次写入，而不是含糊的「全都不要」；
- 决议如实写进日志的 `approval.resolved.hunks`，回放时能看到当初采纳了哪几块。

落盘走 `applySelectedHunks`，并保留原文件的行尾风格。这不是洁癖：
`applySelectedHunks(old, diff, [])` 必须与原文**逐字节相同**，否则「空勾选」会变成一次静默改写。

`npm run test:partial` 断言的是最硬的那条等式 ——
**磁盘上的内容 == 用「勾选的那一块」对写入前原文做部分应用的结果**，
两侧独立算出，并额外断言它与整体授权的结果不同；没有这条反向断言，
一个「把 hunks 丢掉、默默整体写入」的实现也能让前面所有断言通过。

## 内置终端

终端视图（活动栏 → 终端）是**命令台**，不是 PTY：用 `spawn(command, { shell })` 执行，输出实时回传，
`terminal.write` 把输入送回 stdin，`cd` 会推进该会话的工作目录。

不采用 PTY 的原因很实际：`node-pty` 是原生模块，要跟着 Electron 的 ABI 编译，
会让「装完就能跑」变成一句空话。代价是不支持全屏交互程序（vim / top），
这一点直接写在面板顶部，而不是等用户敲了 vim 再卡住。

终端输出**不进事件日志**：它是高频且无界的，写进 append-only 日志会拖垮回放与分叉，
也会让「日志是忠实记录」这句话失去意义。因此终端走独立通知通道，并按会话隔离 ——
一个会话对应一个 cwd 与一份命令历史，「切到某个项目的会话」与「在那个目录下敲命令」是同一件事。

Windows 下的中文输出是个坑：cmd 内建命令走 GBK，`node` / `git` 走 UTF-8，同一段输出里可能混着两种。
解码器先按 UTF-8 流式解，一旦出现替换字符 `U+FFFD` 就整段退回 GBK 重解。

## 浏览器自动化

浏览器视图（活动栏 → 浏览器）用 **CDP（Chrome DevTools Protocol）** 驱动系统里已装的
Chrome / Edge。不引 Playwright / Puppeteer —— 那会拖上几百 MB 的浏览器二进制，
「装完就能跑」立刻作废；Node 22 内置了全局 `WebSocket`，驱动 CDP 够了。

模型侧对外提供六个动作：`navigate` / `content` / `click` / `type` / `evaluate` / `screenshot`
（`evaluate` 是 danger 档，其余 confirm 档，都要过审批）。**面板上的「打开 / 刷新 / 关闭」
是用户自己的动作，因此不弹确认；模型的六个动作每次都弹** —— 两条入口的授权语义不同，
绝不能把模型能调的动作放进「用户自己点」的白名单里，那等于开了一条绕过审批的旁路。

几个绕不开的决定：

- **必须带 `--user-data-dir=<home>/browser-profile`。** 新版 Chrome/Edge 对**默认 profile 禁止
  远程调试**（连 `DevTools listening` 那行都不给）；用专用 profile 也就不碰用户日常浏览器的
  标签页与登录态 ——「借用系统浏览器」不等于「接管你正在用的浏览器」。
- **端口从 stderr 解析**：`--remote-debugging-port=0` 让浏览器自己选一个空闲端口，再从
  `DevTools listening on ws://…` 那行里把端口读出来。写死端口会在端口被占时静默失败。
- **单实例，靠 endpoint 文件共享。** 宿主进程与内核侧的 MCP 服务是两个进程 —— 如果各自拉一个
  浏览器，用户会看到两个窗口、截图也来自两个页面。约定一份 `browser-endpoint.json`
  （pid / port / wsUrl / executable / startedAt）：**先读文件并探测那个 pid 还活着没，
  活着就复用、死了才重新拉起。** 借用方「关闭」只断开自己，只有拉起方才能杀进程树。
- **截图落盘记路径，字节不进事件日志。** 与终端输出同一条纪律：PNG 是高频且无界的大字节，
  写进 append-only 日志会拖垮回放与分叉。面板按路径读图，日志里只留文件名与大小。
- **宿主停用杀浏览器进程树**，不留孤儿进程。

模型侧看到的工具名是 `browser_navigate` 这类**下划线**形式，不是 `browser.navigate`：
模型 API 对 function name 有 `^[a-zA-Z0-9_-]{1,64}$` 的限制，点号不合法。
下划线形式还顺带不和用户的连接器工具名（`mcp__<name>__<tool>`）撞车，也不占用连接器名空间。

## 文件树、预览与附件

- **文件树**只读列举工作区，忽略 `node_modules` / `dist` / `.deepwork` 等；
  因深度上限未继续展开的目录会被明确标记，而不是安静地显示成空目录。
- **变更高亮**来自本次会话的工具差异，而不是重新 diff 磁盘 ——
  高亮必须指向「这次到底动了什么」，重新 diff 出来的结果无法回答这个问题。
- **预览弹窗**把「文件不存在」与「存在但读不出」分成两个字段表示；读不出时说明原因，
  而不是把一份读不到的文件显示成一个空文件。
- **附件**只有用户在对话框里亲手选过的路径才会进入 Electron 主进程的白名单，
  白名单外的路径一律拒绝读取。渲染层传来的路径是**请求**，不是权限。

## 会话分叉与回放

会话日志只追加、不修改，这件事被用在了两个地方。

**回放。** `@deepwork/protocol` 的 `reduce.ts` 负责把事件流归约成对话时间线。
它住在契约层而不是渲染层，因为「一串事件意味着什么」是契约语义：内核、壳层、UI 必须对同一份
日志得出同样的结论 —— 否则回放只是另一套渲染逻辑，证明不了任何事。因此它必须是纯函数：
无 IO、无时钟、无随机。

`npm run test:replay` 把这件事变成断言：同一份日志归约两次结果相同、回放结果与当初实时渲染的
结果逐项相同、**落盘行与推送给壳层的那条事件逐字节相同**。

**分叉。** 在某一轮结束处点「在此分支」，得到一条继承了那段历史、可独立走下去的新会话。
三条不可动摇的规则：

1. **继承段是字节级复制。** 新会话日志的前 N 行与父会话前 N 行逐字节相同，
   于是「这段历史继承自那里」是可核验的，而不是靠字段比对去猜。
   日志形状固定为 `[父会话前 N 行的复制…][session.forked]`，分叉标记必须在末尾 ——
   先写标记再铺历史，前缀等式立刻失效。
2. **分叉点吸附到运行边界。** 落在半轮里的位置会退到该轮之前：半轮日志停在悬空的
   `tool.started` 或半截流式消息上，那种状态没法继续往下跑。原始请求位置仍如实保留在
   `from.requestedSeq` 里，不静默改写用户的选择。
3. **上下文与用量一起继承。** 被继承的上下文对模型而言真实存在，成本面板若在分叉处凭空掉一截，
   后续的用量判断就会失准。

历史是**复制而非引用**：删掉父会话，分支照样能完整回放。

## 快速开始

要求 Node.js ≥ 22.19。

```bash
npm install
npm run build        # 编译 protocol 与 core-host
npm run demo         # 不起 Electron，先验证内核链路
npm run smoke        # 不启 GUI，验证壳层 ↔ core-host 的 stdio IPC 链路
npm run dev          # 启动 Electron（Vite 开发服务器 + 桌面窗口）
```

`npm run demo` 会在临时目录里造一个示例工程，跑完「会话 → 工具调用 → 审批 → 事件落盘」全链路，
并校验日志完整性、事件序号连续性，以及**差异链路** —— 由预览差异还原出的内容必须与磁盘实际内容逐行相同。
**UI 出问题不代表内核链路出问题，先跑 demo 是最快的定位手段。**

`npm run smoke` 加载的是 Electron 主进程使用的那份 `core-host-client`，覆盖子进程解析、
NDJSON 分帧、请求响应配对、事件推送、审批回环、退出清理、配置读写往返，以及差异跨进程序列化后是否仍然完整，共 26 项断言。

另有一组不依赖 GUI 的自检，`npm run verify` 会依次跑完：

| 命令 | 覆盖内容 |
|---|---|
| `npm run test:diff` | 差异引擎随机对拍（默认 1000 轮，`DIFF_ROUNDS=20000` 可加压）；含部分应用的三条等式与 CRLF 保真 |
| `npm run test:tools` | 写工具的边界与错误信息可行动性：越界、匹配不唯一、无变化短路、拒绝后不落盘、逐 hunk 授权 |
| `npm run test:replay` | 回放确定性、日志与推送逐字节一致、分叉的字节级前缀、分叉点吸附、分支续跑 |
| `npm run smoke` | 壳层 ↔ 宿主的 stdio IPC 与差异跨进程完整性 |
| `npm run test:partial` | 逐 hunk 授权的端到端链路：从弹窗勾选到磁盘字节，并与整体授权结果反向对拍 |
| `npm run test:terminal` | 终端链路：执行 / 退出码 / stderr 分流 / `cd` 推进 / 中断 / 并发上限，以及「终端不进事件日志」 |
| `npm run test:acp` | ACP 契约一致性：用参考 agent 驱动完整一轮，覆盖握手、事件映射、权限应答、内核写入的审批与逐 hunk 授权、越界拦截、中断、dsh 实测形状（prompt 键、能力键、嵌套 content） |
| `npm run test:real-dsh` | 真实 dsh 端到端：本地 OpenAI 兼容替身 + 真实 `dsh --profile acp` + 审批网关 + 真实落盘；dsh 缺席时优雅 SKIP |
| `npm run test:skills` | 技能系统：清单解析 8 项（合法 + 6 种拒绝形状）/ 审计 16 项（四类规则 + 组合升级 + localhost 例外）/ 安装闸门 27 项（**「critical 源未进入家目录」是核心断言，验证先审后拷**）/ RPC 接线 6 项 |
| `npm run test:skillctx` | 技能上下文注入：摘要注入与 `/` 显式调用、截断如实标记、损坏技能跳过；host 链路上 `skill.attached` 事件的形状/次序/归属、`user.message` 原文不被改写、停用后下一轮立即不再挂载 |
| `npm run test:memory` | 三层记忆：三层增删读、预算超限拒绝（可行动错误信息）、画像伪条目读写、每日日志 append-only、30 天惰性归档（utimesSync 构造）；注入文本三层分节与截断标记；host 链路上 `memory.attached` 先于 `run.started` 且 runId 一致、run 结束当日日志多一行；5 个 `memory.*` RPC 注册可用 |
| `npm run test:schedule` | 自动化调度：`nextFire` 纯函数密测（once 过期、当日已过点、每周多日组合、月末溢出落到当月最后一天、interval 对齐）；store 持久化与启停重算；引擎注入 tick/时钟真实等到触发（once 触发后自动停用、runNow 不改计划、启动过期清扫不补跑）；host 链路上 `schedule.fired` 先于 `run.started` 且 runId 归属正确、run 结局写回任务、复用绑定会话；5 个 `schedule.*` RPC 注册可用 |
| `npm run test:connectors` | 连接器管理（MCP）：补丁纯函数与 dsh-mcp-client 源码取证形状对拍（insert 条目 / config 键集合）、停用排除、空清单返回 null、YAML 序列化；store 增删启停持久化与名称校验；host 链路上 `connectors.*` 四个 RPC 注册可用、`kernel.restart` 真实完成适配器重启、补丁文件只在有启用连接器时生成；`mcp__` 前缀工具名的风险分级（confirm 起步，shell/exec 语义升 danger） |
| `npm run test:usage` | 用量聚合：纯函数层（**分组之和 = 总数**、按日升序、按 token 降序、日切注入、未定价返回 null 而非 0、坏单价清洗含 `null` 不被当成 0）；宿主层（真实 `events.jsonl` 现算、换模型的会话按 run 归属、`setConfig` 坏值不落盘）；RPC 接线 |
| `npm run test:browser` | 浏览器自动化（M2-H 起新增）：内置 MCP 补丁条目形状与入口文件真实存在、六个动作的 CDP 报文、真实 Edge 驱动 fixture 页面（导航 / 读文本 / 点击 / 输入 / 求值 / 截图 PNG magic bytes）、`evaluate` 落 danger 档、审批链（拒绝即不执行）、跨进程单实例复用与「借用人不越权杀进程」、MCP 协议端到端、进程清理；系统无浏览器时优雅 SKIP |
| `npm run test:office` | Office 生成与文档读取（M2-I 起新增）：零依赖 zip 编解码（CRC32 校验、zip-bomb 上限、固定时间戳可复现）、docx 8 个必备部件与 Markdown 子集（标题/列表/引用/代码/表格）、xlsx 共享字符串与冻结表头、`office.read` 对 docx/xlsx/ofd/纯文本四类的分发与体积上限；**OFD 原生读取**按坐标排序（Y 聚行 → 行内 X 升序 → 中英混排拼接）而非 XML 顺序；审批链（二进制输出走「文本视图」预览、拒绝即不落盘、预览与落盘同源）；另起 **Python 进程做独立实现校验**（`zipfile` + `ElementTree` 复核 CRC / XML 良构 / Content_Types / rels 目标），OFD 样本由 Python 侧生成 |
| `npm run test:modelcfg` | 模型配置：端点覆盖补丁形状与 YAML 序列化、凭据 refs 合并（不丢其它键）、secrets 按模式分存、apiKey RPC 只回掩码；host 链路上配置写入即出补丁文件、custom 会话默认端点模型；真实 dsh 端到端断言**自定义模型名真的到达端点**（连跑两轮防 settings.yaml 竞态回归） |
| `npm run test:real-dsh-mcp` | 真实 dsh + 真实 MCP server 端到端：`--patch` 叠加连接器补丁 → dsh-mcp-client 拉起 fixture MCP server → 工具注册为 `mcp__fake__echo` → 模型替身精确名调用 → 回显经 ACP 事件流带回；dsh 缺席时优雅 SKIP |

演示拒绝审批分支：

```bash
env DEMO_DENY=1 npm run demo   # Windows cmd: set DEMO_DENY=1 && npm run demo
                               # 注意：本机 Git Bash 里 `DEMO_DENY=1 npm run demo` 前缀形式
                               # 会把变量丢在 npm 启动链上（见 docs/CONVENTIONS.md 坑位表）
```

### 疑难：启动即报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`

说明当前 shell 里带着 `ELECTRON_RUN_AS_NODE=1`（Electron 会退化成纯 Node 运行）。
部分开发环境（例如宿主本身跑在 Electron 上）会继承这个变量，清掉即可：

```bash
unset ELECTRON_RUN_AS_NODE
```

### UI 截图验收

不想手动开窗口时，可以让应用启动后自动跑一轮任务并截屏退出：

```bash
DEEPWORK_CAPTURE=artifacts/ui.png \
DEEPWORK_CAPTURE_PROMPT="看一下这个工程的结构" \
npx electron apps/desktop
```

各里程碑的验收截图用 `tools/capture.sh` 批量生成，它比手敲命令多做了两件事：
**每场截图前重置 fixture**，以及**把路径转成原生 Windows 形式**（见下表）：

```bash
bash tools/capture.sh                  # 全部 13 场：chat / tree / terminal / preview / hunk / settings / skills / memory / schedule / connectors / usage / browser / office
bash tools/capture.sh preview hunk     # 只跑指定场景
```

> `office` 场景依赖系统里真的装了 WPS / Office：它先用真实生成器写出 `report.docx` / `budget.xlsx`，
> 再用**真实办公软件打开它们**并按**窗口标题**截取该文档窗口（不抓整屏，避免拍到别人家的界面）。
> 系统没有办公软件时明确跳过并出声 —— 产出一张「打开了空桌面」的图，等于把「没验证」伪装成「验证过了」。

| 变量 | 作用 |
|---|---|
| `DEEPWORK_CAPTURE` | 截图输出路径，设置后窗口不显示、截完自动退出 |
| `DEEPWORK_CAPTURE_PROMPT` | 截屏前先跑一轮真实任务，让画面里有对话与工具卡片 |
| `DEEPWORK_CAPTURE_DELAY` | 窗口加载完成后等待多久再截（毫秒，默认 7000） |
| `DEEPWORK_CAPTURE_APPROVE_DELAY` | 审批自动放行的延迟；调大可把审批弹窗留在画面上 |
| `DEEPWORK_CAPTURE_HOLD_PARTIAL` | 置 `1` 时留住所逐块授权的弹窗不应答，用于验收逐 hunk 界面 |
| `DEEPWORK_CAPTURE_SCRIPT` | 截图前在渲染层执行的一段脚本（视图入口在活动栏，需要它点开）。跑完即弃，不落盘 |
| `DEEPWORK_CAPTURE_FOCUS` | 截屏前滚到该 CSS 选择器的**最后一个**匹配元素（如 `.diff-view`）。会话一长视口就停在末尾，不指定的话能证明问题的元素往往在画面外 |

两个容易踩的坑，脚本里已经处理：

- **native 程序只认 `D:/...` 路径。** Electron 是原生 Windows 程序，传 `/d/...` 时它既不报错也不截图，
  只是安静地什么都不做 —— 而这一类失败恰恰是「看起来成功了」的最坏形态。
- **复用上一次运行的痕迹会让画面不可复现。** 演示脚本是「新建 → 精确替换 → 补全」三步，
  第二步要求文件里还存在 `待复核` 那一行；不重置的话第二场必然在第二步失败，画面就和第一场不同了。
  会话数据同理：留着上一次的运行记录，从图上分不出哪一段是这次代码跑出来的。


## 打包与分发

```bash
npm run dist          # NSIS 安装包 + 免安装 zip → release/
npm run dist:dir      # 只出免安装目录 release/win-unpacked（快，日常验收用）
npm run test:package  # 验收打包产物（加 --launch 会真的启动应用截图）
```

产物（版本号随 package.json）：

| 文件 | 说明 |
|---|---|
| `release/DeepWork-<版本>-setup.exe` | NSIS 安装包，可选安装目录、创建快捷方式 |
| `release/DeepWork-<版本>-win-x64.zip` | 免安装包，解压即用 |
| `release/win-unpacked/` | 免安装目录，`DeepWork.exe` 双击即跑 |

国内网络需要两个镜像（下载 Electron 二进制与 NSIS）：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

### 打包形态的三条硬约束

配置里的每个非常规决定都来自架构约束，不是偏好：

1. **内核在 asar 之外**（`resources/core-host/`）。asar 是 Electron 私有归档格式，
   只有 Electron 自带的 fs 补丁读得了；内核是独立 node 子进程，优先用外部 Node 22.19+，
   塞进 asar 等于堵死这条路。
2. **手工摆出 `core-host/node_modules/@deepwork/protocol`**。protocol 是 workspace 包，
   打包后没有软链可解析，`require('@deepwork/protocol')` 会静默失败 —— 所以用
   extraResources 把它落到内核旁边，保持 require 语义不变。
3. **electron 版本钉成精确值**（`"44.3.0"`，无 `^`）。electron-builder 需要确定版本
   才能下载对应平台的二进制，版本范围直接报错。

### 打包产物的验收

`npm run test:package` 不满足于「文件存在」，它真的把产物里的内核用外部 node 拉起来、
发一次 RPC 等它回话；`--launch` 再进一步，启动打包后的 `DeepWork.exe` 跑一轮真实任务并截图：

```bash
node tools/package-verify.js            # 结构 5 项 + 内核 3 项
node tools/package-verify.js --launch   # + 启动应用截图（artifacts/packaged-app.png）
```

### 打包相关的两个坑

- **`ELECTRON_RUN_AS_NODE=1` 会让打包后的应用「双击没反应」。** Electron 把它解释为
  「以纯 Node 模式运行」：进程启动即退出、不建窗口、不留日志。开发机上这个变量很常见
  （比如有些宿主环境会带着它）。验收脚本在启动 exe 前会清掉它；
  `package-verify.js --launch` 就是防这类回归的哨兵。
- **GUI 子系统的应用没有 stdout。** 打包后的应用出问题时用户只能描述「打不开」，
  所以加了 `DEEPWORK_LOG_FILE`：设置后主进程日志落盘，报障时有据可查。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DEEPWORK_HOME` | 运行时数据目录（会话日志、配置、日志） | `~/.deepwork` |
| `DEEPWORK_WORKSPACE` | 默认工作区 | 用户主目录下的 `deepwork-workspace` |
| `DEEPWORK_ADAPTER` | `mock` / `harness` / `auto` | `auto` |
| `DEEPWORK_HARNESS_CMD` | 真实内核启动命令。设置后 auto 模式会优先尝试 | 空 |
| `DEEPWORK_HARNESS_PORT` | 内核未上报握手端口时的兜底回环端口 | 空 |
| `DEEPWORK_NODE_BIN` | 指定跑 core-host 用的 Node 可执行文件 | 优先 PATH 上的 node |
| `DEEPWORK_SEARCH_URL` | `web.search` 工具的检索端点 | 空（未配置则明确报错，不伪造结果） |
| `DEEPWORK_BROWSER_PATH` | 指定浏览器可执行文件（不设则按 Edge / Chrome 常见路径探测） | 空 |
| `DEEPWORK_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `DEEPWORK_LOG_FILE` | 设置后主进程日志同时写入该文件（打包后的应用没有 stdout，报障靠它） | 空 |

## 开发日志

**每次开发会话结束前必须追加一条记录**，见 [`docs/DEVLOG.md`](docs/DEVLOG.md)。

日志按固定六段写：**目标 / 改动 / 验证 / 踩坑与修复 / 遗留 / 下一步**。其中两段不许敷衍：

- **验证**必须写命令与真实结果（通过项数），不能写「应该没问题」；
- **踩坑与修复**是这份日志最值钱的部分——只记结论不记过程，下次一定重踩。

文件顶部另有「里程碑状态快照」表，每轮更新，用来一眼回答「做到哪了」。

## 版本管理

仓库用 Git 管理，`main` 为长期分支。

**提交前必须跑通验证**，否则基线的绿就失去意义：

```bash
npm run verify     # 全套 18 组无 GUI 自检（差异对拍 / 写工具守卫 / 回放 / IPC 冒烟 / 逐块授权 /
                   # 终端 / ACP 契约 / 真实 dsh / 技能 / 技能注入 / 记忆 / 调度 / 连接器 / 用量 /
                   # 浏览器 / 办公文档 / 模型端点 / 真实 dsh+MCP）
                   # 注：末位「真实 dsh+MCP」在本机因环境性原因 3/8 失败（见 docs/CONVENTIONS.md）；
                   # 排在最后是为了不遮蔽前面的套件 —— 排中间时它的非零退出会中断 && 链，
                   # 其后的套件（如模型端点）会静默不跑（M2-H 轮发现并修正）。
npm run demo       # 内核链路与差异还原一致性
```

**提交信息**：首行用类型前缀 + 一句「改了什么」，正文写「为什么」。类型用
`feat` / `fix` / `test` / `docs` / `chore` / `refactor`，作用域用包名或模块名：

```
feat(core-host): 内核宿主、适配层与审批网关
test: 差异对拍、写工具守卫、IPC 冒烟与回放验证
docs: 工程说明、开发日志与内置技能
```

**换行符固定为 LF**（见 `.gitattributes`）。这不是洁癖：本项目多处依赖逐字节比对 ——
会话日志回放断言、差异还原自检、分叉的字节级前缀等式 —— 一旦发生 CRLF 转换，
这些断言会以「内容不一致」的形式失败，而真实原因是行尾被改过，极难定位。
仓库级 `core.autocrlf=false` 已设定，克隆后无需额外配置。

**不入库的内容**：`node_modules/`、构建产物 `dist/`、本地运行时数据 `.deepwork/`、
以及 `artifacts/` 下的调试产物。唯一例外是各里程碑的验收截图（`artifacts/ui-*.png` 等），
它们由 `git add -f` 显式纳入，因为开发日志的「验证」段引用了它们；
它们随时可用 `DEEPWORK_CAPTURE` 重新生成，因此不随代码变更自动跟踪。

## 当前进度

### M0 POC（已完成）

- [x] 类型契约包：归一化事件流、RPC 契约、会话模型、审批模型、文件差异模型
- [x] 内核宿主：会话存储（append-only JSONL）、审批网关、工具注册表、stdio JSON-RPC、差异引擎
- [x] 适配层：`HarnessAdapter` 抽象 + Mock 实现（真实驱动工具）+ Harness sidecar 骨架
- [x] Electron 壳：进程托管、崩溃退避重启、方法白名单、事件转发、目录选择
- [x] 渲染层：会话管理、流式对话、工具卡片、思考过程折叠、审批弹窗、Trajectory 视图
- [x] 端到端 demo 脚本 + 三个无 GUI 自检（差异对拍 / 工具守卫 / IPC 冒烟）

### M1 MVP（已完成）

- [x] 写操作闭环：`fs.edit`（精确替换 + 唯一性守卫）、`fs.write` 差异预览
- [x] 差异审阅：工具卡片与审批弹窗内的结构化差异展示、增删统计
- [x] 工作区绑定（会话创建时确定根目录，越界写入被拒绝）
- [x] 命令审批三档（白名单放行 / 危险强制弹窗 / 全手动）+ 「始终允许」前缀记忆
- [x] 模型管理与模式切换（Standard / PTC / Minimal / Creative）
- [x] Trajectory 时间线基础视图
- [x] 多会话：新建 / 切换 / 删除 / 搜索 / 重命名 / 分叉（带来源标记）
- [x] 会话 fork 与回放：字节级继承、分叉点吸附、事件流确定性归约
- [x] 逐 hunk 接受 / 拒绝（灰显未采纳块、空勾选 = 放弃、决议入日志）
- [x] 文件树 + 本次会话变更高亮 + 只读预览弹窗
- [x] 内置终端（命令台模式：流式输出、stdin 回送、按会话隔离 cwd）
- [x] 文件上传与预览（附件白名单，白名单外一律拒绝）
- [x] 设置持久化（`config.json` 偏好 + `guard.json` 审批策略，两份分开落盘）
- [x] electron-builder 打包（NSIS 安装包 + 免安装 zip，产物可启动、可跑任务，见「打包与分发」）
- [x] **接入真实内核**：按 ACP 规格重写适配层（`dsh --profile acp`），协议正确性由 32 项一致性断言守住

> 自动更新未做，归入 M2（需要发布通道与版本清单服务，单独评估）。
>
> 内核默认仍跑 mock：契约已校准，但真实 dsh 需自行安装并配置模型凭据，
> 用 `DEEPWORK_ADAPTER=harness` 启用（见「切换到真实内核」）。

### M2 V1（部分完成 · 约 90%）

- ✅ **技能系统 + 安装前审计**：目录布局 `~/.deepwork/skills/<name>/` + 清单 `~/.deepwork/skills.json`；四类审计规则（破坏性命令 / 远程代码执行 / 凭据外泄 / 隐藏载荷）+ 组合升级；critical 拒绝安装，warn 永久留档在记录里；RPC 暴露 `skills.list/install/uninstall/audit/toggle`
- ✅ **技能消费与 UI**：每轮运行按启用清单构建技能上下文（摘要注入 + `/技能名` 显式调用注入全文，超限如实截断），`skill.attached` 事件进日志、对话流显示挂载提示；技能面板支持安装向导（先干跑审计看报告、确认后才装）、启停、卸载、审计留档展开
- ✅ **三层记忆**：画像（本地纯文本，只读注入，云同步属 M3）/ 用户级记忆（显式写入，4000 字符预算超限拒绝）/ 工作区记忆（精选笔记 + 每日 append-only 运行日志，超 30 天按月机械归档）；每轮构建记忆上下文注入内核（记忆块在技能块与用户输入之前），`memory.attached` 事件带 runId 进日志；记忆面板三层页签：画像编辑、条目增删、entries/chars/budget 用量与剩余预算提示
- ✅ **自动化调度**：一次性与周期性（每天 / 每周多日组合 / 每月 / 间隔分钟），任务（自然语言提示词）与调度（时间参数）解耦；触发派生真实 run，走正常的技能/记忆注入与审批网关（自动任务不享有特权），`schedule.fired` 事件带 runId 进日志；触发会话复用绑定、不存在则以「⏰ 标题」新建；错过不补跑（启动时过期清扫），**调度只在应用运行期间生效**；自动化面板含人类可读描述（「每周一三五 09:00」）、下次触发、上次状态、启停 / 删除 / 立即运行
- ✅ **连接器管理（MCP）**：DeepWork 管清单（`~/.deepwork/connectors.json`）与 UI，连接/发现/重连/工具注册由内核自带的 `@deepseek-ai/dsh-mcp-client` 托管（不重复实现 MCP 客户端）；启用的连接器在内核（重）启动时经 `--patch` 叠加成 dsh 插件，工具以 `mcp__<名称>__<工具>` 进入内核工具列表（本轮仅 stdio 传输）；清单变更经 `kernel.restart` 生效；连接器面板含名称/命令/参数/环境变量表单、启停/删除、「重启内核生效」醒目提示与重启按钮，mock 内核下如实标注不生效
- ✅ **用量面板**：跨会话只读聚合（不新建存储，每次从既有会话存储现算）——按日 / 按模型 / 按会话
  三个维度，各自的合计与总数逐项相等（`test:usage` 守这条等式）；模型归属按 `run.started.model`
  而非会话当前模型；费用双口径（内核上报 vs 按单价估算），单价表放 config（价格会变，硬编码即腐烂），
  未定价模型显示「未定价」而不是 0；面板可点击会话直接跳过去
- ✅ **浏览器自动化（M2-H）**：CDP 驱动系统 Chrome / Edge（不引 Playwright / Puppeteer，Node 22 内置
  WebSocket 够用）；六个 `browser.*` 动作（`evaluate` 为 danger 档，其余 confirm）以内置 MCP 服务
  暴露给真实内核（工具名 `browser_navigate` 等下划线形式，绕开模型 API 的 function-name 限制）；
  宿主与内核侧服务经 `browser-endpoint.json` 共享同一个浏览器实例（借用方只断开、拉起方杀进程树）；
  专用 `--user-data-dir` profile（不碰用户日常浏览器数据）；截图落盘记路径、字节不进事件日志；
  面板含状态 / 地址栏 / 当前页 / 截图网格 / 工具与风险档位表，`test:browser` 76 项进 verify
- ✅ **Office 生成与 OFD 原生读取（M2-I）**：`office.docx` / `office.xlsx` 两个写工具（confirm 档，
  落盘工作区）+ `office.read` 读工具（safe 档，认 docx / xlsx / **ofd** / 纯文本四类）。
  **零第三方依赖**：docx / xlsx / ofd 本质都是 zip + xml，zip 由 `office/zip.ts` 手写
  （local header / central directory / EOCD + CRC32），deflate 借 Node 内置 `node:zlib`，
  固定 DOS 时间戳保证同一输入产出同一字节。二进制输出拿不出文本 diff，于是**预览与执行共享同一份
  ctx 快照**，把包内文字抽出来当预览 —— 授权时看到的那段文字就是落盘文件里真正能读出来的那段。
  **OFD 是国标（GB/T 33190-2016）**，读的时候不能按 XML 顺序拼，要按坐标排（Y 聚行 → 行内 X 升序 →
  中英混排拼接，CJK 之间不加空格），`Annot` 批注一律排除；`test:office` **130 项**进 verify，
  含一条用 Python（`zipfile` + `ElementTree`）做的**独立实现校验**，
  以及「真实 WPS 打开生成的文档」的验收截图 `artifacts/ui-office.png` / `ui-office-sheet.png`
- ⬜ MCP HTTP 传输、自动更新（M2-K）

## 切换到真实内核

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

### 为什么是 ACP

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

### 协议正确性如何验证

真实 dsh 要下载运行时、要模型凭据，没法全靠 CI。两层验证相互独立：

- **`npm run test:acp`** —— 协议层。用 `tools/fixtures/fake-acp-agent.js`（按规格实现的
  最小 ACP agent）驱动完整一轮并断言 37 项。覆盖握手、事件映射、权限应答、只读、
  写入审批、逐 hunk 授权、越界拦截、中断、「不可用时不伪装成功」，以及 dsh 实测形状
  （`prompt` 键、`fs` 能力、嵌套 content、kind 恒为 other）。
- **`npm run test:real-dsh`** —— 真实内核。本地 OpenAI 兼容替身 + 真实 `dsh --profile acp`
  + 审批网关 + 真实落盘，断言 15 项。dsh 缺席时 SKIP，不让沙箱里装不上的机器把 verify
  整条拉红。两套加起来就是「规格 + 真内核」。

`tools/real-dsh-probe.js` 是取证工具：把真实 dsh 的每一帧打出来，让任何字段
「先看一眼真帧再写代码」。dsh 的五处与文档假设不同的写法，全是被它抓出来的。

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

会话日志只追加、不修改，因此进程崩溃后可完整重建对话与 Trajectory，也是后续 fork / 回放的基础。
