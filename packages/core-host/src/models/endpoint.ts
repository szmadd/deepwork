/**
 * 模型端点：把 DeepWork 的「提供方配置」翻译成 dsh 的启动补丁与凭据。
 *
 * ── 生效路径（2026-09-13 两轮取证）──────────────────────────────────
 * 第一版走 `$DSH_HOME/settings.yaml` 的 `llm-deepseek:` 节（dsh 官方
 * 「Models page」路径）。实测它是**热重载**的，与 session/new 公布模型目录
 * 之间存在竞态：同一配置间歇性拿到内置模型目录（25/25 通过后不加改动
 * 变成稳定失败）。热重载的便利换不来确定性 —— 改为与连接器同一条路径：
 * `--patch` 覆盖补丁（按 id 命中 `llm-deepseek` 条目、整体替换 config），
 * 组合期应用、启动即确定；代价是变更需重启内核生效（patchReload: startup）。
 *
 * ── API key 的两级存储 ────────────────────────────────────────────────
 *   ~/.deepwork/secrets.json        按模式各存一份（official / custom 互不覆盖）
 *   $DSH_HOME/.credentials.yaml     dsh 真正读取的凭据文档（refs.DEEPSEEK_API_KEY）
 * 凭据按请求解析（dsh-credentials），不存在启动竞态，可以即时同步。
 * 切换模式时把对应模式的 key 同步进 dsh 凭据；没有就不动（不删别人的 ref）。
 * key 明文永不离开宿主进程 —— RPC 只回掩码。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ENDPOINT_CONTEXT_WINDOW, type ModelEndpoint } from '@deepwork/protocol';
import type { RuntimePatchOverride } from '../mcp/patch';
import { homeDir, readJson, writeJson } from '../paths';

const CREDENTIAL_REF = 'DEEPSEEK_API_KEY';
/** 无 key 端点（局域网网关 / 本地模型）不校验 key，但 OpenAI 客户端要求非空 */
const NO_KEY_PLACEHOLDER = 'deepwork-no-key';

export function dshHomeDir(): string {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}

// ── secrets.json（~/.deepwork）─────────────────────────────────────

interface SecretsFile {
  official?: string;
  custom?: string;
}

function secretsPath(): string {
  return path.join(homeDir(), 'secrets.json');
}

function readSecrets(): SecretsFile {
  return readJson<SecretsFile>(secretsPath(), {});
}

export function getApiKey(mode: 'official' | 'custom'): string | null {
  return readSecrets()[mode] ?? null;
}

export function setApiKey(mode: 'official' | 'custom', key: string): void {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key 不能为空');
  writeJson(secretsPath(), { ...readSecrets(), [mode]: trimmed });
}

export function clearApiKey(mode: 'official' | 'custom'): void {
  const secrets = readSecrets();
  delete secrets[mode];
  writeJson(secretsPath(), secrets);
}

export function maskApiKey(key: string | null): string | undefined {
  if (!key) return undefined;
  const tail = key.slice(-4);
  const head = key.slice(0, Math.min(3, Math.max(0, key.length - 4)));
  return `${head}${'•'.repeat(8)}${tail}`;
}

// ── 端点校验与覆盖补丁 ──────────────────────────────────────────────

export function validateEndpoint(endpoint: ModelEndpoint): void {
  if (endpoint.kind !== 'custom') return;
  if (!endpoint.baseUrl || !/^https?:\/\//.test(endpoint.baseUrl)) {
    throw new Error('自定义端点需要合法的 http(s) 地址，例如 http://127.0.0.1:8000/v1');
  }
  if (!endpoint.model?.trim()) {
    throw new Error('自定义端点需要填写模型名（端点上的真实模型 id）');
  }
  if (endpoint.contextWindow !== undefined && !(Number.isInteger(endpoint.contextWindow) && endpoint.contextWindow > 0)) {
    throw new Error('上下文窗口应为正整数（token），留空表示按估计值处理');
  }
}

