# 项目约定与开发环境

这份文件回答一个问题：**一个刚拿到这个仓库的人（或下一次的 AI 会话）需要知道什么，才不会把工程改坏。**

它是从多轮开发中沉淀下来的硬约束与坑位，不是风格建议。违反其中的条目，通常不会立刻报错，而是以「看起来成功」的方式在别处出问题 —— 所以每一条都写清了**症状 → 根因 → 修法**。

相关文档：[README.md](../README.md)（能力与用法）· [DEVLOG.md](./DEVLOG.md)（逐次开发记录）· [SESSIONS/](./SESSIONS/)（会话决策纪要）

---

## 一、架构约束（改代码前先看这三条）

1. **Harness 绝不跑在 Electron 主进程内。** Electron 内置 Node 版本通常低于内核要求的 22.19+。内核是独立子进程，由壳层 spawn。
2. **所有内核调用只经过 `packages/core-host/src/adapter/`。** 内核 0.1.x 接口未冻结，UI 与壳层只认归一化事件，禁止透传内核原生结构 —— 升级风险必须限制在一个目录内。
3. **写操作必须先过 `Guard.assess()`。** `danger` 级别硬阻断，不可绕过。

派生出来的两条：

- **唯一契约来源是 `packages/protocol/src/`。** 任何新增能力先改契约再改实现，禁止在实现里私自扩展事件形状。
- **归约器只允许一份。** 事件流 → 对话视图的归约住在 `packages/protocol/src/reduce.ts`（契约语义，不是渲染细节），必须是纯函数（无 IO / 无时钟 / 无随机）。`apps/desktop/src/timeline.ts` 只是再导出壳，不得再长出第二套实现 —— 一旦分叉，回放与实时渲染就会悄悄不一致，而这种不一致没有任何报错。

---

## 二、分层纪律

### 写工具纪律

所有写操作走「预检 → 无变化短路 → 带 diff 审批 → 落盘」，且**预检与执行共享同一次文件读取**（`ctx.cache`）。共享快照不是优化，而是保证用户看到的差异 == 实际写入的内容。写工具共用 `runWriteTool`，不要各写一套。

### 逐块授权纪律

写工具在「多 hunk、非新建、非二进制、非截断」时标记 `selectable`，用户可逐块勾选。语义不可退化成「全接受/全放弃」：

- 空勾选 = 放弃本次写入
- 未勾选块必须**灰显但完整显示**（不显示 = 用户无法判断自己拒掉的是什么）
- 决议要写进 `approval.resolved.hunks`

落盘恒走 `applySelectedHunks`，硬等式 `applySelectedHunks(old, diff, []) === old`（逐字节）。部分应用同样要保留原文件行尾风格 —— 否则「空勾选」会变成一次静默改写。

### 终端纪律

内置终端是**命令台不是 PTY**（`spawn(command, { shell })`），刻意不引 node-pty（原生模块要跟 Electron ABI 编译，「装完就能跑」会变成空话）。面板顶部直接写明不支持 vim / top 这类全屏交互程序，而不是等用户敲进去再卡住。

终端输出**不进事件日志**，走独立通知通道、按会话隔离 cwd。Windows 中文输出是双编码（cmd 内建 = GBK / node·git = UTF-8），解码器先按 UTF-8 流式解、出现 `U+FFFD` 整段退回 GBK。

### 事件通道顺序

core-host 必须**先建 stdio 通道、后启动宿主**（`index.ts` 里 `startStdioServer(host, starting.catch(...))` 在 `await host.start()` 之前）。反过来写，host.start() 内部发出的 `host.ready` 会因通道未建立而永久丢失 —— 壳层崩溃重启后正是靠它恢复 UI。请求由 promise gate 排队，启动失败也放行让请求拿到错误。

### 会话分叉（fork）语义

- 新会话日志形状恒为「父会话前 N 行的**字节级复制**」+ 末尾一条 `session.forked`，顺序不可颠倒（先写标记会让前缀等式失效）。
- 分叉点必须吸附到 run 边界（`run.completed` / `run.failed`），半轮状态无法续跑。
- 日志是复制而非引用，删父会话不影响分支。
- 读取前缀必须走 `store.readRawLines`，**不能解析后再序列化**（字段顺序与转义会变，字节等式随之失效）。

### 内核接入（ACP）纪律

真实内核通过 **ACP（Agent Client Protocol）** 接入：`dsh --profile acp`，JSON-RPC 2.0 over stdio。
规格见 https://agentclientprotocol.com/protocol —— 它是公开标准协议，不是我们与内核的私有约定，
因此**不要凭猜测改消息形状**，改之前先查规格或让 `tools/real-dsh-probe.js` 给你看真帧。

**M2-B 实测纠正（文档先前与规格示例一致，dsh 不一定照搬）—— 全部以 `real-dsh-probe.js` 取证为准：**

- **`session/prompt` 的参数键是 `prompt`（数组）**，不是 `content`。写 `content` 会被内核以
  `-32602: prompt: expected array, received undefined` 明确拒绝。
- **客户端能力键是 `fs`**，不是 `fileSystem`。写错不会报错，只静默失效 —— 这种
  「看起来成功」的失败只能靠实测暴露。
- **`session/request_permission` 的工具 id 在 `params.toolCall.toolCallId`** 里，不在顶层。
  取错字段不报错，只是审批弹窗变成「unknown」。
- **`tool_call.kind` 恒为 "other"**，真实工具名在 `title`，入参在 `rawInput`。
  按 kind 判风险会让所有工具落到同一档，必须按工具名（`write`/`edit`/`pwsh`/`bash`/...）。
- **`tool_call_update.content` 是 `{ type:'content', content: 块 }` 的嵌套包装**，
  不是裸块。只认裸块则工具输出永远空串。
