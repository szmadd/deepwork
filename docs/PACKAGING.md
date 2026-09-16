# 打包与分发

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

另有一体化离线安装包（随包 Node + 随包 dsh，目标机零依赖双击即用），
见 `offline-bundle/` 与 [DEVLOG.md](DEVLOG.md) 2026-09-15 条目。

## 打包形态的三条硬约束

配置里的每个非常规决定都来自架构约束，不是偏好：

1. **内核在 asar 之外**（`resources/core-host/`）。asar 是 Electron 私有归档格式，
   只有 Electron 自带的 fs 补丁读得了；内核是独立 node 子进程，优先用外部 Node 22.19+，
   塞进 asar 等于堵死这条路。
2. **手工摆出 `core-host/node_modules/@deepwork/protocol`**。protocol 是 workspace 包，
   打包后没有软链可解析，`require('@deepwork/protocol')` 会静默失败 —— 所以用
   extraResources 把它落到内核旁边，保持 require 语义不变。
3. **electron 版本钉成精确值**（无 `^`）。electron-builder 需要确定版本
   才能下载对应平台的二进制，版本范围直接报错。

## 打包相关的两个坑

- **`ELECTRON_RUN_AS_NODE=1` 会让打包后的应用「双击没反应」。** Electron 把它解释为
  「以纯 Node 模式运行」：进程启动即退出、不建窗口、不留日志。开发机上这个变量很常见
  （比如有些宿主环境会带着它）。验收脚本在启动 exe 前会清掉它；
  `package-verify.js --launch` 就是防这类回归的哨兵。
- **GUI 子系统的应用没有 stdout。** 打包后的应用出问题时用户只能描述「打不开」，
  所以加了 `DEEPWORK_LOG_FILE`：设置后主进程日志落盘，报障时有据可查。

## 内网（离线）部署后的模型配置

一体化安装包装好后，配内网模型的正确顺序（每一步都有界面反馈，不用猜）：

1. 设置 → 模型 → 提供方选「自定义 OpenAI 兼容端点」，填 baseUrl（含 `/v1`）；
2. 点**「测试连接」** —— 服务没起 / 地址错 / key 无效 / 少了 `/v1` 会分别给出
   不同的提示，成功时列出端点公布的模型，点一下即可回填模型名；
3. 保存端点配置，必要时保存 API key；
4. 点**「重启内核使配置生效」** —— 重启后模型目录**自动重新核对**，
   顶栏下拉就会出现端点模型（这一步曾经是手动的，漏了就表现为「配好了但下拉没变」）。

一个兜底行为要知道：如果会话选的模型不在内核公布的目录里（比如还留着官方默认
`deepseek-v4-flash`），这一轮会在发送前被宿主拦下，错误里列出当前可选的模型 ——
不会把请求发给端点换一句 "Model not found"。
