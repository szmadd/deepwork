# DeepWork 后续研发规划

> 写于 M2-G 收口时（2026-09-12/13），2026-09-13 增补「战略方向」一节；同日 M2-H 完成后更新当前状态；
> 同日 M2-I（Office 生成 + OFD 原生读取）完成后再次更新。
> **2026-09-14 收口一轮**：按「本机没有后端平台」这一硬约束重划口径 —— 把需要服务端的项**显式挂起**
> （而不是留在表里显示"未完成"）、补录需求矩阵里 4 条从未被任何里程碑收录的漏项（第七节）、
> 确立**开发主线 = DeepSeek 官方端点**（局域网 OpenAI 兼容端点降为可选路径）。
> **2026-09-15 增补**：新增第八节「运行时自包含与安装体检」—— 随包 Python 3.12、
> 自定义 pip 源、安装前环境检查，来自离线局域网部署场景的正式需求。
> 用途：下一次会话（或下一位开发者）拿来就能开工，不需要重新考古。
> 每项都带「范围 / 关键决策 / 判据」，判据口径与 DEVLOG 纪律一致。
>
> 相关文档：[需求与架构方案](./深边AI-Work-开发需求与架构方案-v1.0.md) · [DEVLOG](./DEVLOG.md) · [CONVENTIONS](./CONVENTIONS.md)

---

## 〇、模型接入口径（2026-09-14 重划，取代原「本地模型优先」）

**原口径（2026-09-13）**：产品目标是"用本地化模型运行、脱离互联网也能工作"，因此把
Ollama `:11434` / LM Studio `:1234` 一类的本机端点当作主路径，并规划了本地模型向导、
运行时自包含（打包内置小型模型）等项。

**新口径（2026-09-14）**：本机（开发与验证环境）**没有后端平台，也不使用 Ollama / LM Studio**。

- **开发主线 = DeepSeek 官方端点。** 开发、验证、验收截图一律以官方端点为准；
  `modelEndpoint.kind = 'official'` 是默认态。
- **可选路径 = 局域网自建 OpenAI 兼容端点**（GPUStack 一类的推理平台，形如 `http://<host>:<port>/v1`）。
  该路径**只在官方端点不可用时才排期验证**，代码上只需保持"任何 OpenAI 兼容端点都能接"这条不变式。
- **删除**：本地模型向导（探活 `11434`/`1234`）、运行时自包含内置小型本地模型
  —— 前提已不成立，保留在清单里只会误导下一位开发者。
- 模型配置（`official` / `custom` 两种 kind + 凭据分文件存放 + 界面只显掩码）已落地，形态不变。

**仍然成立的接入不变式**（改端点相关代码时必须守）：

1. 端点差异只允许出现在 `packages/core-host/src/models/endpoint.ts` 的覆盖补丁里 ——
   它就是"把产品配置翻译成 dsh 启动补丁"的唯一出口。
2. 自定义端点走 `--patch` 覆盖 `llm-deepseek` 条目（**不用** `settings.yaml`：它是热重载的，
   与 `session/new` 公布模型目录之间存在竞态，实测会间歇性拿到内置目录）。
3. 凭据**按请求解析**（`dsh-credentials`），不存在启动竞态；key 明文永不离开宿主进程。

**随之调整的后续清单**（按依赖排序）：

1. **端点模型清单拉取**：🔶 **部分落地（2026-09-15）**——设置页「测试连接」对
   `GET /v1/models` 发真实请求，回端点模型清单并可**点选回填**模型名；
   全自动「目录直接吃 /v1/models 替代手输」未做（modelCatalog 的 endpoint 分支语义不变）。
2. **多模型与模型路由（FR-10.2 / 第七节）**：当前自定义端点只透传 **单个**模型且
   `contextWindow` 写死 `131_072`；GPUStack 一类平台上通常不止一个模型。
3. **模型来源以内核为准**：`models.ts` 的硬编码清单改为吃内核 `session/new` 的
   `configOptions` 真帧（取证工具 `tools/real-dsh-probe.js`），避免"界面显示的模型 ≠
   实际生效的模型"（`docs/CONVENTIONS.md` 已有此记录，见第七节）。
4. **连通性自检与降级**：🔶 **部分落地（2026-09-15）**——「测试连接」把
   服务没起 / 地址错 / key 无效 / 少了 /v1 四层原因在配置时分开（`models.testEndpoint`）；
   **开跑前模型守卫**：目录查无本轮模型时 run 在宿主侧直接失败并给出可选清单，
   不再发给端点换一句 "Model not found"。端点不可达时仍守既有约定：**不静默降级到 mock**。
5. **用量口径**：自建端点上的模型无单价 → `costCny` 恒 0，面板区分「云端花费」与「内网调用」。
6. **离线可用性矩阵**：口径从"无本地模型"改为**"断公网"** —— 逐项核哪些功能在断网时仍可用
   （mock 内核 / 官方端点需公网 / 技能 / 记忆 / 调度 / 回放）。矩阵是可核验的，不是口号。
7. **多模态（输入侧）**：vision-exp 模型（内核已公布 `deepseek-v4-flash-vision-exp`）与
   图片附件通道（ACP `resource_link`）的组合验证；**生成**侧属挂起项。

---

