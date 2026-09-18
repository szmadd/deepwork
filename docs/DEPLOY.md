# 部署与运行时

> ROADMAP §八 的落地说明。回答两个问题：**装的时候、装完以后运行时从哪来**，
> 以及**目标机上已有的东西怎么办**。
>
> 契约在 `packages/protocol/src/deploy.ts`（`BUNDLED_RUNTIMES` / `RUNTIME_RESOLUTION_ORDER` /
> `INSTALL_POLICY` / `PipSource`），验收在 `tools/runtime-test.js`、`tools/installer-test.js`、
> `tools/pip-test.js`、`tools/preflight-test.js` 四套，全部挂进 `npm run verify`。
>
> 相关文档：[PACKAGING](./PACKAGING.md) · [ARCHITECTURE](./ARCHITECTURE.md) · [DEVLOG](./DEVLOG.md)

---

## 一、随包运行时（§8.1）

一体化离线安装包携带三样运行时，目标机**不装 Node / Python、不联网**即可用真实内核：

| 落位（`resources/` 下） | 内容 | 版本 | 怎么来 |
|---|---|---|---|
| `node-runtime/` | 便携 `node.exe` 单文件 | 24.14.0 | Node 官方 win-x64 zip 里抽出来 |
| `python-runtime/` | 完整 CPython（含 pip） | 3.12.10 | nuget `python` 包解出的 `tools/` |
| `dsh-runtime/` | `@deepseek-ai/dsh` 的完整依赖 | 0.1.5-rc.1 | 空目录 `npm install @deepseek-ai/dsh@0.1.5-rc.1` |

版本号只在 `deploy.ts` 的 `BUNDLED_RUNTIMES` 里声明一次；`使用说明.txt`、打包配置与
实际产物由 `tools/installer-test.js` 交叉断言 —— 改了一边忘另一边会红。

### 解析顺序（node 与 python 同构）

```
DEEPWORK_NODE_BIN / DEEPWORK_PYTHON_BIN   ← 显式指定
        ↓ 没设
随包运行时（resources/xxx-runtime/）
        ↓ 没有
系统 PATH
```

**随包优先于系统**是有意的：目标机上可能装着一个残缺或版本不符的解释器，
被优先选中后出的问题是「偶发、与环境相关」的那一类，最难定位 ——
而这类故障在本机永远复现不出来。

要改用系统那份，就显式指定，不靠 PATH 顺序碰运气。

实现出口：`packages/core-host/src/runtime/python.ts` 的 `resolvePythonRuntime()`。
它返回的 `source` 是三档之一的**枚举值**（不是文案），测试断言用它；
界面显示用 `label`，与 status 的 `runtimeSource` 同一条纪律。

### 形态取证：为什么是完整发行版，不是 embeddable

2026-09-16 实测两种形态（原始结论见 DEVLOG）：

| 形态 | 压缩包 | 解压后 | pip | 结论 |
|---|---|---|---|---|
| embeddable zip | 11.1 MB | 21.5 MB | ❌ `No module named pip` | 不选 |
| nuget 完整发行版 | 14.5 MB | 37.4 MB | ✅ pip 25.0.1 | **采用** |

判据是 §8.2 的需求：随包 pip 要能走内网源。走 embeddable 就必须
「取消 `python312._pth` 的 site 限制 + 自带一份 get-pip.py + 解决 get-pip 自己也要联网」，
而这三步**每一步都会在未来任何 Python 技能装包时再咬一次**。
多 3.4 MB 压缩体积换掉这一串麻烦，是划算的。

### 版本钉死：为什么 Python 是 3.12.10 而不是 3.12.14

**3.12.11 起 python.org 不再发布 Windows 二进制产物。** 实测
`python-3.12.11..14-embed-amd64.zip` 全部 404，目录里只剩源码 tarball ——
3.12 已进入 security-only 阶段，该阶段只发源码。随包要的正是「解压即用的二进制形态」，
所以只能停在最后一个带 Windows 二进制的 3.12 版本。

> 看到 3.12.14 更新就改这个数，会得到一个 404。要升 3.12 打头的版本，
> 得先确认 python.org 那一年是否还在发二进制。

## 二、内网 pip 源（§8.2）

场景是**局域网镜像**（devpi / Nexus / 静态目录），不是「换个国内镜像」——
后者的前提是能上公网，而这条需求的前提恰恰是不能上。

两条硬规矩：

1. **参数，不是配置文件**：源地址经 `--index-url` 注入，永不写目标机的 `pip.ini`。
   配置文件是「这台机器以后都这么走」，命令行参数是「我们这次怎么走」。
2. **反过来也不读用户的配置**：`PIP_CONFIG_FILE` 指向空设备。目标机上一份陈年
   `pip.ini` 会悄悄改变我们的行为，而那种故障没有任何线索指向它。

未配置时**一个参数都不加**：pip 走它自己的默认源，离线机器上如实报错。
不伪造默认源、不静默回落公网 —— 「装了个来路不明的包」比「装不上」严重得多。

出口：`packages/core-host/src/runtime/pip.ts` 的 `pipArgv` / `pipEnv` / `runPip`。
配置入口：设置 → 偏好 → 「内网 pip 源」。

验收的关键判据是**服务端侧的证据**：`tools/pip-test.js` 起一个假索引服务器，
真跑一次 pip，从服务器收到的请求确认「请求真的打到了配置的源」——
客户端说它用了这个源，不算证据。

