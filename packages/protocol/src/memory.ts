/**
 * 三层记忆系统契约。
 *
 * ── 三层是什么 ──────────────────────────────────────────────────────
 *  1. **画像（profile）**：跨会话、跨项目的用户画像。本轮落为本地纯文本
 *     （本项目无服务端，云同步属 M3）。它**只读注入**内核上下文 ——
 *     画像影响每一轮对话，因此修改走显式的 `memory.setProfile`，
 *     不走条目增删。
 *  2. **用户级记忆（user）**：本机所有项目共享的显式记忆条目
 *     （「我喜欢…」「以后都…」）。写入是显式动作，受精确字符预算约束，
 *     超限直接拒绝而不是静默丢弃。
 *  3. **工作区记忆（workspace）**：单个项目内的记忆 —— 长期精选笔记
 *     （条目数组）+ 每日 append-only 运行日志（自动追加、只增不覆盖）。
 *
 * ── 硬约束 ──────────────────────────────────────────────────────────
 *  - 记忆写入必须先于回复发生：宿主侧与 UI 侧的写入在发起运行前完成；
 *    内核自动写记忆依赖 MCP 工具暴露，属 M2-G 范围。
 *  - 预算必须可见：每一层的 entries / chars / budget / truncated 都通过
 *    MemoryLayerStat 暴露给 UI 与事件流，「注入了但少了一截」不能静默。
 *  - 归档是机械合并（超过 30 天的日记按月并入 archive），不是语义蒸馏
 *    —— 语义蒸馏需要内核摘要能力，见 DEVLOG M2-E 的遗留。
 */

/** 记忆层标识 */
export type MemoryLayer = 'profile' | 'user' | 'workspace';

/** 记忆条目来源：用户显式添加 / 内核写入（M2-G 起）/ 蒸馏产出 */
export type MemoryOrigin = 'user' | 'agent' | 'distilled';

/**
 * 一条记忆条目。
 *
 * 画像层是整段文本、不走条目增删；为了让 UI 在既定的 5 个 RPC 内读得到画像，
 * memory.list 把画像以伪条目（id 恒为 'profile'，text 为整段内容）形式返回，
 * memory.remove('profile') 等价于清空画像。画像的写入只走 memory.setProfile。
 */
export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  text: string;
  /** 创建时刻（ISO 8601） */
  createdAt: string;
  origin: MemoryOrigin;
  /** 工作区层条目所属的工作区绝对路径；其余层省略 */
  workspace?: string;
}

/**
 * 一层的用量与注入预算画像。
 *
 * budget 与 truncated 必须可见：用户级与工作区精选有总字符预算
 * （超限拒绝写入），画像与今日日志是注入侧截断（truncated 如实标记）。
 */
export interface MemoryLayerStat {
  layer: MemoryLayer;
  /** 条目数（画像层为 0 或 1） */
  entries: number;
  /** 该层当前参与注入的字符数 */
  chars: number;
  /** 该层的注入/存储预算（字符） */
  budget: number;
  /** 实际内容是否超出预算（注入时会被截断） */
  truncated: boolean;
}