## 一、当前状态（截至 2026-09-14）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 POC | ✅ 100% | 壳 + 内核子进程 + 单会话 + 流式输出 + 工具可见 |
| M1 MVP | ✅ 100% | 多会话/工作区/Diff 审阅/逐 hunk 授权/终端/设置持久化/回放分叉/打包 |
| M2 V1 | ✅ 收口 100% | ✅ 技能系统全链路（审计→注入→面板）· 三层记忆 · 自动化调度 · 连接器管理（MCP 走内核通道）· 用量面板（M2-J）· 浏览器自动化（M2-H）· Office 生成与 OFD 原生读取（M2-I）· **M2-K 自动更新显式挂起**（需发布通道） |
| **M2+ 收口后补强** | ✅ 100% | 模型目录以内核 `session/new` 真帧为准（删掉写死的四条）· 默认模型由用户自选 · 接出 `reasoning_effort` · **接出内核上报的上下文占用（ACP `usage_update`）** · **用量口径如实化**（内核没上报的部分不再显示成 0）（2026-09-14 第二 / 第三轮，见 DEVLOG） |
| M3 生态期 | ⏸ 暂缓 | 已决策暂不启动（需后端平台），见第四节。**不计入完成度** |

**挂起项**（不是"没做"，是"已决策暂不做"）：M3 全部、M2-K 自动更新、崩溃上报/遥测/计费、
多模态**生成**。共同原因是**都需要一个后端平台**。详见 DEVLOG 快照表的「挂起项」小节。

**需求矩阵漏项**：4 条（FR-3.5 沙箱 / FR-3.8 图表 / FR-10.2 模型路由降级 / FR-10.5 崩溃上报）
**既不在 M2 剩余、也不在 M3** —— 已补录于第七节。其中 **FR-10.2 的「模型 × 思考档」一半已落地**（见下）。

验证基线：`npm run verify` **26 套**（diff / tools 19 / replay 29 / smoke **30** / partial 13 /
terminal 22 / acp **40** / real-dsh 15 / skills 59 / skillctx 24 / memory 38 / schedule 68 /
connectors 42 / usage **35** / browser 76 / office 130 / chart 126 / modelcfg 124 /
**sandbox 62** / **sandbox-e2e 31** / **runtime 21** / **installer 29** / **pip 31** / **preflight 28** /
**routing 39**）；
`browser-test` 在本会话环境里起不来 Edge 无头实例（`提前退出（code=0）`），属既有环境问题，
其后的套件按上面清单单独跑过。
`real-dsh-mcp` 的**结果不稳定**：2026-09-16 两轮实测分别是 8/8 与 3/8，而 3/8 那轮在
**改动前的基线树（`bfd0710`）上同样复现** —— 所以**绝不拿它的单次结果当回归判据**，
要判断回归必须改动前后各跑一次（见 `docs/CONVENTIONS.md`）。
**它已被排到 verify 链尾** —— 它 exit=1 会中断 `&&` 链，排中间会让其后的套件（如 modelcfg）
静默不跑（M2-H 轮发现并修正，见 DEVLOG）。**新增套件一律插在它之前。**

> **基线项数变更史（每次都要来自当场那次命令的输出）**：
> `modelcfg 31 → 32`（2026-09-14 第二轮发现 stale 偏差，上一轮改了断言没回头改基线）→
> **80**（第二轮：目录解析层 +48）→ **92**（第三轮：真内核上下文容量 6 条 × 连跑两轮 = +12）→
> **109**（2026-09-15 内网三连修：三方一致性 +3、模型守卫 +5、连通性 +9）；
> `smoke 26 → 27`（第二轮）→ **30**（第三轮：事件流 → 会话 meta +3）；
> `acp 37 → 40`（第三轮：`usage_update` 映射 +3）；`usage 27 → 35`（第三轮：覆盖率 +8）；
> `modelcfg 109 → 124`（2026-09-15 第四轮：端点「配置改了没重启」的守卫 +15）；
> **新增 `sandbox 21`**（2026-09-15 第五轮：对照组 2 + runner 真帧 3 + 解析规则 8 +
> 内核装配真帧 3 + 宿主 status 哨兵 5）→ **`sandbox 32`**（同日晚第六轮：拒绝方言解析 +11，
> 含 shell 族方言边界 1 与「mock 模拟帧 === 解析层真帧副本」防漂移 1）；
> **新增 `sandbox-e2e 17`**（第六轮：fixture 自检 3 + 对照组 3 + 反证组 1 + 判据 3 +
> 越界对照 1 + 解析器在真帧上的自证 6）；
> **`sandbox 32 → 41`**（2026-09-16 升级链路取证轮：升级申请解析 +9，同轮 `sandbox-e2e 17 → 31`）
> → **`sandbox 41 → 62`**（2026-09-17 第七轮尾项 / FR-3.5 模式切换入口：config 来源解析 +7、
> 换档入口（真宿主重启内核）6、界面接线读源码 6）；
> **新增 `routing 39`**（2026-09-17 / FR-10.2 后半：失败分类 7 + 缓存与措辞 15 + 宿主调用点 5 +
> 模式路由 6 + 界面接线 4，另 2 条是枚举覆盖断言）。
>
> 这套数**只记增删与来源，不做跨套求和**：求和的中间口径（哪些算新增、哪些算替换）
> 没有落成文字，加出来的数谁也验不了。要引用数字就引当轮的逐套输出。

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
| MCP 客户端 | `dsh-mcp-client` 原生支持；**真帧 `mcpCapabilities.http = true`** | 复用内核 ✅（M2-G 已做）；**HTTP 传输在协议层已被内核支持**，M2-G 的 stdio-only 遗留可开工 |
| 子智能体/专家团 | `dsh-subagent*`（in-process spawn + 实验性 teams）；真帧工具表里有 `subagent` / `subagent_fork` / `list_agents` / `send_message` / `interrupt_agent` | M3 专家团**复用内核**，上层做角色预设与编排 UI |
| 附件/多模态输入 | `dsh-attachment*` 存在，**但真帧 `promptCapabilities.image / audio / embeddedContext` 全为 `false`** | **修正 2026-09-13 的结论**：图片附件在 ACP 层**不通**，不是"可直接走既有通道"。vision 模型在模型目录里，但协议侧未开放图像输入 |
| 浏览器 | 无专用包（`dsh-tool-web` 是抓取/搜索，非页面操作） | 上层自建 ✅（M2-H） |
| Office 生成 | 无 | 上层自建 ✅（M2-I 已做：生成 docx/xlsx，并原生读 ofd） |
| **沙箱** | **有**：`dsh-sandbox` / `dsh-sandbox-local` / `dsh-sandbox-policy` / `dsh-sandbox-windows-acl` / `dsh-fs-sandbox` / `dsh-bash-sandbox` / `dsh-pwsh-sandbox`；`acp` profile 的 `--dump-config` 证实**已装配**（含 `permission-presets`），win32 上默认 `workspace-write` 且实测生效（区外写 EPERM） | ✅ **已取证并复用**（2026-09-15，FR-3.5 第一期）：**确实不必自建**。产品此前从未设置 `DSH_PERMISSION_MODE`，本轮改为显式声明并接到界面上；见第七节 FR-3.5 |
| **模型选择与思考档** | **有**：`session/new` 的 `configOptions` 公布 `model`（select）与 **`reasoning_effort`**（off/low/high/max，默认 high） | ✅ **已接出**（2026-09-14 第二轮）：目录以内核真帧为准、默认模型用户自选、推理档位可设；断言落在**端点实际收到的请求**（`reasoning_effort=max` 已实测到达） |
| 会话导出 | `dsh-session-log-export` / `dsh-session-log-deepseek` | M3 挂起项的「导出为自包含 HTML」可先取证是否可以复用 |
| 任务与计划 | 真帧工具表含 `todo_write` / `create_goal` / `get_goal` / `update_goal` / `exit_plan_mode` / `workflow` / `ralph` / `job_*` | 内核原生，**UI 完全未呈现**；做任务/计划面板时先看这里，别自建 |

