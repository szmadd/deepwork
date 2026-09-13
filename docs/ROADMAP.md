# DeepWork 后续研发规划

> 写于 M2-G 收口时（2026-09-12/13），2026-09-13 增补「战略方向」一节；同日 M2-H 完成后更新当前状态；
> 同日 M2-I（Office 生成 + OFD 原生读取）完成后再次更新。
> 用途：下一次会话（或下一位开发者）拿来就能开工，不需要重新考古。
> 每项都带「范围 / 关键决策 / 判据」，判据口径与 DEVLOG 纪律一致。
>
> 相关文档：[需求与架构方案](./深边AI-Work-开发需求与架构方案-v1.0.md) · [DEVLOG](./DEVLOG.md) · [CONVENTIONS](./CONVENTIONS.md)

---

## 〇、战略方向：本地模型，可离线运行（2026-09-13 增补）

**产品目标：让 DeepWork 用本地化模型运行，脱离互联网也能工作。** 这改变了一批事项的优先级与形态：

- **模型接入形态**：官方 DeepSeek API 只是来源之一。本地模型经 **OpenAI 兼容端点**
  （Ollama `:11434/v1`、LM Studio `:1234/v1`、vLLM 等）接入 dsh——M2-B 已实测
  `DEEPSEEK_BASE_URL` 可以把 dsh 的模型请求指向任意 OpenAI 兼容端点（当时指向本地 stub 全链路通过）。
  dsh 的 `dsh-llm-pi-ai` 包提示多 provider 骨架存在，接入新 provider 前先取证，不凭猜。
- **模型配置（本轮落地）**：设置界面管理「提供方 = 官方 / 自定义 OpenAI 兼容端点」，
  baseUrl / 模型名 / API key（密钥与配置分文件存放，界面只显掩码）。
- **后续优化清单**（按依赖排序，随时补充）：
  1. **本地模型向导**：检测本机 Ollama / LM Studio（探活 11434/1234）→ 一键填入端点；
     未安装时给出安装指引而不是报错。
  2. **端点模型列表拉取**：`GET /models` 拉取本地端点真实模型清单，替代手输模型名。
  3. **离线可用性矩阵**：逐项确认哪些功能在断网时可用（mock 内核 / 本地模型内核 / 技能 /
     记忆 / 调度 / 回放）并在文档中给出矩阵——「本地优先」是可核验的矩阵，不是口号。
  4. **运行时自包含**：打包时内置 dsh 运行时与（可选）小型本地模型，做到「装完就能跑」
     的离线版；体积与下载策略单独评估。
  5. **降级策略**：官方端点不可达时如实提示并可一键切回本地端点，不静默失败。
  6. **用量口径**：本地模型 costCny 恒 0，用量面板区分「云端花费」与「本地调用」。
  7. **多模态本地模型**：vision-exp 模型（内核已公布 `deepseek-v4-flash-vision-exp`）与
     图片附件通道（ACP resource_link）的组合验证。

---

## 一、当前状态（截至 M2-I）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 POC | ✅ 100% | 壳 + 内核子进程 + 单会话 + 流式输出 + 工具可见 |
| M1 MVP | ✅ 100% | 多会话/工作区/Diff 审阅/逐 hunk 授权/终端/设置持久化/回放分叉/打包 |
| M2 V1 | 🔄 约 90% | ✅ 技能系统全链路（审计→注入→面板）· 三层记忆 · 自动化调度 · 连接器管理（MCP 走内核通道）· 用量面板（M2-J）· 浏览器自动化（M2-H）· Office 生成与 OFD 原生读取（M2-I） |
| M3 生态期 | ⬜ 0% | 见第四节 |

验证基线：`npm run verify` 18 套中 17 套全绿（diff / tools 19 / replay 29 / smoke 26 / partial 13 /
terminal 22 / acp 37 / real-dsh 15 / skills 59 / skillctx 24 / memory 38 / schedule 68 /
connectors 42 / usage 27 / browser 76 / office 130 / modelcfg 31）；`real-dsh-mcp` 本机 3/8，已用 `git stash`
在改动前的基线上复现同样的失败，属环境性问题（见 `docs/CONVENTIONS.md` 的「已知的环境性失败」）。
**它已被排到 verify 链尾** —— 它 exit=1 会中断 `&&` 链，排中间会让其后的套件（如 modelcfg）
静默不跑（M2-H 轮发现并修正，见 DEVLOG）。

