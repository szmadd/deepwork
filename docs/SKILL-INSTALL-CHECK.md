# Skill 安装/调用链路校验核对

> 核对基线：`f8b3401`（main，2026 年拉取的远端最新）。
>
> **2026-09-18 更新：第 5 节缺口已全部修复**（实现见各条「修复」标注），
> 修复时同步新增了面向技能作者的导入前自查清单 `docs/SKILL-CHECKLIST.md`。
> 本文前半部分的核对结论（第 1~4 节）不受影响，仍然有效。

## 1. 安装链路全景

安装是一条「顺序不可重排」的防线，每一环都有明确位置：

```
来源字符串
  │  ① 来源校验      packages/protocol/src/skills.ts  validateSkillSource (skills.ts:76)
  │  ② 来源落地(URL) packages/core-host/src/skills/fetch.ts  materializeSkillSource (fetch.ts:47)
  ▼
本地目录（内含 SKILL.md）
  │  ③ 清单校验      packages/core-host/src/skills/manifest.ts  parseSkillMd (manifest.ts:25)
  │  ④ 安全审计      packages/core-host/src/skills/audit.ts  auditSkillDir (audit.ts:119)
  │  ⑤ 暂存→就位     packages/core-host/src/skills/store.ts  install (store.ts:66)
  ▼
<home>/skills/<name>/  +  <home>/skills.json
  │
  │  RPC：packages/core-host/src/host.ts:1214-1236 → packages/protocol/src/rpc.ts:196-200
  │  UI ：apps/desktop/src/components/SkillsPanel.tsx（先干跑审计、用户确认后才安装）
```

关键纪律（已在代码注释与实现中核实）：

- **审计前置**：任何来源先变成本地目录、过完审计才可能进技能目录；critical 发现时源目录不进家目录（store.ts:80-89）。
- **拷贝而非引用**：安装 = 把源完整拷进家目录（store.ts:97），临时源目录安装后无条件清理（store.ts:155-159）。
- **staging + 回滚**：先拷到 `.staging-<name>`，同名升级时旧目录移 `.trash-<name>`，就位失败回滚（store.ts:93-114）。

## 2. 校验点核对表

| # | 校验项 | 位置 | 现状 | 结论 |
|---|--------|------|------|------|
| 1 | 来源非空、协议仅 http/https、URL 合法、有主机名 | `packages/protocol/src/skills.ts:76-92` | 已实现；Windows 盘符（单字母协议头）不误判为 URL | ✅ 已落实 |
| 2 | URL 下载上限 32MB（先查 content-length 再读体）、超时 20s、空内容拒绝 | `packages/core-host/src/skills/fetch.ts:32-34, 99-114` | 已实现 | ✅ 已落实 |
| 3 | 下载形态按内容判断（PK 头=zip / `---` 开头=单文件），不按 URL 后缀 | `fetch.ts:117-149` | 已实现；形态不符时报「形态判断」而非「清单不合法」 | ✅ 已落实 |
| 4 | zip 解包剥顶层壳目录；剥完根下必须有 SKILL.md | `fetch.ts:122, 174-183`；防 zip 炸弹见 `zip.ts` | 已实现 | ✅ 已落实 |
| 5 | 源目录必须含 SKILL.md | `packages/core-host/src/skills/store.ts:68-70` | 已实现，缺失即拒并给路径 | ✅ 已落实 |
| 6 | frontmatter 围栏存在且闭合 | `packages/core-host/src/skills/manifest.ts:27-39` | 已实现 | ✅ 已落实 |
| 7 | frontmatter 逐行严格解析，无法解析的行直接报错（不宽容解析） | `manifest.ts:41-64` | 已实现 | ✅ 已落实 |
| 8 | `name` 必填；仅小写字母/数字/连字符；拒绝路径分隔符与 `.`/`..` | `manifest.ts:70-76` | 已实现 | ✅ 已落实 |
| 9 | **`version` 必填且须为 semver 写法，缺失/不合法拒绝安装** | `manifest.ts:77`（缺 version 抛错；`VERSION_RE` 校验格式）→ store.ts:75-78 转为「清单不合法：…」 | 已实现，安装被拒且 UI 展示原因 | ✅ 已落实 |
| 10 | `description` 缺省兜底为空串；`triggers`/`permissions` 可选 | `manifest.ts:67, 84-85` | 已实现；缺 description 安装时记 `missing-description` warn（见缺口 5，已修复） | ✅ 已落实 |
| 11 | 审计 critical 阻断安装（破坏性命令/远程执行/混淆载荷/双扩展名/PE/ELF/外发组合） | `packages/core-host/src/skills/audit.ts:44-113, 209-297`；阻断在 `store.ts:81-89` | 已实现；warn/info 留档进清单供 UI 展示 | ✅ 已落实 |
| 12 | 符号链接不拷贝、不审计（防把家目录外内容带进来） | `store.ts:219-228`、`audit.ts:186` | 已实现 | ✅ 已落实 |
| 13 | 卸载/启停的技能名合法性校验（拒绝路径分隔符） | `store.ts:163, 175, 210-212` | 已实现 | ✅ 已落实 |
| 14 | 清单与磁盘对齐：目录被手删的技能从清单剔除 | `store.ts:44-55` | 已实现 | ✅ 已落实 |
| 15 | 同名不同 version = 升级，覆盖安装；同名同 version = no-op 并标注 `reinstalled` | `store.ts:100-111` | 均已实现（见缺口 2，已修复） | ✅ 已落实 |
| 16 | UI 安装流程：先 `skills.audit` 干跑 → 用户确认 → 安装；被拒展示 reason | `apps/desktop/src/components/SkillsPanel.tsx:68-100, 206` | 已实现；干跑现附带清单解析结果（见缺口 3，已修复） | ✅ 已落实 |

