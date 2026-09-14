/**
 * 模型目录的**非内核**来源：mock 内核自报的条目。
 *
 * ── 这一版删掉了什么（重要）────────────────────────────────────────
 * 此前这里写死了 DeepSeek 官方的四个模型，带自编的显示名（「DeepSeek V4.1 Flash」）
 * 与自编的 `contextWindow: 256_000`。那份清单的真实性从建立第一天起就没有任何来源：
 * 内核的 configOptions 真帧里既没有这些显示名，也没有 contextWindow 这个字段。
 * 它造成的后果不是「显示得不好看」，而是**任何一次把界面读成事实的判断都是错的** ——
 * 例如「界面显示 DeepSeek-V4.1-Flash、实际内核默认跑的是 deepseek-v4-flash」这种
 * 两个答案都不报错的分歧，只有抓端点请求才看得出来。
 *
 * 现在官方的清单只有一个来源：真实内核的 `session/new` 真帧（见 models/catalog.ts）。
 * 取不到就返回空目录并如实说明，不再用内置清单顶替。
 */

import type { ModelCatalog, ModelDescriptor } from '@deepwork/protocol';
import { emptyCatalog } from './models/catalog';

/** mock 内核自报的链路验证模型。它是我们自己造的，所以写在这里是诚实的。 */
const MOCK_MODEL: ModelDescriptor = {
  id: 'mock-echo',
  label: 'Mock Echo（无推理，仅用于链路验证）',
  provider: 'local',
  supportsPtc: false,
  // 它不经过任何模型服务，没有上下文窗口可言 —— 给 0 会被读成「窗口是 0」，
  // 干脆不给。
  source: 'mock',
};

export function mockCatalog(): ModelCatalog {
  return {
    models: [MOCK_MODEL],
    reasoningEfforts: [],
    kernelDefaultModel: MOCK_MODEL.id,
    kernelDefaultReasoningEffort: null,
    source: 'mock',
    checkedAt: Date.now(),
    note: 'mock 内核：仅 mock-echo 一个条目，无推理能力，也不提供推理档位',
  };
}

/** 拿不到真帧、也没有自定义端点时的空目录（如实说明，而不是回退到内置清单）。 */
export function catalogUnavailable(note: string): ModelCatalog {
  return emptyCatalog(note);
}

export const DEFAULT_MODE = 'ptc';

/**
 * 最后的兜底模型名。
 *
 * **它只在「完全没有可用清单」时才会被用到**（mock 内核、或真实内核取帧失败），
 * 是 `deepseek-flash` 还是别的名字都不再有决定性意义 —— 真正的默认值来自
 * 内核真帧的 currentValue 或用户选定的 `config.defaultModel`。
 * 内核不认这个 id 时 applyModel 会保持内核默认并记日志，不会让任务跑不起来。
 */
export const DEFAULT_MODEL = 'deepseek-flash';
