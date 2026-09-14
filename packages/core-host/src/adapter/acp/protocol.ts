/**
 * Agent Client Protocol（ACP）消息类型 —— 本项目用到的子集。
 *
 * ── 这些不是占位约定 ──────────────────────────────────────────────
 * ACP 是公开标准协议，规格见 https://agentclientprotocol.com/protocol
 * 传输：newline-delimited JSON-RPC 2.0 over stdio。
 *
 * 校准来源（2026-09-12，两次）：
 *   1. ACP 官方规格站（方法表、stopReason、ToolKind、PermissionOptionKind）
 *   2. `@deepseek-ai/dsh` 0.1.5-rc.1 的 profile 配置树：`dsh --profile acp --dump-config`
 *   3. **`node tools/real-dsh-probe.js` 对真实内核的实测帧**（此后为唯一权威）
 *
 * 校准前本文件假设的是「回环 HTTP + SSE + stdout 握手」，那是**不存在的接口**。
 * 真实 dsh 的出口是 profile 制（web / headless / sdk / sdk-minimal / acp），
 * 面向自动化客户端的就是 acp。
 *
 * ── 实测纠正的三处（读文档会猜错，只有真跑才知道）─────────────────
 *  1. `session/prompt` 的参数键是 **`prompt`（数组）**，不是 `content`。
 *     写错时内核回 `-32602 Invalid params ... prompt: expected array, received undefined`。
 *  2. 客户端能力键是 **`fs`**，不是 `fileSystem`。写错不报错，只是静默失效 ——
 *     这类「看起来成功」的失败只能靠实测暴露。
 *  3. `session/request_permission` 的工具 id 在 **`params.toolCall.toolCallId`** 里，
 *     不在顶层 `toolCallId`。
 *
 * ── 一条容易踩的硬约束 ────────────────────────────────────────────
 * ACP 下 **stdout 只走协议**，诊断信息必须走 stderr。
 * 因此本客户端绝不把 stdout 当作日志来源；把协议流与诊断流混在一起，
 * 轻则握手解析失败，重则在正常运行时偶发性地「丢一帧」。
 */

/** 规格里当前的协议版本号。initialize 时协商。 */
export const ACP_PROTOCOL_VERSION = 1;

/** 提示轮次的结束原因。 */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

/** 工具分类。用于把内核的工具调用映射成本项目的风险级别。 */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** 权限选项的语义。注意它比「允许/拒绝」更细：要区分「这一次」与「以后都」。 */
export type AcpPermissionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AcpTextContent {
  type: 'text';
  text: string;
}

export interface AcpResourceLinkContent {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
}

export type AcpContentBlock = AcpTextContent | AcpResourceLinkContent | { type: string; [k: string]: unknown };

/** 客户端能力：声明我们替内核做什么。键名 `fs` 是规格写法，写成 fileSystem 会静默失效。 */
export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: Record<string, boolean>;
  [k: string]: unknown;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: { name: string; version?: string };
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: { name?: string; version?: string };
}

export interface AcpNewSessionParams {
  /** 必须是绝对路径 —— 规格要求，且本项目的工作区边界也依赖它 */
  cwd: string;
  mcpServers?: unknown[];
}

/** session/new 的结果。内核会同时公布可选的配置项（模型、推理强度）。 */
export interface AcpNewSessionResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

/**
 * 配置项。实测（dsh 0.1.5-rc.1）公布两项：`model` 与 `reasoning_effort`，
 * 都是 `type: "select"`。`name` / `category` 是真帧里就有的字段，
 * 之前没声明所以被丢掉了 —— 它们是「这个选项是干什么的」的唯一线索，
 * 尤其 `category: "thought_level"` 一眼说明推理档位不是模型选择。
 */
export interface AcpConfigOption {
  id: string;
  /** 真帧里的显示名（"Model" / "Reasoning effort"） */
  name?: string;
  /** 真帧里的分类（"model" / "thought_level"） */
  category?: string;
  type?: string;
  /** 选择型选项的当前值。实测模型项是 JSON 字符串数组：`["provider","model"]`。 */
  currentValue?: string;
  options?: Array<AcpConfigOptionValue | { group?: string; name?: string; options?: AcpConfigOptionValue[] }>;
}

export interface AcpConfigOptionValue {
  value: string;
  name?: string;
  description?: string;
}

/**
 * session/prompt 的参数。**键是 `prompt` 且必须是数组** —— 实测写 `content`
 * 会被内核以 -32602 明确拒绝。
 */
export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export interface AcpPromptResult {
  stopReason: AcpStopReason;
  [k: string]: unknown;
}

/**
 * session/update 通知的载荷。`sessionUpdate` 是判别字段。
 *
 * 实测（dsh-acp 0.1.5-rc.1）的形状与规格示例有三点不同，都已按实测固定：
 *  1. `tool_call` 的 `kind` **恒为 "other"**，真实工具名在 `title` 里；
 *     所以风险级别只能由工具名判定，不能指望 kind。
 *  2. `tool_call` 携带 `rawInput`（工具入参），这是唯一能看到写入路径的地方。
 *  3. `tool_call_update` 的 `content` 是 **{ type:'content', content: 块 }** 的嵌套结构，
 *     直接取 `block.text` 会得到空串 —— 表现是「工具跑完了但输出永远为空」。
 */
export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; messageId?: string; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; messageId?: string; content: AcpContentBlock }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title?: string;
      kind?: AcpToolKind;
      status?: AcpToolCallStatus;
      rawInput?: unknown;
      content?: AcpContentBlock[];
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      status?: AcpToolCallStatus;
      content?: AcpWrappedContent[];
    }
  | { sessionUpdate: 'usage_update'; used?: number; size?: number }
  | { sessionUpdate: 'config_option_update'; configOptions?: AcpConfigOption[] }
  | { sessionUpdate: string; [k: string]: unknown };

/** tool_call_update 的内容元素：外层是包装器，真正的块在 `content` 里。 */
export interface AcpWrappedContent {
  type: string;
  content?: AcpContentBlock;
  [k: string]: unknown;
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

/**
 * 内核向客户端申请权限（Agent → Client 请求）。
 *
 * 实测：工具 id 在 **`toolCall.toolCallId`** 里，顶层没有 `toolCallId`。
 * 取错字段不报错，只是「这次权限请求不知道是哪个工具发起的」——
 * 界面上会显示成 unknown，用户等于在盲批。
 */
export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall?: { toolCallId?: string };
  toolCallId?: string;
  options: Array<{ optionId?: string; id?: string; name?: string; kind?: AcpPermissionKind }>;
  [k: string]: unknown;
}

export interface AcpRequestPermissionResult {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
}

export interface AcpWriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface AcpReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

/**
 * 从内容块里取出纯文本。
 *
 * 兼容两种形状：裸块（{type:'text',text}）与 tool_call_update 的包装块
 * （{type:'content',content:{type:'text',text}}）。只认前一种的话，
 * 工具输出会全部变成空串 —— 而「工具调用成功」本身不会报错，
 * 于是界面看起来一切正常，只是内容永远是空的。
 */
export function textOfContent(
  content: AcpContentBlock | AcpWrappedContent | Array<AcpContentBlock | AcpWrappedContent> | undefined,
): string {
  if (!content) return '';
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const inner = (block as AcpWrappedContent).content;
      if (inner && typeof inner === 'object' && typeof (inner as AcpTextContent).text === 'string') {
        return (inner as AcpTextContent).text;
      }
      return typeof (block as AcpTextContent).text === 'string' ? (block as AcpTextContent).text : '';
    })
    .join('');
}