> 真帧还给出两条**必须修正的既有表述**（2026-09-14，**均已于同日第二轮修掉**）：
> 1. **模型显示名与上下文长度是自编的，不是内核给的。** 内核真帧的显示名是 `DeepSeek-V41-Flash` /
>    `DeepSeek-V4-Flash-Vision-Exp`，而 `models.ts` 写的是 `DeepSeek V4.1 Flash` / `DeepSeek V4 Flash Vision（实验）`；
>    `contextWindow: 256_000` 在内核帧里**根本没有对应字段**。这些值此前"看着合理"地留了下来。
>    → **已修**：官方清单改由真帧解析（`models/catalog.ts`），写死的四条从 `models.ts` 删除；
>    `contextWindow` 改为可选，只有自定义端点用户填了才存在。
> 2. **产品默认模型与内核默认不一致。** 内核 `model` 的 `currentValue` 是
>    `["deepseek-official","deepseek-v4-flash"]`（即 V4-Flash），而项目 `DEFAULT_MODEL = 'deepseek-flash'`
>    （即 V41-Flash）。两者不同源，谁对需要一次决策而不是默认。
>    → **已修**：该决策交给用户 —— `config.defaultModel` 空串 = **跟随内核当前默认**
>    （设置页显示"当前：<内核说的那个 id>"），`DEFAULT_MODEL` 降级为"完全无清单时的最后兜底"。
>
> **第二轮新拿到的三条真帧事实**（2026-09-14，`test:modelcfg` 第 4 段的端点侧观测）：
>
> 1. **自定义端点补丁不会移除内核的默认模型条目。** 补丁把 `llm-deepseek` 的 models 换成两个自定义 id 之后，
>    内核公布的目录仍是 `deepseek-v4-flash / <自定义 1> / <自定义 2>`，且 `currentValue` 仍指向
>    `deepseek-v4-flash`。→ 自定义端点下选「跟随内核默认」，发出的模型名就是 `deepseek-v4-flash`。
>    不是 bug，但设置页必须把"当前跟随的是哪个 id"写出来（已写）。
> 2. **推理档位是请求体顶层字段**：端点收到 `reasoning_effort: "high"`（伴随 `thinking: {type:"enabled"}`）。
>    → 「档位生效」从此可观察，也是本轮断言的参照物。
> 3. **`max_tokens` 恒为 256000，与补丁里的 `contextWindow` 无关**（补丁填 131072，请求仍是 256000）。
>    → 「contextWindow 控制压缩时机」**没有证据**，相关注释与界面文案已降级为"实际影响未证实"。
>    **不要**据此调整 `DEFAULT_ENDPOINT_CONTEXT_WINDOW`。
>
> **第三轮真帧（2026-09-14，ACP 侧观测 + 内核包 README）**：
>
> 1. **`max_tokens` 的来源查到了（修正上一轮"来源未知"）**：`@deepseek-ai/dsh-llm-deepseek`
>    的配置项 `maxTokens` 默认 `256,000`（见该包 README 的配置表），与模型条目的 `contextWindow`
>    无关。请求体里那个数就是它。**压缩时机是否与 `contextWindow` 相关，仍无证据。**
> 2. **内核确实上报上下文占用**：ACP `usage_update` 帧 `{used, size}`，每条提交的助手消息后各报一次。
>    `size` = 内核认定的容量 —— 官方模型取内核目录值（实测 1,000,000）；自定义端点模型取
>    **我们在补丁里填的 `contextWindow`**（补丁填 111111 ⇒ `size` 为 111111；切到填 222222 的模型 ⇒ 222222）。
>    → 这同时把"用户填的 `contextWindow` 到底有没有生效"从推测变成了**可验证的事实**。
> 3. **替身端点必须回 `usage` 帧，否则会得出反向的假结论**：dsh 的 llm 适配器带
>    `stream_options.include_usage=true` 请求用量，而内核**只在拿到 usage 时才产生 `usage_update`**。
>    改前 `tools/fixtures/openai-stub-llm.js` 从不回 usage，于是第一次取证看到的是"内核不上报
>    上下文占用" —— 一个**由测试替身造成的假事实**（修好替身后真帧立刻出现）。教训记在 DEVLOG。
> 4. **token 与费用不走 ACP**：ACP 只把"标准语义更新"放上线（提交后的消息与思考、工具生命周期、
>    配置、上下文占用），provider 原始增量与 DSH 呈现数据不出内核。
>    → 真实内核下用量面板拿不到 token 与费用，只能**如实说明**（本轮已做，见 DEVLOG）。

