/**
 * 模型目录解析：把内核 `session/new` 公布的 configOptions 真帧翻成 ModelCatalog。
 *
 * ── 为什么单开一个文件 ──────────────────────────────────────────────
 * 这里全是纯函数，可以拿一段真帧离线断言；而「取真帧」需要拉起内核、需要一个探针会话。
 * 把两者分开，测试就不必为了验「解析对不对」而去启动一整个内核 ——
 * 上一版的教训正相反：清单写死在 models.ts 里，没有任何一层能验它是否与内核一致，
 * 于是自编的显示名与 contextWindow 一路活到了文档里。
 *
 * ── 真帧形状（2026-09-14 `node tools/real-dsh-probe.js`，dsh 0.1.5-rc.1）────
 * ```json
 * { "id": "model", "name": "Model", "category": "model", "type": "select",
 *   "currentValue": "[\"deepseek-official\",\"deepseek-v4-flash\"]",
 *   "options": [{ "group": "deepseek-official", "name": "DeepSeek",
 *                 "options": [{ "value": "[\"deepseek-official\",\"deepseek-flash\"]",
 *                               "name": "DeepSeek-V41-Flash" }] }] }
 * { "id": "reasoning_effort", "type": "select", "currentValue": "high",
 *   "options": [{ "value": "off", "name": "Off", "description": "..." }] }
 * ```
 * 三个必须按实测处理的点：
 *  1. **模型项的值是「提供方 + 模型」的 JSON 字符串数组**，不是裸模型名。
 *     界面上要显示的、会话里要存的、配置里要记的都是数组第二项（裸模型名）；
 *     发给内核的 `session/set_config_option` 必须回原样的数组字符串。
 *  2. **options 可能是分组结构**（`{group, options:[...]}`）也可能是扁平数组，
 *     两种形态在同一个内核的不同配置项上并存，解析必须都认。
 *  3. **没有任何字段带 contextWindow**。想要这个数只能问用户。
 */

import type { ModelCatalog, ModelDescriptor, ReasoningEffortOption } from '@deepwork/protocol';
import type { AcpConfigOption, AcpConfigOptionValue } from '../adapter/acp/protocol';

/** 模型项的 id（内核固定用这个 id 发布可选模型） */
export const MODEL_OPTION_ID = 'model';
/** 推理档位项的 id */
export const REASONING_EFFORT_OPTION_ID = 'reasoning_effort';

/**
 * 解析模型项的 value。
 *
 * 内核把它编码成 `["provider","model"]`；裸模型名（不分组的内核、或 we 自己构造的
 * 占位值）也要能解析 —— 解析不出来时必须退化成「就当它是模型名」，
 * 而不是抛错或返回空：一个解析失败会让整份清单消失，代价远大于收益。
 */
export function parseModelOptionValue(raw: string): { provider: string | null; model: string } {
  const text = typeof raw === 'string' ? raw : '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'string')) {
      const items = parsed as string[];
      return items.length >= 2
        ? { provider: items[0], model: items[1] }
        : { provider: null, model: items[0] };
    }
  } catch {
    // 不是 JSON —— 走下面的裸字符串分支
  }
  return { provider: null, model: text };
}

/** 展平 select 的取值列表：分组结构与扁平结构都认（见文件头第 2 点）。 */
export function flattenOptionValues(option: AcpConfigOption | undefined): AcpConfigOptionValue[] {
  const values: AcpConfigOptionValue[] = [];
  for (const entry of option?.options ?? []) {
    const group = entry as { options?: AcpConfigOptionValue[] };
    if (Array.isArray(group.options)) values.push(...group.options);
    else values.push(entry as AcpConfigOptionValue);
  }
  return values;
}

/**
 * 在模型项里找到与给定模型 id 对应的取值（要原样回给内核的那个字符串）。
 *
 * 匹配顺序刻意是「先裸模型名、再原值」：会话与配置里存的是裸模型名，
 * 拿它去和 `["provider","model"]` 直接比会永远不相等 —— 那正是上一版
 * 用 `value.includes('"'+model+'"')` 这种字符串技巧硬凑的原因。
 * 现在把数组拆开比，语义就明确了。
 */
