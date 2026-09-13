import type { AgentMode, ModelDescriptor } from '@deepwork/protocol';

/**
 * 模型清单。
 *
 * harness 清单按 2026-09-13 真实内核取证（tools/real-dsh-probe.js 的 session/new
 * configOptions 帧）：内核只提供 deepseek-official 一组四个模型，value 是真实
 * model id，name 是显示名（注意：界面上的「V4.1 Flash」内核里的 id 是 deepseek-flash）。
 * 清单改不得凭印象 —— 内核不给的 id 会被 applyModel 拒绝并静默回退默认，改之前先跑探针。
 */
export function listModels(adapterKind: 'mock' | 'harness'): ModelDescriptor[] {
  const base: ModelDescriptor[] = [
    {
      id: 'deepseek-flash',
      label: 'DeepSeek V4.1 Flash',
      provider: 'DeepSeek',
      supportsPtc: true,
      contextWindow: 256_000,
    },
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      provider: 'DeepSeek',
      supportsPtc: true,
      contextWindow: 256_000,
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      provider: 'DeepSeek',
      supportsPtc: true,
      contextWindow: 256_000,
    },
    {
      id: 'deepseek-v4-flash-vision-exp',
      label: 'DeepSeek V4 Flash Vision（实验）',
      provider: 'DeepSeek',
      supportsPtc: false,
      contextWindow: 256_000,
    },
  ];

  if (adapterKind === 'mock') {
    base.push({
      id: 'mock-echo',
      label: 'Mock Echo（无推理，仅用于链路验证）',
      provider: 'local',
      supportsPtc: false,
      contextWindow: 0,
    });
  }
  return base;
}

export const DEFAULT_MODE: AgentMode = 'ptc';
export const DEFAULT_MODEL = 'deepseek-flash';