**`wip/m2-h` 半成品已并入 main（M2-H 完成）**：两个起步文件（`protocol/src/browser.ts` 契约 +
`core-host/src/browser/cdp.ts` CDP 客户端）评审后沿用并大幅扩展，单实例端点共享、六动作统一实现、
MCP 服务、宿主接线、面板与 76 项测试全部补齐。分支可删。

---

## 二、最重要的经验教训（先读这个再规划动手顺序）

**M2-G 的改向**：原计划自写 MCP 客户端，开工前取证发现 dsh 原生有 `dsh-mcp-client`
（服务器工具以 `mcp__<name>__<tool>` 注册进内核），上层重写一套是重复建设。
最终形态：DeepWork 管清单与 UI + 生成 `--patch` 插件配置 + 审批走已桥接的
`session/request_permission`，协议实现全在内核 —— 并且真实 dsh 端到端实测通过（8/8）。

**由此得到一条规则：M2 剩余项与全部 M3 项，动手前先查内核是否已有该能力。**
取证方法：翻 `node_modules/@deepseek-ai/dsh-*/README.md`（每个包都有自述），
或拿 `tools/real-dsh-probe.js` 跑真帧。已知结论：

| 能力 | dsh 侧现状 | 结论 |
|---|---|---|
| 三层记忆 | **无** memory 包（只有会话内 compaction/persona） | 上层自建 ✅（M2-E 已做） |
| 定时任务 | `dsh-schedule` = 会话内提醒（schedule_create 工具，消息送达，无外部通知） | 产品化调度上层自建 ✅（M2-F 已做）；dsh 提醒可作补充通道 |
| MCP 客户端 | `dsh-mcp-client` 原生支持 | 复用内核 ✅（M2-G 已做） |
| 子智能体/专家团 | `dsh-subagent*`（in-process spawn + 实验性 teams） | M3 专家团**复用内核**，上层做角色预设与编排 UI |
| 附件/多模态输入 | `dsh-attachment*`，ACP resource_link 已通 | 图片附件可直接走既有通道 |
| 浏览器 | 无专用包（`dsh-tool-web` 是抓取/搜索，非页面操作） | 上层自建（M2-H） |
| Office 生成 | 无 | 上层自建 ✅（M2-I 已做：生成 docx/xlsx，并原生读 ofd） |

---

## 三、M2 剩余项（仅剩 K；H / J / I 均已完成）

### M2-H 浏览器自动化 ✅ 已完成（2026-09-13）

- **范围**：CDP 驱动系统 Chrome/Edge（不引 Playwright/Puppeteer —— 「装完就能跑」是硬约束；
  Node 22 内置 WebSocket 够用）。6 个 `browser.*` 工具：navigate / content / click / type /
  evaluate / screenshot；BrowserPanel（状态 + 打开网页 + 截图查看）。
- **关键决策**：`--remote-debugging-port=0` 从 stderr 的 `DevTools listening on ws://...` 行解析端口；
  必须带 `--user-data-dir=<home>/browser-profile`（新版浏览器对默认 profile 禁远程调试，且这样不碰用户日常浏览器数据）；
  evaluate 为 danger 档；截图落盘记路径，字节不进事件日志（与终端纪律同源）；
  宿主停用时杀浏览器进程树。
- **续作入口（已用）**：`wip/m2-h` 的两个半成品文件经评审后沿用（质量高：CDP 客户端与端口解析
  已成型），在其上补齐动作层 / 生命周期 / MCP 服务 / 接线 / 测试。
- **落地形态**：`browser/actions.ts`（六动作一处实现，宿主工具注册表与 MCP 服务共用一份）+
  `browser/manager.ts`（懒启动、endpoint 文件共享单实例、失败重连一次、借用人只断开不越权杀进程）+
  `browser/mcp-server.ts`（MCP stdio，模型侧工具名 `browser_navigate` 等下划线形式，绕开
  function-name 禁点号的限制）+ 宿主 6 工具 + `browser.state/open/close` RPC + 壳层截图通道 + 整页面板。
- **判据（已达成）**：`npm run test:browser` 76 项进 verify（真实 Edge 驱动 fixture 页面：
  导航 / 读文本 / 点击 / 输入 / 求值 / 截图 PNG magic bytes / 审批链 / 跨进程单实例复用 /
  进程清理；无浏览器时优雅 SKIP）；`artifacts/ui-browser.png`；DEVLOG 六段。