---

## 三、M2 剩余项（H / J / I 均已完成；K 已决策挂起）

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

### M2-K 自动更新 ⏸ 挂起（2026-09-14 决策）

- **范围**：electron-updater 接线 + 更新检查 UI + 版本策略。
- **为什么挂起**：没有发布服务器就做不全。**挂起 ≠ 没做** —— 若后续决定做，
  本地可落地的部分仍只有「接线就绪 + 模拟 feed 验证」（本地起静态服务器伪装更新源，
  全流程走通下载→校验→提示→重启），真实发布通道属运维决策。
  届时如实标注，不假装「自动更新已完成」。
- **重启条件**：有了发布通道（对象存储 / 静态站点 + 版本清单）或决定买现成分发服务。
- **判据**（重启后）：`test:update`（模拟 feed 全流程）；DEVLOG 写明与真实通道的差距。

---

## 四、M3 生态期规划 ⏸ 暂缓（2026-09-14 决策）

> **状态：暂不启动。** 本机没有后端平台，而 M3 的 A 档各项虽号称"可本地完整落地"，
> 其产品价值都建立在"有服务端"之上（市场索引、在线分享、团队协作）。
> 因此整节降级为**存档**：保留规划与判据，等有了后端平台再重启。
> **重启时先读本节 + 第七节**，并按第二节的取证规则核对 `dsh-subagent*` 的 ACP 暴露面。

按「可本地验收」分两档：

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

> **口径**：下表的债**都不依赖后端平台**，随时可做。依赖后端的项已移入「挂起项」，不在本表。

| 来源 | 遗留 |
|---|---|
| M1 | ✅ **逐事件分叉 + 分支对比视图已完成（2026-09-17）**：`forkSession` 改为按事件 seq 切片（不再吸附到 run 边界），继承事件是「记录」而非模型上下文；分支对比只比**事件流里的 FileDiff**（fork 共享工作区，比磁盘永远是空），每个文件取最后一次变更，两路来源（`tool.started.call.diff` 与 `approval.requested.request.diff`）都收；`tools/branch-test.js` **30 项**进 verify |
| M2-C | 🔶 **技能市场 URL 安装源已落地（2026-09-17）**：按内容判源（PK 头 vs `---` frontmatter），手写零依赖 zip 解压器（防路径穿越 / 符号链接 / zip64 / 炸弹），`installFromUrl` 走与本地安装同一条审计+落盘路径，源 URL 记进 manifest。**审计规则无白名单机制（误报无法标记「已知合法」）仍未做** —— 留在此行 |
| M2-D | ✅ **Composer 的 `/` 技能名补全已完成（2026-09-17）**：契约 `skillCommandCompletion`/`applySkillCommandCompletion`，插入 `/name `（**尾随空格是内核 `EXPLICIT_RE` 的硬要求**），`tools/completion-test.js` **29 项**进 verify（含与内核正则 `^\/([a-z0-9][a-z0-9-]*)(?=\s\|$)` 的对齐断言） |
| M2-E | ✅ **内核自动写记忆已完成（2026-09-17）**：与 chart/browser 同形，memory 做成独立 stdio MCP 服务（`deepwork_memory`，工具 `memory_write`/`memory_read`），与 UI 面板**共用同一个 `MemoryStore`**（单一事实来源）；画像（profile）对内核**写禁**（`MEMORY_WRITE_LAYERS=[user,workspace]`），写入**复用 `MemoryStore.add` 的预算闸**。**30 天归档仍是机械合并不是语义蒸馏；记忆条目仍无去重** —— 留在此行 |
| M2-F | ✅ **桌面通知已完成（2026-09-17）**：`notificationFor(event, ctx)` 纯函数，判据是 **`!(windowVisible && isCurrentSession)`** —— 应用在前台且正是当前会话时不打扰；覆盖 `schedule.fired`/`run.completed`（failed/aborted 分叉）/`run.failed`/`run.notice`（**仅 warn**）；标题 ≤60、正文 ≤160 对**整句**裁剪；`shown` 语义是「已交给系统」而非「用户看见了」。`tools/notify-test.js` **29 项**进 verify。**触发精度 ±30s、交付物无独立归档通道** —— 留在此行 |
| M2-G | 🔶 **连接器 HTTP 传输已落地（2026-09-17）**：`dshTransportOf` 把 `http` 映射到内核的 `streamable-http`，配置改判别联合、`ConnectorStore.add` 按传输分别归一化（**防字段串台**）；补丁不再带 command/args/env。`tools/connector-test.js` 扩到 **64 项**进 verify。**内核侧连接状态不可见** —— 留在此行 |
| M2-H | 浏览器无等待条件 / 网络拦截 / 多标签；无元素级截图；不支持接入用户自己开的调试端口浏览器 |
| M2-I | Markdown 子集不含图片 / 脚注 / 页眉页脚 / 页码；OFD 只读不写不渲染（印章签名未解析）；xlsx 单工作表、无公式图表、列宽固定 |
| 界面 | ✅ **深浅主题切换器已完成（2026-09-17）**：契约 `resolveTheme(mode, prefersDark)`；`data-theme` 挂在 `document.documentElement`（**不是 body** —— 原生控件跟随 `color-scheme`）；CSS 变量抽成语义色；**默认 `theme: 'light'`**（原为 `dark` 却从未被消费，接了切换器会静默翻转整个 UI）。`tools/theme-test.js` **24 项**进 verify（含「每个 `:root` 变量在深色下都有覆盖」的完整性断言） |
| 测试 | ~~`real-dsh-mcp` 3/8 的环境性失败根因未定位~~ → **2026-09-16 复测 8/8**（改动前后两棵树皆然），旧记录不再复现、原因未定 → **2026-09-17 又复现 3/8**，且这一次**当场做了对照**：`git stash -u` 回到 HEAD 干净树、重建、连跑，**同样是 3/8**，与本轮八项改动无关。失败形态稳定（`start()` 握手 ok、run completed，但模型工具表里**没有任何 `mcp__` 工具**，即 fake server 未被注册；无插件加载报错）。该套件仍是真实 MCP 通路唯一哨兵，**不要摘**，须留在 verify 链尾 |
| 测试 | ⚠️ **`npm run verify` 在本沙箱跑不到底**：`browser-test`（Edge 起不来，code=0）与链尾的 `real-dsh-mcp`（上一条）都是环境性红，`&&` 链**在 browser-test 处即中断** —— 排在它之后的 office/chart/modelcfg/sandbox/sandbox-e2e/runtime/installer/pip/preflight/routing/theme/notify/branch/completion/real-dsh-mcp **不会被执行**。2026-09-17 已单独补跑这一段并全绿（见 DEVLOG）。**不要把「verify 输出停在 browser-test」误读成「后面全过了」** |
| 界面 | **沙箱相关 UI 的渲染截图未产出**（升级审批弹窗的 `DEEPWORK_MOCK_SANDBOX_ESCALATION` mock 帧与 capture 场景已就绪、安全页的三档选择器也已接线，但缺 Electron 二进制跑不了 capture）；这两处的渲染证据目前都只到读源码断言 |
| 仓库 | `wip/m2-h` 半成品分支已并入 main，可删（未删，留给用户决定） |
| 运维 | 已接：无。待补：**CI**（`npm run verify` 仍靠人工）、**远端推送**（`origin` 上 `main` 领先 **17** 个提交）、**版本 tag**（M0/M1 各阶段成果无回滚点） |

