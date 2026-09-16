# 验证与验收

本项目的验证哲学：**UI 出问题不代表内核链路出问题**——先跑无 GUI 的自检定位，
验收截图只是把「已经断言过的事」再给人看一遍。

改动后的基线（与 [CONVENTIONS.md](CONVENTIONS.md) §三 同步维护）：

```bash
npm run verify     # 全套无 GUI 自检（各套件见下表）
npm run demo       # 内核链路与差异还原一致性
npm run typecheck  # 三包（protocol / core-host / desktop）
```

## 快速定位：demo 与 smoke

`npm run demo` 会在临时目录里造一个示例工程，跑完「会话 → 工具调用 → 审批 → 事件落盘」全链路，
并校验日志完整性、事件序号连续性，以及**差异链路** —— 由预览差异还原出的内容必须与磁盘实际内容逐行相同。
**UI 出问题不代表内核链路出问题，先跑 demo 是最快的定位手段。**

`npm run smoke` 加载的是 Electron 主进程使用的那份 `core-host-client`，覆盖子进程解析、
NDJSON 分帧、请求响应配对、事件推送、审批回环、退出清理、配置读写往返，以及差异跨进程序列化后是否仍然完整。

演示拒绝审批分支：

```bash
env DEMO_DENY=1 npm run demo   # Windows cmd: set DEMO_DENY=1 && npm run demo
                               # 注意：本机 Git Bash 里 `DEMO_DENY=1 npm run demo` 前缀形式
                               # 会把变量丢在 npm 启动链上（见 docs/CONVENTIONS.md 坑位表）
```

## 自检套件清单

`npm run verify` 依次跑完：

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
| `npm run test:skills` | 技能系统：清单解析（合法 + 6 种拒绝形状）/ 审计（四类规则 + 组合升级 + localhost 例外）/ 安装闸门（**「critical 源未进入家目录」是核心断言，验证先审后拷**）/ RPC 接线 |
| `npm run test:skillctx` | 技能上下文注入：摘要注入与 `/` 显式调用、截断如实标记、损坏技能跳过；host 链路上 `skill.attached` 事件的形状/次序/归属、`user.message` 原文不被改写、停用后下一轮立即不再挂载 |
| `npm run test:memory` | 三层记忆：三层增删读、预算超限拒绝（可行动错误信息）、画像伪条目读写、每日日志 append-only、30 天惰性归档（utimesSync 构造）；注入文本三层分节与截断标记；host 链路上 `memory.attached` 先于 `run.started` 且 runId 一致、run 结束当日日志多一行；5 个 `memory.*` RPC 注册可用 |
| `npm run test:schedule` | 自动化调度：`nextFire` 纯函数密测（once 过期、当日已过点、每周多日组合、月末溢出落到当月最后一天、interval 对齐）；store 持久化与启停重算；引擎注入 tick/时钟真实等到触发（once 触发后自动停用、runNow 不改计划、启动过期清扫不补跑）；host 链路上 `schedule.fired` 先于 `run.started` 且 runId 归属正确、run 结局写回任务、复用绑定会话；5 个 `schedule.*` RPC 注册可用 |
| `npm run test:connectors` | 连接器管理（MCP）：补丁纯函数与 dsh-mcp-client 源码取证形状对拍（insert 条目 / config 键集合）、停用排除、空清单返回 null、YAML 序列化；store 增删启停持久化与名称校验；host 链路上 `connectors.*` 四个 RPC 注册可用、`kernel.restart` 真实完成适配器重启、补丁文件只在有启用连接器时生成；`mcp__` 前缀工具名的风险分级（confirm 起步，shell/exec 语义升 danger） |
| `npm run test:usage` | 用量聚合：纯函数层（**分组之和 = 总数**、按日升序、按 token 降序、日切注入、未定价返回 null 而非 0、坏单价清洗含 `null` 不被当成 0）；宿主层（真实 `events.jsonl` 现算、换模型的会话按 run 归属、`setConfig` 坏值不落盘）；RPC 接线 |
| `npm run test:browser` | 浏览器自动化（M2-H 起新增）：内置 MCP 补丁条目形状与入口文件真实存在、六个动作的 CDP 报文、真实 Edge 驱动 fixture 页面（导航 / 读文本 / 点击 / 输入 / 求值 / 截图 PNG magic bytes）、`evaluate` 落 danger 档、审批链（拒绝即不执行）、跨进程单实例复用与「借用人不越权杀进程」、MCP 协议端到端、进程清理；系统无浏览器时优雅 SKIP |
| `npm run test:office` | Office 生成与文档读取（M2-I 起新增）：零依赖 zip 编解码（CRC32 校验、zip-bomb 上限、固定时间戳可复现）、docx 8 个必备部件与 Markdown 子集（标题/列表/引用/代码/表格）、xlsx 共享字符串与冻结表头、`office.read` 对 docx/xlsx/ofd/纯文本四类的分发与体积上限；**OFD 原生读取**按坐标排序（Y 聚行 → 行内 X 升序 → 中英混排拼接）而非 XML 顺序；审批链（二进制输出走「文本视图」预览、拒绝即不落盘、预览与落盘同源）；另起 **Python 进程做独立实现校验**（`zipfile` + `ElementTree` 复核 CRC / XML 良构 / Content_Types / rels 目标），OFD 样本由 Python 侧生成 |
| `npm run test:modelcfg` | 模型配置：端点覆盖补丁形状与 YAML 序列化、凭据 refs 合并（不丢其它键）、secrets 按模式分存、apiKey RPC 只回掩码；host 链路上配置写入即出补丁文件、custom 会话默认端点模型；真实 dsh 端到端断言**自定义模型名真的到达端点**（连跑两轮防 settings.yaml 竞态回归） |
| `npm run test:chart` | 图表与可视化（FR-3.8 起新增）：契约层（入参表是单一事实来源，宿主描述与 MCP schema 都从它派生）、表格 → 规格归一化（首列判定 / 缺测记 null 而非 0 / 重复列名加序号 / 按图型分档的规模上限 / 每类拒绝都可行动）、渲染**字面量**断言（柱数 = 类别 × 系列、缺测把折线切断且孤立点不连线、饼图扇区与占比、单扇区整圆、负值柱与零线、标签转义、CSP、无脚本无外链、**逐字节可复现**）、工具层审批链（拒绝即不落盘 / 无变化短路不再弹审批 / 越界与扩展名边界）、**MCP 服务按 stdio 真进程往返**（真握手、真落盘、数据不合规走 isError 内容、未实现方法 -32601）、内核补丁形状与合并顺序、**Python 独立实现复核 SVG 良构与零脚本**、界面接线与「图表实现零第三方依赖」。界面渲染本身由 `artifacts/ui-chart.png` 取证（不在本套件里，理由见文件头） |
| `npm run test:sandbox` | 沙箱后端（FR-3.5）：runner 真帧对照（先证命令不套沙箱能跑）、模式解析优先级与非法值回落、内核装配真帧（`--dump-config`）、宿主 status 调用点、拒绝方言解析与防漂移（mock 模拟帧 === 解析层真帧副本逐字相同） |
| `npm run test:sandbox-e2e` | 沙箱端到端（FR-3.5 第二期）：真内核 + 真 ACP + 真工具 + 真落盘，5 场景矩阵（内核默认 / workspace-write / 答复放行 / read-only / danger-full-access），含对照组与反证组、fixture 现场自检（「工作区外」不得落在临时根目录下） |
| `npm run test:real-dsh-mcp` | 真实 dsh + 真实 MCP server 端到端：`--patch` 叠加连接器补丁 → dsh-mcp-client 拉起 fixture MCP server → 工具注册为 `mcp__fake__echo` → 模型替身精确名调用 → 回显经 ACP 事件流带回；dsh 缺席时优雅 SKIP。**排在 verify 链尾**——它在已知环境性失败下 exit=1，排中间会中断 `&&` 链，其后的套件会静默不跑 |