### M2-J 用量面板 ✅ 已完成（2026-09-13）

- **范围**：跨会话用量聚合面板——usage 事件与 `sumUsage` 早已在协议层，会话 meta 有累计用量；
  面板只做只读聚合：按会话/按日/按模型分组，prompt/completion tokens 与费用。
- **关键决策**：不新建存储，从既有会话存储聚合（新建一份存储 = 两份事实，必然漂移）；
  费用估算的单价表放 config（模型价格会变，硬编码即腐烂）。
- **落地形态**：`usage.summary` RPC + 纯函数 `summarizeUsage`（日切函数注入，与 `nextFire` 同纪律）+
  整页用量面板（汇总卡 / 按日柱状图 / 按模型表 / 按会话列表 / 单价表编辑）；
  模型归属按 `run.started.model` 而非会话当前模型（会话中途换模型时后者会答错）。
- **判据（已达成）**：`npm run test:usage` 27 项进 verify（**分组之和 = 总数**是核心等式）；
  `artifacts/ui-usage.png`；DEVLOG 有六段记录。

### M2-I Office 生成 + OFD 原生读取 ✅ 已完成（2026-09-13）

- **范围**：`office.docx` / `office.xlsx` 工具，落盘工作区，confirm 档审批；外加 `office.read`
  原生读取（safe 档）——**docx / xlsx / ofd / 纯文本**四类。OFD（GB/T 33190-2016）是国标归档格式，
  属于「不引第三方库也能读」的范畴，本轮一并做掉。
- **关键决策（对比原计划的两条路线后选了第三条）**：原计划在「纯 JS 库（`docx` 包）」与
  「手写 store 模式 zip」之间二选一，实际选了 **(c) 手写 zip + 手写最小 OOXML**：
  docx/xlsx 本质就是 zip + xml，而 zip 的 deflate 可以直接借 Node 内置 `node:zlib`
  （**零第三方依赖**这条硬约束因此不牺牲压缩率）。落地为 `office/zip.ts` 手写
  local header / central directory / EOCD，`zipWrite` 用固定 DOS 时间戳保证**同一输入产出同一字节**
  （可复现，回放类断言才立得住）。
- **二进制输出的审批形态**：写类工具一律要先预览再授权，但 docx/xlsx/ofd 是二进制，
  拿不出「文本 diff」。做法是**预览与执行共享同一份 ctx 快照**，把包内文字抽出来
  （`extractDocxText` / `extractXlsxText` / `extractOfdText`）当作预览内容 ——
  授权时看到的那段文字，就是落盘文件里真正能读出来的那段文字，两者同源同快照。
  「预览的是 A、写下去的是 B」这条最坏的失败形态因此被结构性排除。
- **OFD 读取的要点**：文字在 `Pages/Page_N/Content.xml` 的 `TextCode` 节点里，
  **不能按 XML 顺序拼**（生成器写出的顺序与实际阅读顺序无关）——必须按坐标排：
  Y 先聚成行（容差聚类），行内按 X 升序，再按中英混排规则拼接（CJK 之间不加空格、西文之间加一个空格）。
  只取 `TextObject` 里的字，`Annot`（批注/水印）一律排除。
- **落地形态**：`office/zip.ts`（zip 编解码 + CRC32 + zip-bomb 上限）、`office/xml.ts`
  （转义/反转义，含十进制与十六进制数字实体）、`office/text.ts`（中英混排拼接）、
  `office/docx.ts`（Markdown 子集 → 8 个必备部件）、`office/xlsx.ts`（二维数组 → 共享字符串 + 冻结表头）、
  `office/ofd.ts`（定位 → 解坐标 → 拼行）、`office/read.ts`（分发 + 体积上限 + 二进制探测）
  + 宿主 3 工具（`registerOfficeTools` 常驻注册，不像浏览器那样需要依赖门）。
- **判据（已达成）**：`npm run test:office` **130 项全绿**进 verify，其中含一条**独立实现校验**——
  另起一个 Python 进程用 `zipfile` + `xml.etree`（与本项目无关的第二实现）复核生成的包：
  CRC / XML 良构 / `[Content_Types].xml` 覆盖 / rels 目标可达；OFD 样本则由 **Python 脚本生成**
  （不是用我们自己的写包器造的），保证「读」这一侧面对的是外部生产者。
  **真实软件打开**：`artifacts/ui-office.png`（WPS 打开 `report.docx`，标题/正文/表格/自定义样式齐全）、
  `artifacts/ui-office-sheet.png`（WPS 表格打开 `budget.xlsx`，工作表「预算执行」、表头加粗、数字右对齐）。
  用 Electron 的 `desktopCapturer` 按**窗口标题**抓文档窗口（不抓整屏，避免拍到别人家的界面）。DEVLOG 六段。

