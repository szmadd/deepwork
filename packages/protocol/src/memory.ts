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

// ════════════════════════════════════════════════════════════════
// MCP 工具暴露：让内核在对话中自主沉淀记忆
// ════════════════════════════════════════════════════════════════

/**
 * 内核可见的记忆 MCP 服务 serverName。
 *
 * 为什么要做成 MCP 服务而不是只注册进宿主工具注册表：注册表**只在 mock
 * 适配器下被执行**，真实内核（dsh）有它自己的一套模型可见工具 —— 只做注册表的话，
 * 「内核会自己记」在开发期完全正常，切到真实内核就没了，而且不报任何错。
 * 内核原生支持 MCP，所以正统路径是把它做成服务由宿主写进 `--patch`
 * （与图表 / 浏览器同一条路）。
 *
 * 名字不含点号：`mcp__<serverName>__<tool>` 会进模型可见的工具名，
 * 而模型 API 对 function name 限定 `^[a-zA-Z0-9_-]{1,64}$`。
 */
export const MEMORY_MCP_SERVER_NAME = 'deepwork_memory';

/** 宿主工具名（点分风格，注册表用） */
export const MEMORY_WRITE_TOOL = 'memory.write';
export const MEMORY_READ_TOOL = 'memory.read';

/** MCP 工具名；公开全名分别是 `mcp__deepwork_memory__memory_write` / `..._read` */
export const MEMORY_MCP_WRITE_TOOL = 'memory_write';
export const MEMORY_MCP_READ_TOOL = 'memory_read';

/**
 * 层的中文名（用于正文回执与工具描述）。
 * 与记忆面板的页签名是两回事 —— 页签名更短（「用户级」「工作区」），
 * 这里的称呼要能独立成句（「已写入用户级记忆」）。
 */
export const MEMORY_LAYER_NAME: Record<MemoryLayer, string> = {
  profile: '画像',
  user: '用户级记忆',
  workspace: '工作区精选笔记',
};

/**
 * 内核**允许**自主写入的层。
 *
 * 画像层被排除在外：它是整段文本、只读注入、影响每一轮对话，修改必须由用户
 * 亲手经 `memory.setProfile` 完成。一个能自行改写用户画像的助手，其行为将不再
 * 可预测 —— 而且这种漂移是渐进的，等用户察觉时已经偏了很久。
 */
export const MEMORY_WRITE_LAYERS: readonly MemoryLayer[] = ['user', 'workspace'];

export function isMemoryWriteLayer(value: unknown): value is 'user' | 'workspace' {
  return value === 'user' || value === 'workspace';
}

// ── 入参的单一事实来源 ─────────────────────────────────────────────
// 与图表同一纪律：中文描述与 JSON Schema 都从这张表派生，两处不会分叉
// （分叉的失败形态是「模型按描述传参、schema 却拒绝」，报出的错与真正的原因无关）。

export interface MemoryArgSpec {
  name: string;
  /** JSON Schema 的 type */
  jsonType: string;
  required: boolean;
  description: string;
}

export const MEMORY_WRITE_ARGS: readonly MemoryArgSpec[] = [
  {
    name: 'layer',
    jsonType: 'string',
    required: true,
    description: `string，写往哪一层：${MEMORY_WRITE_LAYERS.join(' / ')}（user = 本机所有项目共享；workspace = 仅当前项目）。画像层不接受工具写入`,
  },
  {
    name: 'text',
    jsonType: 'string',
    required: true,
    description:
      'string，一条自包含、可复用的记忆：写「用户偏好 / 项目约定 / 反复出现的纠正」这类下次还会用到的事实，' +
      '不要复述刚才做过什么。每条尽量短，受总字符预算约束，超限会被拒绝',
  },
];

export const MEMORY_READ_ARGS: readonly MemoryArgSpec[] = [
  {
    name: 'layer',
    jsonType: 'string',
    required: false,
    description: `string，可选，只读某一层：${MEMORY_WRITE_LAYERS.join(' / ')} / profile；省略则三层的当前内容一起返回`,
  },
];

function memoryJsonSchema(args: readonly MemoryArgSpec[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of args) {
    properties[arg.name] = { type: arg.jsonType, description: arg.description };
    if (arg.required) required.push(arg.name);
  }
  return { type: 'object', properties, required };
}

function memoryParameterDescriptions(args: readonly MemoryArgSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of args) out[arg.name] = arg.description;
  return out;
}

export function memoryWriteInputJsonSchema(): Record<string, unknown> {
  return memoryJsonSchema(MEMORY_WRITE_ARGS);
}

export function memoryReadInputJsonSchema(): Record<string, unknown> {
  return memoryJsonSchema(MEMORY_READ_ARGS);
}

export function memoryWriteParameterDescriptions(): Record<string, string> {
  return memoryParameterDescriptions(MEMORY_WRITE_ARGS);
}

export function memoryReadParameterDescriptions(): Record<string, string> {
  return memoryParameterDescriptions(MEMORY_READ_ARGS);
}

export function memoryWriteToolDescription(): string {
  return (
    '把这次对话里学到、下次还会用到的一条事实或偏好写进长期记忆（本机共享层或当前项目层）。' +
    '只在确实值得长期保留时写：用户的偏好、项目的约定、反复出现的纠正 —— 不要复述过程。' +
    '每层有字符预算，超限会被拒绝；写之前可以先 memory_read 看有没有重复的。'
  );
}

export function memoryReadToolDescription(): string {
  return '读回长期记忆的当前内容（用户级 / 工作区 / 画像），用于写入前查重或确认现有约定。';
}

// ── 结果文本（宿主工具回执与 MCP 文本共用同一句，避免两处措辞分叉）──

/** 写入成功的一段回执；带上该层当前用量，模型据此判断快写满了没有 */
export function memoryWriteResultText(input: {
  layer: 'user' | 'workspace';
  text: string;
  entries: number;
  chars: number;
  budget: number;
}): string {
  return (
    `已写入${MEMORY_LAYER_NAME[input.layer]}（该层现有 ${input.entries} 条 / ${input.chars} 字符，预算 ${input.budget}；` +
    `可在记忆面板删除）：${input.text}`
  );
}

/** 读取某一层的展示段 */
export function memoryReadSectionText(input: {
  layer: MemoryLayer;
  /** 画像层为伪条目（id='profile'） */
  entries: MemoryEntry[];
  chars: number;
  budget: number;
  truncated: boolean;
}): string {
  const head =
    `${MEMORY_LAYER_NAME[input.layer]}（${input.entries.length} 条 / ${input.chars} 字符` +
    `${input.truncated ? '，已按预算截断' : ''}，预算 ${input.budget}）`;
  if (input.entries.length === 0) return `${head}：\n（空）`;
  // 画像层是整段文本，不逐条加前缀；条目层逐条列
  const body = input.entries
    .map((entry) => (input.layer === 'profile' ? entry.text : `- ${entry.text}`))
    .join('\n');
  return `${head}：\n${body}`;
}