各套件的断言数与已知环境性失败以 [CONVENTIONS.md](CONVENTIONS.md) §三 为准。

## UI 截图验收

不想手动开窗口时，可以让应用启动后自动跑一轮任务并截屏退出：

```bash
DEEPWORK_CAPTURE=artifacts/ui.png \
DEEPWORK_CAPTURE_PROMPT="看一下这个工程的结构" \
npx electron apps/desktop
```

各里程碑的验收截图用 `tools/capture.sh` 批量生成，它比手敲命令多做了两件事：
**每场截图前重置 fixture**，以及**把路径转成原生 Windows 形式**（见下表）：

```bash
bash tools/capture.sh                  # 全部场景：chat / tree / terminal / preview / hunk / settings /
                                       # skills / memory / schedule / connectors / usage / browser /
                                       # chart / office / sandbox-denial 等
bash tools/capture.sh preview hunk     # 只跑指定场景
bash tools/capture.sh chart            # 只补图表场景（产物由 seed-chart.js 走真实生成器预置）
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

还有一个**前置条件**（不是脚本能处理的）：`node_modules/electron/dist/electron.exe` 必须真的存在。
`node_modules/electron/` 的包体在、二进制没下（install 脚本的下载被网络挡住）时，脚本**按设计拒绝启动**
（`exit=1`）—— 这比产出一张「未启动」的空白图好，但意味着**没有截图就等于该项未验收**。
2026-09-16 的 FR-3.8 轮次就撞上这个：`artifacts/ui-chart.png` 未产出，界面渲染的证据只到
`test:chart` 的「界面接线与依赖纪律」一节（读源码断言），不当作已验收。

## 打包产物的验收

`npm run test:package` 不满足于「文件存在」，它真的把产物里的内核用外部 node 拉起来、
发一次 RPC 等它回话；`--launch` 再进一步，启动打包后的 `DeepWork.exe` 跑一轮真实任务并截图：

```bash
node tools/package-verify.js            # 结构 5 项 + 内核 3 项
node tools/package-verify.js --launch   # + 启动应用截图（artifacts/packaged-app.png）
```