export function matchModelValue(option: AcpConfigOption | undefined, model: string): string | null {
  const wanted = model.trim();
  if (!wanted) return null;
  for (const item of flattenOptionValues(option)) {
    if (typeof item?.value !== 'string') continue;
    if (item.value === wanted) return item.value;
    if (parseModelOptionValue(item.value).model === wanted) return item.value;
  }
  return null;
}

/** 在任意 select 项里按取值找（推理档位等非模型项用这个）。 */
export function matchPlainValue(option: AcpConfigOption | undefined, value: string): string | null {
  const wanted = value.trim();
  if (!wanted) return null;
  for (const item of flattenOptionValues(option)) {
    if (item?.value === wanted) return item.value;
  }
  return null;
}

export function findOption(configOptions: AcpConfigOption[] | undefined, id: string): AcpConfigOption | undefined {
  return configOptions?.find((item) => item.id === id);
}

/**
 * 从真帧解析出模型清单与推理档位。
 *
 * 返回 null 表示「这份真帧里没有模型项」= 没核对上。此时调用方必须如实说没核对上，
 * 不能拿一份内置清单顶上 —— 那正是这一版要消灭的行为。
 */
export function catalogFromConfigOptions(
  configOptions: AcpConfigOption[] | undefined,
): {
  models: ModelDescriptor[];
  reasoningEfforts: ReasoningEffortOption[];
  kernelDefaultModel: string | null;
  kernelDefaultReasoningEffort: string | null;
} | null {
  const modelOption = findOption(configOptions, MODEL_OPTION_ID);
  if (!modelOption) return null;

  const models: ModelDescriptor[] = [];
  // 分组名（"deepseek-official" → "DeepSeek"）作为 provider 显示；没有分组就用
  // 值里带的那一段。两个都没有时留空串，界面自己决定怎么显示「未知来源」。
  const groupLabel = new Map<string, string>();
  for (const entry of modelOption.options ?? []) {
    const group = entry as { group?: string; name?: string; options?: AcpConfigOptionValue[] };
    if (Array.isArray(group.options) && group.group) groupLabel.set(group.group, group.name ?? group.group);
  }

  for (const item of flattenOptionValues(modelOption)) {
    if (typeof item?.value !== 'string' || !item.value) continue;
    const parsed = parseModelOptionValue(item.value);
    if (!parsed.model) continue;
    models.push({
      // id 是裸模型名 —— 会话与配置里存的是它，不是那个 JSON 数组
      id: parsed.model,
      // 显示名以内核为准。内核没给 name 才退回 id，不自编一个好听的。
      label: item.name?.trim() || parsed.model,
      provider: (parsed.provider && groupLabel.get(parsed.provider)) || parsed.provider || '',
      // 内核帧里没有「这模型支不支持程序化工具调用」这个字段，一律false（未知），
      // 不猜：guess 出来的能力标记会让界面上的开关看起来有依据。
      supportsPtc: false,
      source: 'kernel',
    });
  }

  const effortOption = findOption(configOptions, REASONING_EFFORT_OPTION_ID);
  const reasoningEfforts: ReasoningEffortOption[] = flattenOptionValues(effortOption)
    .filter((item) => typeof item?.value === 'string' && item.value)
    .map((item) => ({
      value: item.value,
      label: item.name?.trim() || item.value,
      description: item.description?.trim() || undefined,
    }));

  const current = modelOption.currentValue ? parseModelOptionValue(modelOption.currentValue) : null;

  return {
    models,
    reasoningEfforts,
    kernelDefaultModel: current?.model || null,
    kernelDefaultReasoningEffort: effortOption?.currentValue?.trim() || null,
  };
}

/** 内核未公布模型目录时的空目录（拿不到真帧、mock 内核都走它）。 */
export function emptyCatalog(note: string, source: ModelCatalog['source'] = 'unknown'): ModelCatalog {
  return {
    models: [],
    reasoningEfforts: [],
    kernelDefaultModel: null,
    kernelDefaultReasoningEffort: null,
    source,
    checkedAt: null,
    note,
  };
}
