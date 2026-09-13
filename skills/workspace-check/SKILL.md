---
name: 工作区体检
description: 检查工作区结构、运行时版本与常见配置问题，输出一份简短体检报告
triggers:
  - 体检
  - 检查工程
  - 工程结构
version: 0.1.0
agent_created: true
permissions:
  - fs.list
  - fs.read
  - shell.run:node -v
---

# 工作区体检

对当前工作区做一次快速体检，输出结构化报告。

## 执行步骤

1. 用 `fs.list` 列出工作区结构（深度 2），确认根目录下有哪些工程文件。
2. 依次检查以下关键文件是否存在，存在则用 `fs.read` 读取关键字段：
   - `package.json` → name / version / scripts / engines.node
   - `pyproject.toml` 或 `requirements.txt`
   - `README.md` → 是否说明了安装与运行方式
   - `.gitignore` → 是否忽略了 `node_modules`、`dist`
3. 用 `shell.run` 执行 `node -v` 与 `npm -v`，确认运行时版本。
4. 汇总为一句话结论 + 问题清单。

## 输出格式

```
## 工程概况
- 名称 / 版本：
- 包管理器：
- 运行时要求：

## 发现的问题
- [严重] ...
- [建议] ...
```

## 约束

- 只做只读检查，不得执行任何写操作或安装命令。
- 检查项缺失时如实写「未找到」，不要臆测内容。
- 报告控制在 20 行以内。