---

## 六、每轮开发的固定流程（不变）

1. **取证**：涉及内核能力的，先查 dsh 包自述或跑真帧，不凭猜测动手。
2. **契约先行**：先改 `packages/protocol/src/`，再改实现。
3. **测试随代码**：新能力配新 `tools/*.js`，挂进 `verify`；断言落真实出口（磁盘字节/事件流/真实进程），不写「应该没问题」。
4. **截图**：`tools/capture.sh` 加场景，产物 `git add -f` 入库。
5. **DEVLOG 六段**：目标/改动/验证（真实命令与数字）/踩坑与修复/遗留/下一步；更新里程碑快照表。
6. **分模块 commit**：feat(protocol)/feat(core-host)/feat(desktop)/test/docs；提交前 verify + demo 全绿。

---

## 七、需求矩阵漏项（2026-09-14 补录）

《深边AI-Work-开发需求与架构方案 v1.0》§4 的功能矩阵里，有 4 条需求**从未被任何里程碑收录**：
M2 的剩余清单（H/J/I/K）里没有，M3 的 A/B 两档里也没有。此前 ROADMAP 读不出来它们的存在，
属于规划缺口而不是实现缺口。逐条列在此处，**动手排序时优先看这一节**。

| 编号 | 需求 | 优先级 | 现状 | 判据建议 |
|---|---|---|---|---|
| **FR-10.2** | 模型路由与降级策略（快模型 / 推理模型分工） | **P0** | 🔶 **主干已落地（2026-09-14 第三轮）**：①「模型 × 思考档」接出（目录以内核真帧为准、默认模型用户自选、`reasoning_effort` 实测到达端点）；②**用量口径已如实化**——真实内核不上报 token 与费用 ⇒ 面板按 `coverage` 说明差额而不是显示 ¥0.0000，并把内核上报的上下文占用接出来。**后半已落地（2026-09-17）**：③**按会话模式指定模型**（`config.modeModels`，新建会话时生效；刻意不做「猜任务难度」——那是没有真值的规则，判错时用户无从纠正）；④**端点不可达的如实提示**（探测结论缓存 + 新鲜期 + 换端点作废，开跑时只读不阻塞；`kind` 由 `testEndpoint` 在失败那一刻填，不按字符串猜；**只提示不拦** ← `/models` 不是 OpenAI 兼容端点的强制面） | 判据已达成：`tools/routing-test.js` **39 项**进 verify（失败分类 7 / 缓存与措辞 15 / 宿主调用点 5 / 模式路由 6 / 界面接线 4，另含 2 条枚举覆盖）。沿用既有参照物：**"实际发出的请求用了哪个模型与哪一档"**（`tools/fixtures/openai-stub-llm.js` 的 `requests[].extra`）与 `usage-test` 的 coverage 断言。**未做**：端点不可达时**自动改用**备用端点（本轮定为「只提示、绝不静默换端点」，见 DEVLOG 该轮「为什么优先级是这样」）；按「任务难度」自动分类（已决策不做） |
| **FR-10.5** | 崩溃上报（可关） | **P0** | 无实现；只有 `DEEPWORK_LOG_FILE` 日志落盘 | ⏸ **上报侧需接收端 → 挂起**；本地侧（崩溃捕获 + 日志归档 + 一键导出）可做，判据是"崩溃后能找到一份可提交的日志" |
| **FR-3.5** | 沙箱隔离（容器或进程级，作为 Provider 替换） | P1 | 🔶 **第二期已落地（2026-09-15 第六轮）**，同时**修正旧表述**：此前这一格写的「**无实现**」是错的。取证结论：内核 `acp` profile **本就装配**完整沙箱链（`dsh-sandbox-local` + `-policy` + win32 的 `-pwsh-sandbox` / `fs-sandbox` / `permission-presets`），win32 的 runner 链**只有唯一候选**（直接选择、不探测）⇒ 必然生效，默认 `workspace-write`；而产品**从未设置** `DSH_PERMISSION_MODE`。第五轮接出实际生效口径（`HostStatus.sandbox` + 安全页只读呈现 + `DEEPWORK_SANDBOX_MODE` 覆盖入口）；**第六轮用真内核 + 真 ACP + 真工具 + 真落盘证明该口径真的约束模型的 `write` 工具**（A 对照组写得进 / B1 越界写被拦且 run 未崩 / C `read-only` 连区内也拦 / **D 反证：同一目录在 `danger-full-access` 下写得进**），并把拒绝在界面上讲成人话（`parseSandboxDenial` + 琥珀色卡片 + 升级路径说明）。**默认行为始终未改。** 另修正一条相关认知：宿主自建的「审批三档」（`Guard.assess`）**在真实内核下不会被调用**，且**沙箱拒绝也不走审批**（实测五组审批请求数全为 0）—— 升级由**模型**带 `sandbox_permissions` 主动发起，重试时才弹审批。**第三期（FR-3.5 尾项，2026-09-17）补齐了模式切换入口**：第五轮只做到「只读呈现 + 环境变量旁路」，本轮把档位升级成**设置页里的三档选择**（`config.sandboxMode`），换档 = 存配置 + 重启内核 —— 宿主在 `restartKernel()` 里重新解析（该调用点有专门的哨兵断言，因为「解析函数写对了但没人调」正是本项目栽过的坑），界面如实显示「已保存但内核还没跟上」的中间态，并说明环境变量在时会压住设置里的选择 | 判据已达成：`tools/sandbox-test.js` **62 项** + `tools/sandbox-e2e.js` **31 项**进 verify（第三期新增：config 来源解析、非法环境变量降级而非判死刑、「落盘 ≠ 生效」中间态、重启内核后真的换档、界面接线读源码 6 条）。**未做**：模型升级路径取证（模型真会重试吗）；shell 能力族的拒绝在界面上仍是普通失败（`EPERM` 与真实权限错误不可区分，有意不认） |
| **FR-3.8** | 图表与可视化（生成可交互视图） | P1 | ✅ **已落地（2026-09-16）**，口径已定：**「生成自包含 HTML 图表并预览」**（不引入面板内可视化引擎）。新增工具 `chart.render`（宿主注册 + 内置 MCP 服务 `deepwork_chart`，与浏览器服务同形），图型 bar / line / pie，入参单一事实来源在 `packages/protocol/src/chart.ts`。产物是**手写 SVG + 内联样式**的自包含 HTML（CSP `default-src 'none'`、零脚本、零外链、深浅色随系统），带产物标记供预览弹窗识别并**默认渲染**（`sandbox=""` iframe，可切源码）；数据表随产物以 `<details>` 落盘。规模上限按图型分档，缺测如实回报（折线断开、柱图不画），重复列名加序号，废弃列如实说明 | 判据已达成：`tools/chart-test.js` **126 项**进 verify（契约 / 规格 / 渲染字面量 / 审批链 / 真进程 MCP 往返 / 内核补丁 / **Python 独立实现复核 SVG 良构与无脚本** / 界面接线）。**未做**：图表类型扩展（散点 / 堆叠 / 双轴）、数据源直取 xlsx（当前经 `rows` 传二维数组或 Markdown 表）、导出图片（PNG/SVG 单独落盘） |
| — | **跨平台（macOS / Linux）** | 非功能 | 只出过 Windows NSIS + zip；两端未打包、未验证 | 依赖 CI 与运行环境，**与运维债（§五）同期做**更划算 |