- **`dsh 的 ACP profile 不支持客户端文件系统操作`**（`fs/read_text_file` /
  `fs/write_text_file`）。**真正的审批闸门是 `session/request_permission`**：
  内核在写类工具落盘前向客户端申请权限，回 `reject-once` 内核就不会写。
  fs/* 仍然实现（其他内核可能用），但不是主路径，绝不能当成唯一的审批依据。

**dsh 的凭据与环境变量**：dsh 的 `dsh-credentials-local` 服务**一旦在场就屏蔽 env**，
`resolveApiKey` 先查 credentials，只有该服务不存在时才回退到 env。所以：

- 真生产部署：往 `$DSH_HOME/.credentials.yaml` 写 `version: 1, refs: { DEEPSEEK_API_KEY: ... }`。
- 测试替身：在隔离的 `$DSH_HOME` 里写一个假 key 的 `.credentials.yaml`，把请求导向本地 stub。
- `--patch` 把凭据插件 `disabled: true` **不顶用**（服务注册还在，env 不被读）。

**dsh 默认 sandbox-policy = workspace-write**：工作区内的 `write` **不触发**
`session/request_permission`（由 approval-presets 隐式放行）。要触发权限流得用
pwsh / delete 这类危险工具，或把路径放到工作区外。

- **stdout 只走协议，诊断一律走 stderr。** 往 stdout 打一行日志，客户端就会解析失败；
  偶发性地丢一帧比彻底不通更难查。
- **工作区边界。** 内核给的路径是它自己决定的，越界写入必须由客户端拦下。
  `assertInsideWorkspace` 走绝对路径 + 必须是工作区子路径或工作区本身。
- **DevDependency 钉精确版**（`@deepseek-ai/dsh@0.1.5-rc.1`，不要 `^`）：
  契约是按 0.1.5-rc.1 校准的，dist-tag `next` 会推到 0.1.5-rc.2，行为可能漂移。
- **越界写入由客户端拦下。** 内核给的路径是它自己决定的，不能假设它守工作区边界。
- **协议正确性由一致性测试守住**（`npm run test:acp` 与 `npm run test:real-dsh`）。
  真实 dsh 进不了 mock 自检，所以 `tools/fixtures/fake-acp-agent.js` 按规格实现了
  最小 agent 来驱动完整一轮；`tools/real-dsh-e2e.js` 则与真实 dsh 跑端到端。
  改适配层后必须这两组断言都过 —— 否则「能跑」只是没碰到那条分支。
- Windows 上 npm 安装的 CLI 实际是 `dsh.cmd`，直接 `spawn('dsh')` 会 ENOENT，
  而症状只是「内核起不来」。

### 真实 dsh 端到端测试纪律

`tools/real-dsh-e2e.js` 是 M2-B 起新增的**真实内核端到端**测试，缺 dsh 时优雅 SKIP（避免
`npm install` 在受限沙箱里失败时卡住整条流水线）。它与 `tools/acp-conformance.js`
（fake agent 守协议层）相互独立、各管一摊，verify 必须两项都跑。

端到端测试用本地 OpenAI 兼容替身（`tools/fixtures/openai-stub-llm.js`）。**替身**和**参考
fixture agent**是两件事：

- **替身**替的是模型 —— 接受 `/v1/chat/completions` 请求、按剧本返回工具调用或文本。
- **fixture agent**（`tools/fixtures/fake-acp-agent.js`）替的是内核 —— 按规格实现
  ACP stdio 协议，供一致性测试调用。

`pickTool` 必须先精确名（`write` / `write_file`）再词边界匹配（`(^|_)write(_|$)`）。
工具列表里的 `create_goal` 会让模糊正则 `write|create` 错命中，导致 stub 调用
`create_goal({file_path, content})` —— dsh 报「missing required property objective」，
断言失败但原因完全不对。入由客户端拦下。** 内核给的路径是它自己决定的，不能假设它守工作区边界。
- **协议正确性由一致性测试守住**（`npm run test:acp`）。真实 dsh 要下载运行时与模型凭据，
  进不了自检，所以 `tools/fixtures/fake-acp-agent.js` 按规格实现了最小 agent 来驱动完整一轮。
  改适配层后必须过这一组断言 —— 否则「能跑」只是没碰到那条分支。
- Windows 上 npm 安装的 CLI 实际是 `dsh.cmd`，直接 `spawn('dsh')` 会 ENOENT，
  而症状只是「内核起不来」。

### 界面布局纪律（M2-J 起）

**功能入口只有一处：左侧活动栏（rail）。** 新增一个功能页 = `AppView` 加一项 + `APP_VIEW_LABEL`
加一行 + rail 加一个图标 + 主区加一个分支。**不要在标题栏再加按钮** —— 横排按钮的宽度随
功能数量增长，加到第八个时只能换行，把标题挤成一列字（这正是这次重构的原因）。

**管理类是整页，审批是弹窗，这条界线不要模糊。** 弹窗的语义是「打断当前动作，处理完再回来」，
它适合审批（`ApprovalDialog` 是界面上唯一的弹窗）。技能 / 记忆 / 自动化 / 连接器 / 用量 / 设置
是用户**专门去管理**的页面：塞回弹窗会同时引入两个问题 —— 可用面积被压到 620px 宽，
以及背后那些「看起来还在、其实点不到」的元素。

**视图落盘在 `config.lastView`。** 旧的 `sidePanel`（none/tree/terminal）已被它取代；
`getConfig` 按字段合并默认值，旧 config.json 少这个键就走默认 `chat`，不需要迁移脚本。
渲染层不自己记「上次在哪」，否则与 config 各说一套。

**图标是内联 SVG，不引图标库。** 与「装完就能跑」同源：多一个依赖就多一份体积与供应链面。

**面板只渲染，不决定何时重新拉数据。** 刷新时机统一在 `App.openView`（`VIEW_REFRESH` 表）
与事件回调里 —— 否则每个面板会长出自己的刷新策略，出现「同一份数据在不同页面上新旧不一」。

### 用量聚合纪律（M2-J）

- **只读聚合，不新建存储。** 数据来自 `meta.usage` 与日志里的 `usage` 事件；再落一份「用量表」
  = 同一件事的两个事实来源，必然漂移，且漂移时没有任何一方是权威。聚合每次现算
  （`host.usageSummary()`），算完即弃。
- **分组之和必须等于总数。** `byDay` / `byModel` / `bySession` 三者各自的合计与 `totals`
  逐项相等 —— 这是 `test:usage` 里最硬的一条断言。聚合漏掉一类样本时，界面上每个数字都正常、
  只有加起来不对，而用户几乎不会去加一遍，所以这种错会一直活着。
- **汇总恒为全量，过滤只发生在图表上。** `usage.summary` 刻意不接受「最近 N 天」参数：
  一旦按范围过滤，分组之和就不再等于总数，那条等式立刻失效。图表只画最近 14 天，
  并且标题里写明这一点。
- **模型归属按 `run.started.model`，不按会话当前模型。** `usage` 事件不带模型；一个会话可以
  中途换模型，用后者会把换模型之前的用量算到新模型头上 —— 而那正是用量面板最该答对的题。
  找不到 `run.started`（日志被截断等）时退化为会话当前模型：不精确但可解释，
  且后果会出现在 `unpricedModels` 里，不会静默。
- **未定价 ≠ 0。** 模型没有配置单价时 `estimatedCostCny` 返回 `null`，界面显示「未定价」。
  返回 0 会被读成「免费」——那是把「不知道」伪装成「知道」。同理 `sanitizeModelPrices`
  只认真正的 `number`：`Number(null)` 是 0，顺手转一下就把一份坏配置变成了「单价 0」。
- **单价表放 config，不写进代码。** 价格会变，写死的价格表会以「看起来很精确的数字」腐烂掉。
  写入（`setConfig`）与读取（`usageSummary`）两侧都清洗，坏条目退化为「未定价」而不是 NaN。
- **`summarizeUsage` 是纯函数，日切函数由调用方注入。** 与 `nextFire` 同一条纪律：
  时区默认值一旦藏进函数里，同一份数据在不同机器上分组就不同，测试会变成「CI 上偶发失败」。



**同一文件的多处修改必须串行，且一次只发一个编辑。** 并行编辑会互相覆盖，两次都报成功，
只有回读才能发现改少了一半。这个坑本项目踩过两次，第二次的形态更隐蔽：**同一条消息里**
对一个文件发了两个编辑，其中「给 import 补 `useRef`」那一次被覆盖掉，于是 `useRef`
在代码里被调用却没有被导入。构建成功、`tsc --noEmit` 也不报错（它只查类型，不管是否导入
值），渲染层在运行时抛 `ReferenceError: useRef is not defined`，界面**纯白**。

白屏的排查路径记牢：**去看渲染层 console，不要在 DOM 选择器上猜**。
`ELECTRON_ENABLE_LOGGING=1` 让 Electron 把渲染层日志打到 stdout，一眼就能看到未捕获异常；
只盯着截图脚本「找不到 `.rail-item`」这类回执，会误判成选择器写错。

### 技能系统纪律

技能 = 「别人写的、会跑在你机器上的指令」。**安装前审计是不可协商的硬约束**，
与写工具的审批网关同源哲学（先看见，再发生）。

- **目录布局不可改**：`~/.deepwork/skills/<name>/`（本体）+ `~/.deepwork/skills.json`（清单）。
  清单与磁盘对齐 —— 目录被手删的幽灵记录在 `list()` 里自动剔除。
- **安装顺序不可重排**：验证清单 → 审计源目录 → critical? 拒绝（源不进家目录）
  → 暂存 `.staging-<name>/` → rename 到 `<name>/` → 写清单。
  「先拷再审」会让恶意文件先落进家目录，哪怕随后删除也已在磁盘上存在过；
  测试断言专门看「critical 源未进入家目录」（skill-system-test 28 行）。
- **拷贝而非引用**：技能源可能在临时目录（装完即删），安装 = 完整搬进家目录。
  拷贝函数 `copyDir` 跳过符号链接 —— 链接可以指向家目录外，把那种链接搬进来
  就是「你装了一个技能，但磁盘上生效的是 ~/.ssh」。
- **审计分级语义固定**：critical 拒绝安装，warn 允许安装但永久留档在记录里
  （UI 可展示「这个技能有什么前科」），info 仅作提示。**不分级的审计等于没审计**。
- **组合升级要可追溯**：`process.env` + 外网请求 → `exfiltration-combo` critical。
  单独命中是 warn，组合后是 critical —— 单看一条规则漏掉的就用另一条补上。
  这种组合必须生成**新一条 finding**（而不是改既有 finding 的 severity），
  这样 UI 可以同时给出原始命中与组合结论。
- **目录名由 frontmatter name 派生**：name 验证为 `[a-z0-9][a-z0-9-]*`，
  拒绝 `.`、`..`、`/`、`\`。把名字从源 directory 名换成 frontmatter 名，
  并校验不重合，可以挡掉「路径分隔符注入」一类利用。
- **审计引擎 ≠ 沙箱**：规则是按行正则启发式的，挡不住「把命令拆进多行字符串
  再拼起来」的语义层混淆。深度防御靠运行时的审批网关。两层各自承担定位。

### 凭据路径与 secret 关键词

`secrets-access` 规则覆盖 `~/.ssh`、`~/.aws`、`id_rsa`、`id_ed25519`、`.credentials.yaml`、`.netrc`、`.env`。
单独命中是 warn（很多技能会「参考」这类路径），与外网请求同文件命中升级 critical。
这意味着审计**不能只跑单文件后合一**：必须先收集全部命中再做组合判定。

### 技能消费（注入内核）纪律

- **每轮重建，不用缓存。** `host.send()` 每轮按当前启用清单重新构建技能上下文 ——
  用户在面板里停用一个技能，下一轮就必须看不到它，不存在「缓存里还有」的窗口期。
- **`user.message` 只记用户原文。** 注入文本走 `RunContext.skillContext`，不进用户消息事件 ——
  改写用户输入会让日志不再是「用户说了什么」的忠实记录，回放与分叉的等式随之失效。
- **`skill.attached` 必须先于 `run.started` 且带 runId。** 没有 runId 它会退化成全局事件，
  分叉会话的视图里会凭空多出别的会话的技能记录（与 session.forked 的归属问题同源）。
- **摘要注入 vs 全文注入分开。** 环境注入只带「名称/描述/触发提示/SKILL.md 路径」，
  正文由内核按需自取（路径已给出）；只有 `/技能名` 显式调用才注入全文，且受
  `SKILL_BODY_LIMIT` 截断并在 attached 记录里如实标 `truncated`。
- **截断与跳过都必须可见。** 正文截断标 truncated；已启用但 SKILL.md 损坏的技能记名
  skipped 并写日志 —— 「注入了但少了一截」「该在的没在」都不能静默。
- **注入文本不得被适配层改写。** `skill.attached` 记录里说的与内核实际看到的必须一致，
  中间任何一层「顺手改一下」都会让这条记录失去意义。

### 记忆系统纪律

三层记忆 = 画像（跨会话跨项目，只读注入，本地文件，云同步属 M3）/ 用户级记忆
（本机共享，显式写入）/ 工作区记忆（精选笔记 + 每日 append-only 日志）。

- **写入先于回复。** 本轮覆盖两条路径：UI 面板显式写入、`run` 结束后宿主向当日日志
  追加一行（时间/输入前 80 字/结果）。内核自主写记忆依赖 MCP 工具暴露（M2-G），
  在那之前不要宣称「内核会自己记」。
- **日志 append-only。** 每日日志只有追加这一个写入口（`appendDailyLog`），
  唯一的「移动」是归档：mtime 超 30 天的日记在读取侧惰性按月并入
  `archive/YYYY-MM.md` 后删原文件。**归档是机械合并，不是语义蒸馏** ——
  蒸馏需要内核摘要能力，届时以 `origin: 'distilled'` 条目回写精选层。
- **预算必须可见，超限必须拒绝。** 用户级与工作区精选是存储预算（add 超限抛
  可行动错误，绝不静默截断）；画像与今日日志是注入预算（截断并如实标记
  truncated）。UI 每层展示 entries/chars/budget，输入框旁给剩余预算。
- **`user.message` 只记用户原文。** 记忆注入走 `RunContext.memoryContext`，
  与技能注入同一条纪律（改写会让日志不再是忠实记录）。
- **`memory.attached` 必须先于 `run.started` 且带 runId**；无记忆内容时不发事件。
- **画像不走条目增删。** 它是整段文本：写入只走 `memory.setProfile`；
  读取经 `memory.list` 的 `id='profile'` 伪条目（契约注释有约定），
  `memory.remove('profile')` 等价清空。
- **工作区目录名是路径哈希**（sha256 前 16 位），不含路径分隔符、不泄露原路径；
  不要改成可读目录名 —— 可读性换的是路径注入面。

### 连接器（MCP）纪律

- **DeepWork 管清单，内核管协议。** 真实内核自带 `@deepseek-ai/dsh-mcp-client`：
  一条 server 配置即把外部 MCP server 的工具注册为 `mcp__<serverName>__<tool>`。
  上层再实现一套 MCP 客户端是重复建设 —— 这条决策来自对「自己写 MCP 客户端」
  的质疑，取证 dsh-mcp-client 源码后改向（见 DEVLOG M2-G）。
- **`--patch` 补丁形状以源码为准，不是 README。** 顶层 YAML 数组 + `{ insert: [条目] }`
  补丁（dsh-app-boot `applyEntryPatches`）；条目 `{ id, name, config }`；config 的
  键集合以 zod schema 为准（stdio：`transport/serverName/command/args/env`）。
  形状对拍在 connector-test 里，改形状前先看测试。
- **补丁文件由宿主在每次拉起内核前重建**（`~/.deepwork/runtime/connectors.patch.yml`），
  空清单不传 `--patch` 并清理旧文件。插件只在启动时加载：清单变更必须经
  `kernel.restart` 生效，UI 不许暗示「改完即生效」。
- **状态语义如实。** DeepWork 不知道实时连接状态（连没连上看内核日志），
  `ConnectorState.note` 必须如实说，UI 不得编造「已连接」。
- **名称即工具名前缀**（`mcp__<name>__`），校验 `[a-z0-9][a-z0-9-]{0,31}`
  与技能目录名同规则；重名在 store 层拒绝。
- **`mcp__` 前缀工具一律至少 confirm 档**（riskOfTool 不许落到 kind 兜底）；
  名称含 shell/exec 语义升 danger。危险命令模式的最终硬阻断仍由 Guard 兜底。

### 自动化调度纪律

- **调度只在应用运行期间生效。** 桌面应用没有常驻守护进程，应用没开就是没跑。
  这不是缺陷而是形态，但 UI 与文档必须写明白（面板顶部的提示不可删）。
- **错过不补跑。** 停机期间「该跑没跑」的次数不追补：`lastRunAt` 如实反映上一次
  真实触发。落点是引擎启动时的**过期清扫**（`sweepMissed`）：nextRunAt 已过期的
  任务推进到下一个未来时刻而不触发，过期的一次性任务直接停用。
- **`nextRunAt` 是持久化状态，不是读取时的派生值。** 曾经写成「读取时对 enabled
  任务重算」—— 重算用当前时刻，结果严格在未来，「到期」永不出现，引擎永远不触发。
  它只由三处写入：add/重新启用、触发后推进、启动清扫。
- **自动任务不绕过审批。** 调度触发走与手动 send 完全相同的链路（技能/记忆注入、
  审批网关），触发留痕 `schedule.fired`（带 runId 与 sessionId，先于 run.started）。
- **`nextFire` 是纯函数，与引擎分离。** `from` 显式传入、无 IO 无时钟 —— 月末溢出、
  当日已过点这类边界全靠密集单测压住；引擎的 `tickMs` 与 `now()` 可注入，
  测试用 100ms tick + 偏移时钟真实等到一次触发，而不是复制一套到期判定到测试里。
- **手动 runNow 不改计划。** 它与定时触发同一条 fire 路径，但不推进 nextRunAt、
  不动启用状态 —— 「试一下」不该消耗一次性任务的那一次。

### 浏览器自动化纪律（M2-H）

- **两条入口的授权语义不同，不可混。** UI 面板的 `browser.state/open/close`（RPC）是**用户自己的动作**，
  不弹确认；模型侧的六个动作走工具 / MCP，**每次都要过审批**。绝不能把模型能调的动作放进
  「用户自己点」的 RPC 白名单 —— 那是一条绕过审批的旁路，而且从界面上看不出来。
- **专用 profile 是硬要求，不是优化。** 必须 `--user-data-dir=<home>/browser-profile`：新版
  Chrome / Edge 对默认 profile 禁远程调试；同时这样不碰用户日常浏览器的标签页与登录态。
- **端口从 stderr 解析。** `--remote-debugging-port=0` + 正则读 `DevTools listening on ws://…`。
  写死端口会在被占时静默失败（表现为「浏览器起了但连不上」）。
- **单实例靠 endpoint 文件，不靠端口探测。** `browser-endpoint.json` 记 pid / port / wsUrl。
  读者**先探 pid 是否存活**：活着复用、死了才重拉。宿主与内核侧 MCP 服务是两个进程，
  不共享会各拉一个浏览器、截出两张不同页面的图。
- **借用人不越权杀进程。** `close()` 时只有「本进程拉起的那个」（`this.child`）才杀进程树并删端点；
  借用的实例只 `ws.close()` 断开。`shutdown()` 同理只收自己那份 —— 否则宿主退出时会顺带
  杀掉内核 MCP 服务正在用的浏览器，症状是「偶发地工具超时」。
- **截图落盘记路径，字节不进事件日志。** 与终端同源：PNG 高频无界，进 append-only 日志会拖垮
  回放与分叉。面板按路径读图（壳层 IPC 校验「父目录必须恰好等于截图目录」防 `..` 穿越）。
- **模型侧工具名用下划线。** 模型 API 对 function name 限 `^[a-zA-Z0-9_-]{1,64}$`，`browser.navigate`
  的点号不合法，暴露为 `browser_navigate`；下划线形式也天然不占用连接器名空间（连接器名不含下划线）。
- **`evaluate` 恒为 danger 档**，其余 confirm。受控组件要在页面里用原生 setter + 派发 input 事件，
  不能直接 `el.value=`（React 受控输入的内部值不变，读到的还是旧值）。
- **内置浏览器服务常驻注入。** 它是内置能力（与 fs / shell 一样始终对模型可见），因此
  `runtime/kernel.patch.yml` **总会存在**。任何「补丁文件不存在 ⇔ 没有连接器/端点」的断言都会因此失效 ——
  这类断言要改成看**内容**（有没有 `deepwork-connector-` / `llm-deepseek` 条目），而不是看文件在不在。
- **无浏览器时优雅 SKIP，不伪装。** `test:browser` 与截图脚本在系统无 Edge / Chrome 时明确跳过并出声；
  产出一张「未启动」的空面板截图、或让测试静默通过，等于把「能力缺失」藏起来。

### Office 生成与文档读取纪律（M2-I）

- **零依赖是硬约束，压缩率不是。** docx / xlsx / ofd 本质都是 zip + xml。zip 容器手写
  （`office/zip.ts`：local header + central directory + EOCD + CRC32），deflate 直接借
  Node 内置 `node:zlib` —— 于是「不引第三方库」与「文件是压缩的」可以同时成立。
  不要为省事去引 `docx` / `xlsx` / `jszip`：这条约束的意义是「装完就能跑」。
- **写出必须可复现。** `zipWrite` 的 DOS 时间戳固定（不取 `Date.now()`），同一输入产出同一字节。
  取当前时间会让「同一份文档两次生成的哈希不同」，凡是靠字节比对做的断言全部失效。
- **二进制输出不能没有预览。** 写工具一律先预览再授权是既有纪律；docx / xlsx / ofd 拿不出文本 diff，
  做法是**预览与执行共享同一份 plan 快照**，把包内文字抽出来（`extractDocxText` 等）当预览内容。
  **绝不允许「预览时重新生成一遍字节」** —— 那会让「看到的」与「写下去的」成为两份事实。
- **OFD 的文字顺序是坐标，不是 XML 顺序。** 生成器写出的 `TextCode` 顺序与阅读顺序无关。
  必须 Y 聚成行（容差聚类）→ 行内按 X 升序 → 中英混排拼接（CJK 之间不加空格、西文之间一个空格）。
  只读 `TextObject`，`Annot`（批注 / 水印）排除。按 XML 顺序拼出来的是一堆乱序片段，
  而且**看不出错** —— 读起来像一份正常文档，只是句子是错的。
- **自校验不算校验。** 「自己写的 zip 被自己写的 reader 解开」只证明自洽。测试里另起一个
  **Python 进程**（`zipfile` + `xml.etree`）复核 CRC / XML 良构 / `[Content_Types].xml` 覆盖 /
  rels 目标可达；**OFD 样本也由 Python 生成**，保证「读」这一侧面对的是外部生产者。
- **「能被真实 Office / WPS 打开」是验收动作，不是选项。** 结构断言（部件齐全、XML 良构）
  证明不了 Office 认它 —— 符合性里有大量只存在于实现里的隐含要求（xlsx 少一个 `gray125` fill、
  rels 少一段路径就报「文件已损坏」）。用 `tools/open-with-office.js` 拉真实 WPS 打开并截图。
- **截图抓窗口，不抓整屏。** 用 Electron 的 `desktopCapturer` 按**窗口标题**匹配文档窗口
  （`captureDocumentWindow`），找不到就重试，最后才退到整屏并在日志里说明退化。
  整屏抓到的是「此刻最靠前的窗口」，而启动外部程序时前台不受我们控制 —— 实测出现过
  「截图成功、日志全绿，图上却是另一个应用」。这种「看起来成功」的失败最坏。
- **无办公软件时优雅跳过，不伪装。** `test:office` 与截图脚本在系统没有 WPS / Office 时明确跳过并出声；
  产出一张「打开了空桌面」的图，等于把「没验证」伪装成「验证过了」。

---

## 三、验证基线

改动后必须能通过：

```bash
npm run verify          # 差异引擎随机对拍 + 写工具守卫 19 项 + 回放/分叉 29 项
                        # + 壳层 IPC 冒烟 26 项 + 逐块授权端到端 13 项 + 终端链路 22 项
                        # + ACP 契约一致性 37 项（含真实 dsh 形状）
                        # + 真实 dsh 端到端 15 项（M2-B 起新增）
                        # + 技能系统 59 项（M2-C 起新增：清单解析/审计规则/安装闸门/生命周期/RPC 接线）
                        # + 技能上下文注入 24 项（M2-D 起新增：摘要/显式调用/截断/skill.attached 事件链路）
                        # + 三层记忆 38 项（M2-E 起新增：预算闸门/append-only 日志/30 天归档/memory.attached 链路）
                        # + 自动化调度 68 项（M2-F 起新增：nextFire 密测/启动过期清扫/触发链路留痕）
                        # + 连接器管理 42 项（M2-G 起新增：补丁形状对拍/清单持久化/kernel.restart/内置服务常驻）
                        # + 用量聚合 27 项（M2-J 起新增：分组之和=总数/日切注入/未定价语义/单价清洗/宿主现算/RPC 接线）
                        # + 浏览器自动化 76 项（M2-H 起新增：CDP 报文/真实 Edge 驱动/审批链/单实例复用/进程清理）
                        # + Office 生成与文档读取 130 项（M2-I 起新增：zip 编解码/坐标排序读 OFD/文本视图审批/
                        #   Python 独立实现校验/真实 WPS 打开是验收动作）
                        # + 模型配置 31 项（自定义端点/凭据分存/真实 dsh 到达端点）
                        # + 沙箱后端 62 项（FR-3.5 起新增：runner 真帧对照/模式解析/内核装配真帧/
                        #   宿主 status 调用点/拒绝方言解析与防漂移/升级申请解析与防漂移/
                        #   换档入口（config 来源解析 + 真宿主重启内核 + 界面接线读源码））
                        # + 沙箱端到端 31 项（FR-3.5 第二期：真内核 + 真 ACP + 真工具 + 真落盘；
                        #   含对照组与反证组 + E/F 升级链三场景，见「沙箱与审批纪律」）
                        # + 图表与可视化 126 项（FR-3.8 起新增：契约单一事实来源 / 表格→规格归一化
                        #   （首列判定·缺测·重复列名·规模上限）/ 渲染字面量（柱数·断线·扇区·转义·可复现）/
                        #   审批链与无变化短路 / 真进程 MCP stdio 往返 / 内核补丁形状 /
                        #   Python 独立实现复核 SVG 良构与无脚本 / 界面接线与依赖纪律）
                        # + 随包运行时解析 21 项（§8.1 起新增：三档解析顺序 / 显式 env 覆盖 / 随包命中改 PATH
                        #   并删 PYTHONHOME / 「确实没有」要能构造（bundledDirs 给了就只用这些）；见 docs/DEPLOY.md）
                        # + 安装器与打包 29 项（§8.4 起新增：yaml 结构对拍 / 升级不降级 allowDowngrade:false /
                        #   卸载不清用户数据 deleteAppDataOnUninstall:false / 运行时进 extraResources 且不带
                        #   __pycache__ / 断言只看 from·to·files 条目，不看注释）
                        # + 内网 pip 源 31 项（§8.2 起新增：源参数只走 --index-url 不定配置 / PIP_CONFIG_FILE 指空设备
                        #   不读用户 pip.ini / 假索引服务端侧取证 / 失败原因分类认不出即 unknown 不猜）
                        # + 安装前体检 28 项（§8.3 起新增：八项检查按后果分 block·warn、每项带 remedy /
                        #   写权限真写一次 / 「文件在」≠「通过」/ 刻意零 Electron 依赖）
                        # + 真实 dsh+MCP 端到端 8 项（M2-G 起新增：真实插件加载；**排在最后**）
npm run demo            # 内核链路与差异还原一致性
npm run typecheck       # 三包（protocol / core-host / desktop）
npm run test:package    # 打包产物验收（--launch 会真的启动打包后的 exe 跑任务截图）
```

> **为什么「真实 dsh+MCP」必须排在 verify 链尾**：它在已知环境性失败下 `exit=1`，
> 而 verify 用 `&&` 串联 —— 排在中间会**中断整条链**，其后的套件（模型配置等）会静默不跑。
> M2-H 轮就因此把一个真实回归（`切回 official 补丁文件移除`）藏了整整一轮：它排在
> real-dsh-mcp 之后，从没在 verify 里跑到过。**新增/调整套件顺序时，把「已知会失败的」
> 放链尾，否则它的失败会伪装成「前面的都过了」。**

> **`real-dsh-mcp` 的结果在本机不稳定 —— 单次结果一律不可作为回归判据（2026-09-16 定论）**：
> 同一天里观测到两个**相反**的结果 —— 上午在**改动前的干净树**（`615c394`）与改动后的树上各跑一次，
> 两次都是 **8/8**（`mcp__fake__echo` 正常出现在内核工具列表里）；下午在新一轮开发的改动树与
> **它的基线（`bfd0710`）** 上各跑一次，两次都是 **3/8**（内核握手正常、`mcpCapabilities` 正常，
> 但模型收到的工具表里**没有** `mcp__*`）。
> 关键在于：**两次观测都「改动前后一致」，而一致的结果本身在变** —— 它随机器状态漂，
> 与代码改动无关。2026-09-13 记的那 5 项失败属于同一类现象。
> 两条结论：①**任何单次结果都不能当回归判据**，要判断回归必须**改动前后各跑一次**；
> ②归因仍未定 —— MCP 客户端拉起失败时内核**不报错，只是不注册工具**，从上层看不出原因
> （这本身是内核侧的一个可观测性缺口，有条件时值得向 dsh 反馈）。
> 旧记录保留（它记的是一次真实观测）。
>
> **仍然成立的部分**：它是真实 MCP 通路在本机的唯一哨兵，**不许从 verify 里摘掉**；
> 且它必须留在链尾（见上一条「已知会失败的放链尾」）。

> **疑似不稳定套件（2026-09-15 第六轮，仅一次观测）**：`memory-test` 在某次整链跑到它时
> `exit=1`，输出只剩 Node 崩溃栈尾（最后一行 `Node.js v22.22.2`）。随后**单独跑 4 次全绿**、
> **两次重跑整链也全绿**，未复现、未定位。它**不是**已知环境性失败，暂按「待观察」处理。
> 下次它若再红，第一件事是**把完整输出留档** —— 这一轮的教训是「只留了栈尾等于没证据」。

> **本机环境性阻塞（2026-09-16 观测，与改动无关）**：这轮跑 `npm run verify` 撞到两处
> **本机环境**导致的红，都不是回归，逐条记下来免得下次重新归因：
> ① **`real-dsh-e2e` 偶发 `initialize 超时（30000ms）`** —— 第一次整链跑到它时红，
>    `git stash` 后在**同一份 dist** 上单跑 15/15 全绿，整链重跑也 15/15；
>    判定为「整链连跑时与前面的 acp/real-dsh 套件抢资源或残留子进程」的瞬态，
>    **不是**当轮的图表补丁注入引起（real-dsh-e2e 直接用适配器起内核，不构造 runtime patch）。
> ② **`browser-test` 起 Edge 后 `浏览器提前退出（code=0）`** —— Edge 在本会话的进程环境里
>    拉不起无头实例。属环境，与代码无关。
> ③ **`node_modules/electron/dist` 缺失**（`electron` 包在、二进制没下）⇒ `tools/capture.sh`
>    按设计**拒绝启动**（缺 Electron 时它 exit=1，不产出一张空白图）。因此这轮的
>    `artifacts/ui-chart.png` **未产出**，界面渲染的证据回落到 `tools/chart-test.js` 的
>    「界面接线与依赖纪律」一节（读源码断言）—— 如实标注，不当成已验收。

> **测试断言的参照物不要写死实现细节**（例如演示脚本的文件落点）：改成从契约数据（`diff.path`）取。否则实现一挪动，断言就会拿 `null` 继续对拍，失败信息还看不出真正原因 —— 这类失败最难定位，因为测试显示「通过」。

打包相关的改动还要加 `npm run test:package --launch`（9 项）。

---

## 四、版本管理约定

1. **提交前必须跑通** `npm run verify` 与 `npm run demo`，否则「基线是绿的」这句话就失去意义。
2. **换行符固定 LF**（仓库级 `core.autocrlf=false` + `.gitattributes` 的 `eol=lf`）。本项目多处依赖逐字节比对（日志回放断言、差异还原自检、fork 前缀等式），一旦 CRLF 转换，这些断言会以「内容不一致」失败而真实原因是行尾 —— 极难定位。
3. 提交信息：`feat|fix|test|docs|chore|refactor(scope): 改了什么`，正文写「为什么」。
4. 不入库：`node_modules/`、`dist/`、`release/`、`.deepwork/`、`artifacts/`；唯一例外是里程碑验收截图（`git add -f artifacts/*.png`），因为 DEVLOG 的「验证」段引用了它们。新增截图同样需要 `-f` 显式纳入。
5. 改动完成后用**克隆往返**自检：clone 到临时目录，若 `git status` 非空即说明检出内容与提交内容不一致。

---

## 五、开发环境（本机特有，换机器请按需调整）

### 依赖与镜像

依赖走 npmmirror。打包时需要：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

### 三个必踩的坑

| 症状 | 根因 | 修法 |
|---|---|---|
| `dirname` / `head` / `ls` 全部找不到 | 本机 bash 的 PATH 可能被清空 | 命令前显式 `export PATH="/c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3:/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:/c/Windows/System32:/c/Windows:$PATH"`。PortableGit 只加 `cmd/` 会缺 unix 工具，必须带上 `usr/bin` 与 `mingw64/bin` |
| `git` 报 `cannot change to ...` | git.exe 是原生 Windows 程序，**只认 `D:/...`，不认 msys 的 `/d/...`**；而 `ls` / `cd` 反过来只认 `/d/` | 同一个命令里两者不可混用 |
| Electron 应用启动即退、退出码 0、无日志 | 环境里带 `ELECTRON_RUN_AS_NODE=1`（宿主自身跑在 Electron 上），electron.exe 退化为纯 Node | 启动前 `unset ELECTRON_RUN_AS_NODE` |
| `VAR=1 npm run ...` 里变量「没生效」但命令成功 | 本机 workbuddy 的 PortableGit bash 作为父进程时，shell 内 `export` / `VAR=1` 后加的变量传不进原生 Windows 进程链（npm → cmd → node）；命令不报错，只是分支走错（如 `DEMO_DENY=1` 跑了放行分支） | 一律用 `env VAR=1 npm run ...`；或在 cmd 里 `set VAR=1 && npm run ...` |
| 任何 `bash -c '...'` / `bash 脚本.sh` 都报 `PROGRAM BLOCKED ... wsl.exe` | **本机的嵌套 bash 被实现为经 `wsl.exe`**，而 wsl 在 Security Center 的 Program Blacklist 上（提示写明不可批准、不可绕过）。症状是 `bash -x` 连一行 trace 都不打就命中拦截 | **不要绕。** 需要跑脚本时改用「把脚本里的命令拆开直接在 shell 里跑」或「用 node 驱动」（`node -e "..."` 里用 `spawnSync`）。因此 `tools/capture.sh` 在本机**跑不通**，取证走直连 Electron（见「验收截图」）|
| 在 bash 的 `node -e "…"` **双引号**里写了反引号，于是满屏 `command not found`，目标脚本最后以 `SyntaxError` 收场；甚至出现「某个 `.ts` / `.png` 被当成脚本执行」 | bash 先做**命令替换**：反引号里的内容被当命令**真的执行**（2026-09-15 第六轮真实事故，被执行的包括 `packages/protocol/src/security.ts` 与一个 png） | **给文件写内容一律用编辑工具，不要经 shell 拼字符串。** 非要在 shell 里跑 node：`-e` 的脚本用**单引号**包（内含反引号才安全），或把脚本落成临时 `.js` 再 `node <文件>`。事故后**先核对 `git status` 与文件大小**再继续 |

### 打包约定

- `npm run dist`（NSIS + zip）/ `dist:dir`（免安装目录）。打包会写真实磁盘，在受限执行环境里需要在非沙箱模式下跑。
- 内核产物在 asar 之外 `resources/core-host/`；protocol 手工摆成 `core-host/node_modules/@deepwork/protocol`（workspace 软链打包后消失，require 会静默失败）。
- electron 版本必须钉**精确值**，electron-builder 拒绝范围。
- 壳层用 `resolveCoreEntry()` 定位内核：打包态 resourcesPath 优先，但**需确认文件存在**才采用 —— 开发态 Electron 同样设置 resourcesPath，无条件采用会让 `npm run start` 缺内核。
- 图标由 `tools/make-icon.js` 生成（纯 Node 手写 PNG 编码器，主题色常量驱动），不入库。
- 打包后的 GUI 程序没有 stdout，排查靠 `DEEPWORK_LOG_FILE` 日志落盘。

### 验收截图

```bash
bash tools/capture.sh [场景...]     # 场景：chat / tree / terminal / preview / hunk / settings / settings-prefs
                                    #       / settings-security / sandbox-denial
                                    #       / skills / memory / schedule / connectors / usage / browser / office
```

> **本机（2026-09-15 起）跑不了这个脚本**：嵌套 bash 会命中 wsl.exe 黑名单（见「三个必踩的坑」最后一行）。
> 替代做法是**直连 Electron**，用完全相同的一套 `DEEPWORK_CAPTURE*` 环境变量，并在命令前
> 自行做 `reset_fixture` 的两件事（删 `artifacts/.deepwork` 与工作区里的 `AGENT-NOTES.md`）：
>
> ```bash
> cd apps/desktop && unset ELECTRON_RUN_AS_NODE
> DEEPWORK_CAPTURE="D:/.../artifacts/<名>.png" DEEPWORK_CAPTURE_FOCUS="<选择器>" \
> DEEPWORK_CAPTURE_SCRIPT="..." DEEPWORK_CAPTURE_PROMPT="..." \
> DEEPWORK_WORKSPACE="D:/.../artifacts/demo-workspace" DEEPWORK_HOME="D:/.../artifacts/.deepwork" \
> "D:/.../node_modules/electron/dist/electron.exe" . 2>&1
> ```
>
> **改完截图脚本后要把实际跑过的那一版同步回 `capture.sh`**，否则文件与事实会变成两套
> （第六轮就出现过：手搓命令里已经改成「不点击、默认展开」，而 `capture.sh` 里还留着旧的点开逻辑）。

`office` 场景与前 12 场不同：它不渲染本项目的 UI，而是**用系统里真实的 WPS / Office 打开刚生成的
`report.docx` / `budget.xlsx`**，再按窗口标题截取那个文档窗口。它是 M2-I「能被真实软件打开」这条
验收判据的留证动作；系统没有办公软件时明确跳过并出声（见「Office 生成与文档读取纪律」）。

**脚本会先重建产物（protocol / core-host / 渲染层），构建失败即中止。** 这不是多余的谨慎：
Electron 加载的是 `apps/desktop/dist` 里的 bundle，它不跟着源码改动更新，
此前出现过「截图成功、画面却是上一版 UI」——日志全绿、图也写出来了，只有图是旧的。
不重建时设 `DEEPWORK_SKIP_BUILD=1`。

脚本会自动重置 fixture（演示脚本是三步链，不幂等 —— 不重置则第二场必然失败、画面不可复现），并把路径转成原生 `D:/` 形式（原生 Electron 不认 msys 路径，不报错也不截图）。

**传路径给原生程序时只能用 `D:/...` 形式。** 这条不只针对 Electron：`node tools/fixtures/seed-usage.js <路径>`
里的那个参数也会被 Git Bash 转换 —— 传 `/d/...` 会变成 `D:\d\...`，症状是 `Cannot find module 'D:\d\...'`。
（写在 JS 字符串里当参数的路径不受影响，所以老的预设脚本都没踩到。）

写截图脚本时注意：**把多段拼成一段 IIFE 时，前一段的 `return` 会让后一段变成死代码**，而返回值仍显示成功。脚本要自证（回读 DOM 状态），不要只 `return 'ok'`。

### 沙箱环境的一个陷阱

把产物写到沙箱可写范围**之外**时，命令可能报成功但结果随后不可访问（`git clone` 往返、electron-builder 的 `rename` EPERM 都踩过）。解法是把产物写进可写目录 + 唯一目录名，或直接申请非沙箱执行。

### 模型配置纪律

- **端点配置只走 `--patch` 覆盖补丁，不走 `$DSH_HOME/settings.yaml`。**
  settings-file 是热重载的，与 session/new 公布模型目录之间没有次序保证
  （2026-09-13 实测：同一配置先偶然通过、后稳定失败）。补丁在组合期应用，
  是确定性的；代价是变更需 kernel.restart 生效，UI 必须如实呈现这条语义。
- **模型清单改之前先跑探针。** 内核公布的模型 id 与显示名不靠印象：
  「V4.1 Flash」的真实 id 是 `deepseek-flash`。`tools/real-dsh-probe.js` 的
  session/new 帧是唯一事实来源。
- **API key 两级存储、明文不出宿主**：`~/.deepwork/secrets.json` 按模式分存
  （official/custom 互不覆盖），dsh 凭据文档只同步当前模式；RPC 只回掩码。
  spliceCredentialRef 只动目标键，refs 下其它键（可能属于别的工具）逐行保留。
- **setConfig 先校验再落盘**，不合法的端点配置不进 config.json。
- Windows 拉起 dsh 用 `node <bin.js>` 直跑，不 spawn `dsh.cmd`（EINVAL）。

### 沙箱与审批纪律（2026-09-15 起）

**先记一条最容易搞错的：这是两层，不是一层。**

- **内核沙箱**（`dsh-sandbox` 家族）管「命令**能不能写成文件**」。它由内核在执行时强制，
  产品只能通过**启动参数** `DSH_PERMISSION_MODE` 决定（`dsh-sandbox-policy` 的 `mode`），
  词汇是 `read-only` / `workspace-write` / `danger-full-access`。
- **审批档位**（宿主 `Guard`）管「哪些命令**要问人**」。`Guard.assess()` 只作用于
  宿主自建工具（`tools/builtin.ts`）与 mock 内核 —— **真实内核下模型的命令跑在内核里、
  不过宿主，所以它管不到那些命令**。挡住越界写入的一直是内核沙箱。

两条由此推出的硬规则：

1. **不要给 `dsh-sandbox*` 另起名字。** 产品的 `SandboxMode` 必须与内核
   `permission-presets` 的键逐字相同，两边不一致的那天，界面显示的档位与内核执行的就是两回事。
   `tools/sandbox-test.js` 段 5 有断言钉住这一点（读 `--dump-config` 的真帧）。
2. **`DSH_PERMISSION_MODE` 不要静默覆盖。** 它是内核的变量，用户可能直接设过。
   `resolveSandboxMode()` 的优先级是「产品变量 `DEEPWORK_SANDBOX_MODE` > 内核变量 > 产品默认」，
   非法值回落默认并留下 `rejected`（界面必须显示）—— 权限类设置上「以为生效了」是最坏的形态。

**验证沙箱时，先证明「它本来能发生」。** `tools/sandbox-test.js` 段 0 是对照组：
同一条写入命令不套沙箱时必须成功。没有这条基线，「文件没出现」既可能是沙箱拒绝、
也可能是命令压根没跑起来 —— 后者会伪装成「沙箱生效了」的绿灯（这一轮真的踩到过）。

**写断言时区分「策略拒绝」与「runner 故障」**：后者 stderr 带 `windows-acl-run:` 前缀、exit=127，
是两种完全不同的故障，不要都算成「沙箱挡住了」。

**本机平台边界（写文案时按此，不要拔高）**：win32 档报告 `partial` 强制执行 ——
受限令牌必须保留 Everyone 才能完成进程初始化（授予 Everyone 写访问的外部对象仍可写），
NTFS 硬链接会把同一文件对象别名为多个路径；且该 seam **只交叉检查写访问**，
读、网络与进程可见性不受限。这些是**平台事实**（来自内核包自述），不是运行时测量值 ——
ACP 面不暴露 enforcement 等级，不要写成「实测 full/partial」。

---

**补充（2026-09-15 第六轮，真内核端到端取证之后）**

上面的分层是从文档与装配真帧推出来的；第六轮用真内核 + 真 ACP + 真工具 + 真落盘把它验成了事实。
下面是验证过程中必须记住的四条，**每一条都对应一个曾经会得出相反结论的坑**：

1. **`os.tmpdir()` 在 `workspace-write` 下是**可写区**。**（`dsh-fs-sandbox` README 原文：
   可写集合 = 会话工作区 ∪ 平台临时根目录。）所以取证时把「工作区外」的目标放进临时目录，
   它会被**放行**，而结论会被写成「沙箱没生效」。
   → 拿临时目录当现场的一切沙箱验证，都要**先自检现场**：`outside` 必须既不位于
   `workspace` 之下、也不位于 `tmpdir` 之下（`tools/sandbox-e2e.js` 段 0 就是这么做的），
   自检不过时整份结论作废。
2. **沙箱拒绝不是审批事件。** 内核把拦截当**工具错误**返回（`tool.completed ok=false`），
   并在输出里告诉**模型**可以带一次 `sandbox_permissions` 重试 —— **重试才会弹审批**。
   → 界面上不能说「沙箱拦下 = 我拦下的」；也不能把审批档位当成拦越界写入的那道闸
   （它在本机观测中是**模型升级决策的下游**）。措辞照 `ToolCard` 里的来：说明档位语义
   + 说明「内核还留了一跳，那时才问你」。
   （补：2026-09-16 第三轮把这个「那时」也验了 —— 不重试的 5 组场景审批请求数为 0，
   带 `sandbox_permissions` 重试的 E1/E2 各为 1，同级申请 F 为 0。见下方「升级那一跳」。）
3. **两条能力族的拒绝方言不对称，解析器只认一条（有意）。**
   - fs 族（模型改文件）→ `[sandbox: file access denied under <mode> mode]`，**有**显式标记；
   - shell 族（bash/pwsh）→ 裸 `EPERM: operation not permitted`，**没有**标记。
   `EPERM` 与「文件本来就只读 / ACL 不让写」不可区分，把它算成沙箱拒绝就是**编结论**。
   → `parseSandboxDenial()` 只认 fs 族；shell 族在界面上仍是普通失败。这是知情取舍，
   `tools/sandbox-test.js` 段 7 有一条断言把这个边界钉住，防止后来者以为解析器覆盖了全部。
4. **让 mock 造真实内核独有的帧是允许的，但必须同时满足三条。**
   界面上「被沙箱拦下」这条路径在 mock 下永远跑不到，没有帧就没有验收（这与 M2-J 让 mock
   模拟 `context.usage` 是同一条理由）。允许的前提：
   (a) 帧的内容是**真帧逐字副本**，且注释写明来源与日期；(b) 代码与注释都写明它证明的是
   **渲染路径可达**、不证明沙箱会拦，真取证指向哪个文件；(c) 有一条**断言**钉住
   「mock 的字面量 === 解析层的真帧副本」逐字相同 —— 光靠注释提醒「多处一起改」是拦不住人的。

**做沙箱类「没发生」的断言时，最少要两组对照**：一组证明「它本来能发生」（不设限时写成功），
一组证明「换个变量结论就反过来」（同一目标在 `danger-full-access` 下写成功）。
只有前者时，「没写进去」还可能是因为目标目录本身不可写（ACL、只读盘、路径写错）；
有了后者，归因才能落到模式上。`tools/sandbox-e2e.js` 的 A 与 D 就是这两组。

---

**升级那一跳（2026-09-16 第三轮起，有本机真帧）**

「被拒 → 带 `sandbox_permissions` 重试 → 弹审批」这条链此前只有内核文档背书。现在的观测是：

| 情况 | 审批请求数 | 结果 |
|---|---|---|
| 被拒但**不重试**（B1/B2/C/D/A） | 0 | 用户点「允许」也没用：没有第二次调用就没有可批准的东西 |
| 带 `sandbox_permissions` 重试且**严格更宽**（E1） | 1 | 宿主批准 → 该次调用以宽档位执行、越界文件真的落盘 |
| 同上但用户**拒绝**（E2） | 1 | 什么都没发生，工具失败文本是内核原话 `the user rejected escalating this operation to "…"` |
| 申请**同级或更窄**（F） | **0** | 内核在执行前判掉（`not strictly wider`）—— **不问人**，这是 fail-closed |

从这条链推出的三条纪律：

1. **升级参数是按「有没有挂限制性后端」门控广告的。** 没挂时 `write` 的 parameters 里
   根本没有 `sandbox_permissions`，模型无从申请，而链路上**不会有任何异常**。
   → 要断言这件事只能读**真请求的 schema**（`openai-stub-llm.js` 的 `entry.toolParams`），
   读代码是读不出来的。`sandbox-e2e` 段 7 有两条断言钉住它。
2. **内核过 ACP 时把模型的理由丢了，宿主必须自己捞回来。** 权限请求帧只带
   `toolCall.toolCallId` + 两个选项（`allow_once` / `reject_once`）；模型的 `justification`
   是**写给用户的那一句话**，只在 `tool_call` 的 `rawInput` 里。适配器用
   `parseSandboxEscalation` 从它解析出来补进审批请求，弹窗才说得清
   「这是升级申请、要提到哪一档、理由是什么」。
   → 没有这一层，用户面对的是一个不知道在批准什么的「允许 / 拒绝」——**版式上完全正常**，
   所以这条只能靠断言与真帧守着。
3. **mock 造升级审批帧时，必须走真实的 `ctx.requestApproval` 通道**，不许伪造一帧审批事件。
   伪造的话那个场景证明的只是「弹窗会渲染我塞的字段」，证不了「适配器补出来的升级信息能到弹窗」。
   （这是上面第 4 条「mock 造帧」在审批类帧上的加强版。）

**顺带记住的一条方法论**：替身端点的剧本游标要按**「已跑完的工具结果数」**步进，
不要按「请求序号」——后者会被标题生成一类的旁路请求推歪，而「模型提前说不出话」
在测试里表现得像内核挂了（`tools/fixtures/openai-stub-llm.js` 头部有说明）。