/**
 * 自定义端点 → 覆盖补丁条目（llm-deepseek 条目的 config 整体替换）。
 * official 返回 null：内核用内置目录与官方端点，补丁里没有这一项。
 *
 * contextWindow 优先取用户在端点配置里填的值；没填才用估计值
 * （DEFAULT_ENDPOINT_CONTEXT_WINDOW，并在设置页如实标注是估计）。
 * 这个数没法从端点探测出来，而 dsh 的模型目录又必须有它 ——
 * 与其写死一个数字当事实，不如让知道的人填、不知道的人看到「估计」。
 * （它的实际影响未证实：实测请求里 max_tokens 恒 256000，与这里无关。）
 */
export function modelEndpointOverride(endpoint: ModelEndpoint): RuntimePatchOverride | null {
  validateEndpoint(endpoint);
  if (endpoint.kind !== 'custom') return null;
  const modelId = endpoint.model!.trim();
  return {
    id: 'llm-deepseek',
    name: '@deepseek-ai/dsh-llm-deepseek',
    config: {
      baseURL: endpoint.baseUrl!.replace(/\/+$/, ''),
      apiKeyEnv: CREDENTIAL_REF,
      models: [
        {
          id: modelId,
          name: modelId,
          contextWindow: endpoint.contextWindow ?? DEFAULT_ENDPOINT_CONTEXT_WINDOW,
        },
      ],
    },
  };
}

// ── credentials.yaml 的 refs 合并 ───────────────────────────────────

/**
 * 只管理 `refs:` 下的键值行，其余内容逐行保留（包括注释与其它节）。
 * 不引 YAML 库的理由与技能清单解析相同：这里需要的只是「refs 下的键值」
 * 这一种结构，解析器的模糊边界就是配置注入的藏身处。
 */
function spliceCredentialRef(raw: string, key: string, value: string): string {
  const lines = raw.length > 0 ? raw.split('\n') : ['version: 1'];
  if (!lines.some((line) => line.startsWith('version:'))) lines.unshift('version: 1');

  let refsIndex = lines.findIndex((line) => line.trim() === 'refs:');
  if (refsIndex === -1) {
    lines.push('refs:');
    refsIndex = lines.length - 1;
  }
  // refs 节内找既有键（缩进行 "  KEY: ..."），到下一个顶层节为止
  let keyIndex = -1;
  let insertAt = lines.length;
  for (let i = refsIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) {
      insertAt = i;
      break;
    }
    const m = /^\s+([A-Za-z0-9_]+):/.exec(line);
    if (m?.[1] === key) keyIndex = i;
  }
  const entry = `  ${key}: ${value}`;
  if (keyIndex !== -1) lines[keyIndex] = entry;
  else lines.splice(insertAt, 0, entry);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

// ── 对外主入口 ─────────────────────────────────────────────────────

export interface CredentialSyncResult {
  credentialsPath: string;
  /** 本次同步的如实描述，供日志与 UI 展示 */
  detail: string;
}

/**
 * 把当前模式的 key 同步进 dsh 凭据（custom 无 key 写占位值；official 无 key 不动）。
 * 端点本身的生效走 modelEndpointOverride + 运行时补丁，这里只管凭据。
 */
export function syncModelCredentials(endpoint: ModelEndpoint): CredentialSyncResult {
  const home = dshHomeDir();
  fs.mkdirSync(home, { recursive: true });
  const credentialsPath = path.join(home, '.credentials.yaml');

  if (endpoint.kind === 'custom') {
    const key = getApiKey('custom');
    const credRaw = fs.existsSync(credentialsPath) ? fs.readFileSync(credentialsPath, 'utf8') : '';
    fs.writeFileSync(
      credentialsPath,
      spliceCredentialRef(credRaw, CREDENTIAL_REF, key ?? NO_KEY_PLACEHOLDER),
      'utf8',
    );
    return { credentialsPath, detail: `自定义端点凭据${key ? '已同步' : '：无 key（占位值）'}` };
  }

  const key = getApiKey('official');
  if (key) {
    const credRaw = fs.existsSync(credentialsPath) ? fs.readFileSync(credentialsPath, 'utf8') : '';
    fs.writeFileSync(credentialsPath, spliceCredentialRef(credRaw, CREDENTIAL_REF, key), 'utf8');
  }
  return { credentialsPath, detail: `官方端点凭据${key ? '已同步' : '未改动'}` };
}