**下一轮建议动手顺序**（全部不依赖后端平台；第 1 项已于 2026-09-14 第二 / 三轮完成）：

1. ~~模型来源以内核/端点为唯一事实（FR-10.2 的前半）~~ ✅ **已完成**（2026-09-14 第二轮）。
   ~~用量口径（内核不上报的部分不许显示成 0）~~ ✅ **已完成**（2026-09-14 第三轮）。
   ~~剩下的 FR-10.2 后半（自动路由与端点不可达时的降级提示）~~ ✅ **已完成**（2026-09-17）：
   后半落到两件事上 —— 按会话模式指定模型、端点不可达的如实提示（只提示不拦），见上表。
2. ~~**FR-3.5 沙箱隔离**~~ ✅ **三期全部完成**（2026-09-15 第五 / 六轮，2026-09-17 尾项）：
   第五轮取证实证内核**本就装配**沙箱链、默认 `workspace-write`；第六轮用真内核端到端
   证明该口径真的约束模型的 `write` 工具（含反证组），并把拒绝在界面上讲成人话；
   尾项补齐**模式切换入口**（设置页三档选择 + 重启内核，见上表）。
   **默认行为始终未改。** 剩余部分（模型升级路径取证）留在上表。
   ~~漏项里**仅剩的不依赖后端项是 FR-3.8 图表可视化**——口径待定（「生成 HTML 图表并预览」
   还是「面板内可视化」），先定契约再写。~~ ✅ **已完成**（2026-09-16）：口径定为
   「生成自包含 HTML 图表并预览」，见上表与 DEVLOG 同轮条目。**至此第「七」节四条漏项里，
   所有不依赖后端平台的项都已清空**——剩下的 FR-10.5 崩溃上报（需接收端）与跨平台打包
   （需 CI 与双端环境）仍按原判据挂起。