## 3. 调用链路核对

| 项 | 位置 | 现状 |
|----|------|------|
| 显式调用识别 `/技能名`（`EXPLICIT_RE` 锚定行首） | `packages/core-host/src/skills/context.ts:47, 50` | ✅ |
| 环境注入只带摘要（名称/版本/描述/触发提示/SKILL.md 路径），正文由内核按需读取 | `context.ts:70-79` | ✅ |
| 正文单技能 16K 字符、整段上下文 48K 字符截断，截断在 attached 记录中标记 | `context.ts:28-30, 91-98, 116-118` | ✅ |
| 已安装但 SKILL.md 读取/解析失败的技能：跳过不阻断对话，记入 skipped 并发 `skill.skipped` 事件 | `context.ts:57-63`、`host.ts:1077-1080` | ✅（事件已补，见缺口 4，已修复） |
| `/名字` 未匹配已启用技能时如实告知内核，不静默当普通文本 | `context.ts:110-113` | ✅ |
| `/` 补全只在文本第一个词弹出，候选来自已启用技能，插入带尾随空格 | `packages/protocol/src/skills.ts:267-318` | ✅ |
| 注入与事件：host 每轮构建技能上下文并发出 `skill.attached` 事件 | `packages/core-host/src/host.ts:1073-1101` | ✅ |

## 4. 测试覆盖核对

| 测试 | 文件 | 覆盖的校验 |
|------|------|-----------|
| 清单解析 | `tools/skill-system-test.js:59-74` | 全字段解析；**缺 version 拒绝（:70）**；缺 name；围栏未闭合；name 含路径分隔符；name 含大写 |
| 安装拒绝 | `tools/skill-system-test.js:244-246` | **缺 version 的源安装被拒，reason 含 "version"**，且不落入技能目录 |
| 审计 | `tools/skill-system-test.js:95-197` | 良性通过；破坏性命令/RCE/编码命令/Windows 删除/外发组合=critical 阻断；凭据访问=warn；双扩展名/伪装；vendored deps |
| 升级/启停/卸载 | `tools/skill-system-test.js:250-275` | 同名不同版本覆盖、清单无重复、停用反映、卸载剔除 |
| RPC 链 | `tools/skill-system-test.js:304-308` | `skills.list` / `skills.install` 走完整审计链 |
| URL 来源 | `tools/skill-url-test.js` | 协议校验（:135）、形态判断报错文案（:273）、zip/单文件下载链路 |

结论：**「缺 version 不让安装」既有实现（manifest.ts:77）又有测试（skill-system-test.js:70, 244-246），链路各环校验均有对应测试。**

## 5. 缺口清单（2026-09-18 已全部修复）

1. **version 只查存在、不查格式** — ✅ 已修复
   - 修复：`manifest.ts` 新增 `VERSION_RE`（semver：x.y.z，可带 `-prerelease`/`+build`），
     不合法直接抛 `SkillManifestError`，安装被拒并给出原因。契约注释（semver 承诺）保持不变，
     现在是兑现而非删除承诺。
   - 测试：`tools/skill-system-test.js`（`version: abc` / `1.0` 被拒、`-rc.1+build` 合法）。

2. **同版本重复安装无判断** — ✅ 已修复
   - 修复：`store.ts install()` 在审计**之前**查同名同 version（经 `list()`，已剔除幽灵记录），
     命中即 no-op 返回 `{ ok: true, reinstalled: true, record: 已存在记录 }` —— 磁盘、清单、
     安装时间一律不动。契约注释承诺的「字符串相等性同版本判断」由此兑现；
     `SkillInstallResult` 新增 `reinstalled` 字段，UI 显示「已安装，未做改动」而非假的成功。
   - 测试：`tools/skill-system-test.js`（reinstalled 标记、磁盘/时间未变、无暂存残留）。

3. **干跑审计不校验清单** — ✅ 已修复
   - 修复：`SkillAuditReport` 新增 `manifest?` / `manifestError?`；`store.auditOnly()` 现在
     解析 SKILL.md：成功附 manifest（确认页显示「将要安装：name v version —— 描述」），
     失败附 `manifestError`。`SkillsPanel` 确认页据此展示清单结论，清单不合法时禁用
     「确认安装」按钮 —— 「这个包根本装不上」在用户点确认之前就能看到。
   - 测试：`tools/skill-system-test.js`（干跑附 manifest / 暴露 manifestError）。

4. **运行时 SKILL.md 损坏仅记日志** — ✅ 已修复
   - 修复：新增 `skill.skipped { runId, skills }` 事件（与 `skill.attached` 同一纪律：
     带 runId、先于 run.started、进日志），`host.ts` 在原有 log.warn 之外发出；
     `reduce.ts` 归约为 warn 级提示，对话流与回放均可见。UI 无需专门组件 —
     notice 渲染路径已有 `notice-warn` 样式。
   - 测试：`tools/skill-context-test.js`（事件形状/次序/runId、回放含 warn 提示）。

5. **description 缺失静默兜底为空串** — ✅ 已修复
   - 修复：`store.ts` 新增 `withManifestFindings()`：description 为空时在审计报告中
     合成一条 `missing-description` warn（不阻断安装，插入在 info 级之前保持排序纪律），
     安装与干跑两条路径都生效 —— 作者在安装确认页就能看见「触发质量会打折」。
   - 测试：`tools/skill-system-test.js`（安装与干跑均给出该 warn、排序不破坏）。
