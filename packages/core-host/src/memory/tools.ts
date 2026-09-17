/**
 * 记忆工具的实现（内核自主写记忆）。
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────────
 * 与图表能力的 plan.ts 同一条纪律：**实现只有一份**，由 MCP 服务
 * （memory/mcp-server.ts，真实内核走这条）调用；将来若补一个宿主工具注册，
 * 也复用这里，而不是各写一遍。两处各写一遍的失败形态是「两条入口行为不一致」，
 * 且只有真实内核下才看得出来。
 *
 * ── 两件与权限有关的事 ──────────────────────────────────────────────
 *  1. **画像是禁区。** 它只读注入、影响每一轮对话，修改必须由用户亲手完成
 *     （memory.setProfile）。工具层再拒一次，不依赖调用方记得传对 layer ——
 *     一个能自行改写用户画像的助手，其行为将不再可预测。
 *  2. **预算闸门复用 store 的那一套。** 超限由 store.add 抛可行动错误，
 *     这里原样透出，不改成「写了一半」。语义是「记不下就说记不下」，
 *     而不是看起来记下了。
 *
 * ── 写入的 origin 是 'agent' ────────────────────────────────────────
 * 记忆面板要能区分「谁写的」：用户显式加的、内核自主沉淀的、将来蒸馏出来的。
 * 内核写的一律标 'agent'，用户在面板上一眼能看出哪几条不是自己加的，
 * 也就删得掉。
 */

import {
  isMemoryWriteLayer,
  MEMORY_WRITE_LAYERS,
  memoryReadSectionText,
  memoryWriteResultText,
  type MemoryLayer,
} from '@deepwork/protocol';
import type { MemoryStore } from './store';

/** 记忆工具入参里的层取值（含画像）；用于读工具的校验 */
const READABLE_LAYERS: readonly MemoryLayer[] = ['profile', 'user', 'workspace'];

/**
 * memory_write 的实现：写入一条内核自主沉淀的记忆，返回一段回执。
 * 校验或预算失败时抛错（由调用方按各自协议的失败语义转达）。
 */
export function runMemoryWrite(
  store: MemoryStore,
  args: Record<string, unknown>,
  workspace: string,
): string {
  const layer = args.layer;
  if (!isMemoryWriteLayer(layer)) {
    throw new Error(
      `layer 必须是 ${MEMORY_WRITE_LAYERS.join(' 或 ')}，收到：${layer === undefined ? '（缺失）' : String(layer)}；` +
        `画像是用户亲手维护的，不接受工具写入`,
    );
  }

  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) throw new Error('text 不能为空');

  const entry = store.add(layer, text, { workspace, origin: 'agent' });
  const stat = store.stats(workspace).find((item) => item.layer === layer);
  return memoryWriteResultText({
    layer,
    text: entry.text,
    entries: stat?.entries ?? 1,
    chars: stat?.chars ?? entry.text.length,
    budget: stat?.budget ?? entry.text.length,
  });
}

/**
 * memory_read 的实现：读回三层（或指定一层）的当前内容。
 *
 * 存在的理由不是「模型看不见记忆」—— 记忆在每轮开始时就已注入。它解决的是
 * **写入前查重**：这一轮跑长了、或注入的今日日志被截断时，模型需要一个
 * 权威的「现在到底存了什么」的答案，否则只能重复写。返回值与注入文/面板
 * 同源（都来自 MemoryStore），因此不会出现「面板里没有、模型说有」。
 */
export function runMemoryRead(
  store: MemoryStore,
  args: Record<string, unknown>,
  workspace: string,
): string {
  const raw = args.layer;
  const omitted = raw === undefined || raw === null || raw === '';
  if (!omitted && !READABLE_LAYERS.includes(raw as MemoryLayer)) {
    throw new Error(
      `layer 只能是 ${READABLE_LAYERS.join(' / ')}（省略则读三层），收到：${String(raw)}`,
    );
  }
  const requested = omitted ? READABLE_LAYERS : [raw as MemoryLayer];
  const stats = store.stats(workspace);

  return requested
    .map((layer) => {
      const stat = stats.find((item) => item.layer === layer);
      return memoryReadSectionText({
        layer,
        entries: store.list(layer, workspace),
        chars: stat?.chars ?? 0,
        budget: stat?.budget ?? 0,
        truncated: stat?.truncated ?? false,
      });
    })
    .join('\n\n');
}