3. ~~**遗留债插空**（§五）：桌面通知、Composer `/` 补全、Trajectory 逐事件分叉、主题切换器、
   内核自动写记忆、技能市场 URL 源、连接器 HTTP 传输。~~ ✅ **八项全部落地（2026-09-17）**：
   桌面通知 / Composer `/` 补全 / Trajectory 逐事件分叉 + 分支对比视图 / 主题切换器 /
   内核自动写记忆（MCP 服务）/ 技能市场 URL 源 / 连接器 HTTP 传输。新增
   `tools/theme-test.js`(24) `notify-test.js`(29) `branch-test.js`(30) `completion-test.js`(29)
   `skill-url-test.js`(47) 进 verify，`connector-test` 扩到 64、`memory-test` 扩到 73。
   **未做（如实留档，见 §五各行）**：技能审计白名单、记忆条目去重 + 语义蒸馏归档、
   桌面通知触发精度 ±30s 与交付物归档通道、内核侧连接状态可见性。
   另：本轮改了分叉语义 ⇒ `replay-verify.js` 与契约注释里旧语义断言/描述一并改到新契约。
4. **运维债**（§五末行）：接 CI、推远端、打 tag。

---

## 八、运行时自包含与安装体检（2026-09-15 新增需求）

> 来源：离线局域网部署场景的正式需求。一体化安装包已随包 Node 24 与 dsh
> （2026-09-15 落地，见 DEVLOG 同日条目），本节把同一思路扩展到 Python，
> 并补上两块此前没有规划的部署保障：**安装前环境检查**与**已安装组件的处置策略**。
> 与第〇节第 6 项「离线可用性矩阵」是同一场景的两个侧面：矩阵回答"断网时什么能用"，
> 本节回答"装的时候、装完以后运行时从哪来"。

### 8.1 随包 Python 3.12 运行时

- **现状事实（动手前先读这段）**：产品运行时今天**没有** Python 依赖。全仓唯一的
  Python 消费方是 `tools/office-test.js` 的独立实现校验（缺 Python 时优雅 SKIP，
  它的 `findPython()` 按 `python3` / `python` / 若干写死路径探测）。
  这项需求的真实动机是**面向未来**：离线场景下任何 Python 依赖型能力
  （测试独立校验、未来的 Python 技能 / 连接器 / 文档处理工具）都不再依赖目标机装 Python。
  不要把它描述成"修复现有缺陷"——今天没有缺陷，只有能力缺口。
- **范围**：Python **3.12** 打进一体化安装包 `resources/python-runtime/`，
  应用内所有 Python 调用统一经一个 `resolvePythonRuntime()` 出口，解析顺序与 Node 同构：
  `DEEPWORK_PYTHON_BIN` > 随包 > PATH 系统 Python；命中随包时前置进子进程 PATH。
  extraResources 落 asar 之外（外部子进程要读，同 electron-builder.yml 约束 1/4）。
- **关键决策（待取证，不许凭猜）**：embeddable zip（~10MB，无 pip、默认禁 site-packages，
  要改 `._pth` + get-pip 才能装包）vs 完整便携发行版（体积大但开箱可用）。
  取证项：8.2 的 pip 源需求在 embeddable 形态下的真实成本；未来 Python 技能是否有
  必须完整发行版的硬依赖。**这条取证结论决定 8.1 与 8.2 的落地顺序。**
- **判据**：无系统 Python 的干净环境（可用 PATH 遮蔽模拟）里，`office-test` 的
  Python 独立校验从 SKIP 变 PASS；`npm run verify` 全绿；status 类接口能如实报告
  当前 Python 来源（与 `runtimeSource` 同纪律）。

### 8.2 自定义 pip 源

- **范围**：设置页新增 pip 源配置（`index-url`，必要时 `trusted-host`），落 `config.json`；
  pip 调用统一出口在命令行注入 `--index-url` 等参数 —— **不写目标机的 `pip.ini`**，
  不污染用户全局环境（与"不动系统环境"的处置策略同源，见 8.4）。
- **关键决策**：未配置时不伪造、不兜底到公网 PyPI 之外的黑盒 —— pip 自己走默认源，
  离线机器上如实报错；局域网典型形态是内网镜像（devpi / Nexus / 静态目录），
  配置界面文案要按这个场景写，而不是按"换个国内镜像"写。
- **判据**：配置后 pip 的安装请求**实际打到自定义源** —— 本地起静态目录模拟源做断言
  （与 `tools/fixtures/openai-stub-llm.js` 同一思路：断言落在"请求真的到了哪"）。

### 8.3 安装前环境检查（前提体检）