## 三、安装前环境体检（§8.3）

`packages/core-host/src/runtime/preflight.ts`，`runPreflight()` 返回逐项报告。
分级**按实际后果**，不按「看起来严不严重」：

| 级别 | 含义 | 条目 |
|---|---|---|
| `block` | 装不下去或跑不起来 | 架构非 x64 · 随包 Node 缺失/跑不起来 · 写入权限 · 磁盘空间 |
| `warn` | 能力降级但可用 | 随包 Python 缺失 · dsh 依赖缺失 · 无系统浏览器 · 未配 pip 源 |

把「随包 Python 缺失」标成阻断是个容易犯的错：产品**今天没有** Python 依赖，
缺了它只影响未来能力。分级错了的后果是用户在没坏的时候不敢装。

两个刻意的设计：

- **「文件在」不等于「通过」**：随包 Node 会真的跑一次 `-v`。杀毒软件吃掉半个文件时，
  文件存在性检查会给出一个绿灯，而应用双击没反应 —— 这是最典型的假通过。
- **每项都带 `remedy`**：只说「检查失败」等于把问题原样丢回给用户。

入口两处，用的是**同一份实现**：

- 设置 → 偏好 → 「运行环境体检」（`runtime.preflight` RPC）
- 安装器侧（见下方「未验收」）

## 四、已安装组件的处置策略（§8.4）

| 对象 | 策略 |
|---|---|
| 应用本体 | 同 appId 重装 = **修复式覆盖**；升级直接覆盖；**降级没有闸门**（见下） |
| 用户数据 `<主目录>\.deepwork` | 覆盖安装与卸载**都不动**；清理是显式动作，不是卸载流程的默认分支 |
| Electron userData（`%APPDATA%\深边AI Work`） | 卸载保留（`deleteAppDataOnUninstall: false`） |
| 随包 Node / Python vs 系统已装 | **一律不动系统环境**：不写 PATH、不写注册表、不做文件关联、不替换系统运行时；两者并存，靠解析顺序保证随包优先 |
| 运行时升级 | 只随安装包整体升级，不做热更新（与 M2-K 挂起同源：没有发布通道） |

「覆盖安装不动数据」不只是承诺，而是一条**结构性事实**：用户数据在用户主目录下，
与安装树不同树。卸载器只处理自己装下去的文件，所以「卸载删数据」在结构上无法发生 ——
`tools/installer-test.js` 直接断言这个路径关系，而不是断言文案。

**降级闸门：没有，而且当前写不出来（2026-09-17 修正）。**
配置里曾经写着 `allowDowngrade: false`，但 electron-builder 26.15.3 的 NSIS **没有**这个选项 ——
后果不是「被忽略」，而是 `npm run dist` **整个中断**
（schema 报 `configuration.nsis should be one of these: null`）。
该版本的 NSIS 也不做任何版本比较：**装一个更旧的包不会被拦**。
要真拦降级，唯一的路径是自写 `nsis.include`（在 `customInit` 里读已装版本的
`DisplayVersion` 并比较），且必须有能验证「装旧包被拦下」的环境才算验收过 ——
本机没有，所以契约里如实记成 `INSTALL_POLICY.downgradeGuard = 'unavailable'`，
`installer-test.js` 同时断言「配置里不许再出现 `allowDowngrade`」。

清数据的路径（显式）：删掉 `<用户主目录>\.deepwork` 即可。
`DEEPWORK_HOME` 改过位置的，删那个位置。

---

## 五、未验收 / 未做（如实记）

- **NSIS 安装脚本内嵌体检未做**：ROADMAP §8.3 的「两层形态」里，
  「首次启动 / 设置页」这一层已落地并进 verify；**安装器内嵌检查需要 NSIS 工具链，
  本机没有**，因此那一层未实现。要补的话，把 `runPreflight()` 的阻断项接进
  自定义 `.nsh` 宏即可（检查逻辑已经在 JS 里、可被安装器之外的环境调用完毕）。
- **真机装/卸行为未验收**：`tools/installer-test.js` 断言的是**配置与契约一致**
  以及**路径归属**。真正的「装一遍、卸一遍、看数据还在不在」需要在一台干净机器上
  跑一次 `npm run dist` 之后手工确认 —— 本机没有 NSIS 工具链，这一步做不了。
  （**2026-09-17 修正**：这里原先写「本机没有 NSIS 工具链」是错的 ——
  electron-builder 自带 NSIS，`npm run dist` 会真的编译安装器，所以「编译得过」是能验的；
  验不了的是**装完之后的行为**。）
- **降级闸门未实现**（见上文 §四）——electron-builder 26 的 NSIS 没有版本比较，
  自写 `nsis.include` 才能拦，而「装旧包被拦下」这一步同样只能在真机上验。
- **卸载向导里的「是否删除数据」勾选项未做**：ROADMAP §8.4 原文提过这个形态。
  实现它要写自定义 NSIS 页面（含中文，NSIS 脚本默认 ANSI 编码，容易乱码），
  且**无法在本机验收**。因此本轮只声明「默认保留 + 显式清理路径」，
  没有把「可勾选」写成已完成。
- **`resources/python-runtime/` 是二进制产物、不入库**（`offline-bundle/` 整体被
  gitignore）。重建方式见 `offline-bundle/使用说明.txt` 第五节。