### M2-K 自动更新（最后做：依赖外部发布通道）

- **范围**：electron-updater 接线 + 更新检查 UI + 版本策略。
- **关键决策**：没有发布服务器就做不全——本地可落地的部分是「接线就绪 + 模拟 feed 验证」
  （本地起静态服务器伪装更新源，全流程走通下载→校验→提示→重启），真实发布通道属运维决策。
  如实标注，不假装「自动更新已完成」。
- **判据**：`test:update`（模拟 feed 全流程）；DEVLOG 写明与真实通道的差距。

---

## 四、M3 生态期规划（按「可本地验收」分两档）

### A 档：可本地完整落地

1. **专家团（复用内核 subagent）**：角色预设（提示词 + 技能/连接器绑定 + 审批档位）+
   编排 UI（主 Agent 创建成员、任务拆分、进度跟踪）。动手前先取证 `dsh-subagent*` 的
   ACP 暴露面——teams 是实验特性，acp profile 是否暴露需实测，不行就退到「预设角色一键开会话」。
2. **插件市场（本地目录市场）**：市场 = 一个索引文件（名称/描述/版本/来源路径或 URL）+
   浏览 UI；安装复用既有审计链（技能走 skills.install，连接器走 connectors.add）。
   托管型市场需服务器，契约预留 `source.url` 字段。
3. **发布分享（本地自包含导出）**：会话导出为自包含 HTML（事件日志内嵌 + 内联渲染，
   双击即回放——归约器在 protocol 层是纯函数，导出页直接打包它）；在线预览链接需服务器，
   属 B 档。
4. **多模态（输入侧）**：图片附件经 ACP resource_link 已通，补 UI 预览与真实模型实测；
   图像/视频**生成**需外部服务，属 B 档。

### B 档：需外部条件，本轮只做契约与标注

5. **团队协作与云同步**：需服务端。本地可做：记忆/技能/连接器的导出导入（迁移换机场景真实存在），
   协作协议契约设计。DEVLOG 里明确标注「不可本地验收」。
6. **在线分享链接、图像/视频生成、计费遥测**：标注为「依赖外部服务，未启动」。

### M3 判据总口径
A 档各项：契约 → 实现 → 测试进 verify → 截图 → DEVLOG。
B 档各项：契约草案 + DEVLOG 明确「为什么本地验不了、需要什么条件」，**不允许把 B 档写成已完成**。

---

## 五、各轮 DEVLOG 遗留债汇总（插空偿还）

| 来源 | 遗留 |
|---|---|
| M2-C | 技能市场 URL 安装源；审计规则无白名单机制（误报无法标记「已知合法」） |
| M2-D | Composer 的 `/` 技能名补全 |
| M2-E | 内核自动写记忆（经 MCP 把 memory 工具暴露给内核——M2-G 已打通通道，可做）；30 天归档是机械合并不是语义蒸馏；记忆条目无去重 |
| M2-F | 桌面通知（Notification API）；触发精度 ±30s；交付物无独立归档通道 |
| M2-G | 连接器 HTTP 传输；内核侧连接状态不可见 |
| M1 | Trajectory 视图逐事件分叉；分支对比视图 |

---

## 六、每轮开发的固定流程（不变）

1. **取证**：涉及内核能力的，先查 dsh 包自述或跑真帧，不凭猜测动手。
2. **契约先行**：先改 `packages/protocol/src/`，再改实现。
3. **测试随代码**：新能力配新 `tools/*.js`，挂进 `verify`；断言落真实出口（磁盘字节/事件流/真实进程），不写「应该没问题」。
4. **截图**：`tools/capture.sh` 加场景，产物 `git add -f` 入库。
5. **DEVLOG 六段**：目标/改动/验证（真实命令与数字）/踩坑与修复/遗留/下一步；更新里程碑快照表。
6. **分模块 commit**：feat(protocol)/feat(core-host)/feat(desktop)/test/docs；提交前 verify + demo 全绿。