- **范围**：安装 / 首启前检查前提是否符合，报告分两级 ——
  **阻断**（装不下去或跑不起来：OS 架构非 x64、目标目录无写权限、磁盘空间不足、
  随包运行时文件缺失/被 AV 拦截）与**警告**（能力降级但可用：系统无浏览器则
  browser 面板不可用、未配 pip 源则 Python 包装不了）。
  报告必须逐项指出哪不符、怎么办，不允许"装完打不开也不知道为什么"。
- **关键决策**：两层形态 —— NSIS 安装脚本内嵌检查（装前拦阻断项）+
  首次启动向导（跑前全量查，含警告项）。检查逻辑抽成独立模块，
  既被安装器/首启调用，也能被 `tools/` 脚本直接跑 —— 先进 verify，再进安装包。
- **判据**：人为制造不满足项（无权限目录、PATH 遮蔽、删一个随包文件），
  体检报告逐项命中且建议可行动；`test:preflight`（或并入既有套件）进 verify。

### 8.4 已安装组件的处置策略（覆盖 / 复用 / 并存）

> 用户原话："node、python，以及本身已经安装过的，也要考虑是覆盖还是怎样"。
> 这一条是安装器语义，定错了会动到用户机器上不属于我们的东西。

- **应用本体**：NSIS 同 appId 重装 = **修复式覆盖**（同版本允许、升级覆盖）；
  **降级安装要明确提示**而不是静默覆盖。用户数据 `~/.deepwork/`（会话/配置/记忆/技能）
  **覆盖安装与卸载都不动**；卸载时是否清数据由用户显式勾选，默认保留。
- **随包 Node / Python vs 系统已装**：**一律不动系统环境** —— 不写 PATH、不写注册表、
  不做文件关联、不替换系统运行时。随包与系统**并存**，解析顺序（8.1）保证随包优先；
  用户想改用系统版，`DEEPWORK_NODE_BIN` / `DEEPWORK_PYTHON_BIN` 显式指定即可。
- **版本钉死与升级路径**：随包运行时版本钉死（node 24.14.0 / python 3.12.x /
  dsh 0.1.5-rc.1），升级**只随安装包整体升级**；不做运行时热更新
  （与 M2-K 挂起同源：没有发布通道）。换版本 = 改暂存区 + 重打包 + 重发安装包。
- **判据**：装有系统 Node（版本不符的旧版）的机器上安装后，应用仍用随包运行时
  （status 可见来源）；覆盖安装后既有会话 / 配置 / 记忆完整保留（升级前后各跑一次
  smoke 级检查）；卸载默认保留 `~/.deepwork/`。

### 8.5 建议动手顺序

1. **8.4 先定**（纯决策 + 安装器配置，不依赖其他项；定错了后面全返工）。
2. **8.1 取证**（embeddable vs 完整发行版）→ 随包 Python 落地。
3. **8.2** 依赖 8.1 的形态结论。
4. **8.3 最后做全量**（检查项里要覆盖 8.1/8.2 引入的新前提），但检查模块的骨架
   可以与 8.1 并行先建。

### 8.6 落地结果（2026-09-16）

四节按上面的顺序做完，逐节的落地物与验收：

| 节 | 落地物 | 验收（进 verify） |
|---|---|---|
| 8.4 | `deploy.ts` 的 `INSTALL_POLICY` + electron-builder.yml 的 nsis 显式配置（`allowDowngrade: false` / `deleteAppDataOnUninstall: false`） | `tools/installer-test.js` **29 项** |
| 8.1 | `core-host/src/runtime/python.ts` 的 `resolvePythonRuntime()` + 随包 Python 3.12.10 + extraResources 落位 + 设置页「随包 Python 运行时」 | `tools/runtime-test.js` **21 项** |
| 8.2 | `deploy.ts` 的 `PipSource` / `validatePipSource` / `pipSourceArgs` + `runtime/pip.ts` 的 `pipArgv`/`pipEnv`/`runPip` + 设置页表单 | `tools/pip-test.js` **31 项** |
| 8.3 | `runtime/preflight.ts` 的 `runPreflight()` + `runtime.preflight` RPC + 设置页「运行环境体检」 | `tools/preflight-test.js` **28 项** |

**取证修正了原计划里的一个隐含假设**：「随包 Python 3.12」不等于「3.12 系列最新」——
3.12.11 起 python.org **不再发布 Windows 二进制产物**，拿不到可解压的形态。
版本因此钉在 3.12.10，理由写在 `BUNDLED_RUNTIMES` 注释与 `docs/DEPLOY.md`。

**形态结论**：选 nuget 完整发行版（压缩 14.5MB / 解压后 37.4MB，自带 pip 25.0.1），
不选 embeddable（11.1MB，无 pip，要魔改 `._pth`）—— 判据是 §8.2 的 pip 源需求。

**未做（如实记）**：NSIS 安装脚本内嵌体检（本机没有 NSIS 工具链）、
卸载向导里的「清数据」勾选项、真机装/卸验收。
理由与替代路径见 `docs/DEPLOY.md` §五。

### 8.7 下一批（§八 之外，仍不依赖后端平台）

第八节做完后，ROADMAP 里「不依赖后端平台」的存量**只剩一块**，见 §五：
八项遗留债（桌面通知 / Composer `/` 补全 / Trajectory 逐事件分叉 / 主题切换器 /
内核自动写记忆 / 技能市场 URL 源 / 连接器 HTTP 传输 / 分支对比视图）。
（**FR-3.5 的模式切换入口与 FR-10.2 后半均已补齐**，见 §七 对应两行。）
运维债（CI / 推远端 / 打 tag）与跨平台打包仍按原判据挂着。
