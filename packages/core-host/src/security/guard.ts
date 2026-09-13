import path from 'node:path';
import {
  DEFAULT_GUARD_POLICY,
  type GuardPolicy,
  type RiskLevel,
} from '@deepwork/protocol';
import { guardPath, readJson, writeJson } from '../paths';

/**
 * 命令审批安全网关。
 *
 * 这是「本地执行任意命令」这一能力的安全阀，属于不可绕过的路径：
 * 适配层在真正调用 shell 之前必须过一遍 assess()。
 *
 * 分级规则（先判 deny，再判 alwaysAllow，再判只读白名单，最后落到 confirm）：
 *   danger  —— 命中硬拒绝模式，直接阻断，不做执行
 *   safe    —— 只读、无副作用，可自动放行
 *   confirm —— 其余一切写操作，需要用户逐次确认
 *
 * 注意：这是 MVP 级别的静态规则匹配，不是沙箱。真正的隔离应由沙箱 Provider 承担。
 */

export interface Assessment {
  risk: RiskLevel;
  reason: string;
  /** 是否硬阻断（不询问、直接拒绝执行） */
  blocked: boolean;
}

/** 只读 / 无副作用的命令白名单（正则，作用于裁剪后的命令行首部） */
const SAFE_PATTERNS: RegExp[] = [
  /^(ls|dir|pwd|whoami|hostname|date|echo)\b/i,
  /^(cat|type|head|tail|wc|findstr|grep|rg|sed\s+-n)\b/i,
  /^(Get-ChildItem|Get-Content|Select-String|Get-Location|Test-Path)\b/i,
  /^git\s+(status|log|diff|show|branch|remote|describe|rev-parse)\b/i,
  /^(node|npm|pnpm|yarn|python|python3|java|go|cargo|git|docker)\s+(--version|-v|-V)\b/i,
  /^(node|npm)\s+(ls|list|view|info|config\s+get)\b/i,
  /^(tsc|vite|eslint|prettier)\s+--version\b/i,
];

export class Guard {
  private policy: GuardPolicy;

  constructor(policy?: GuardPolicy) {
    this.policy = policy ?? readJson<GuardPolicy>(guardPath(), DEFAULT_GUARD_POLICY);
  }

  get(): GuardPolicy {
    return { ...this.policy };
  }

  set(patch: Partial<GuardPolicy>): GuardPolicy {
    this.policy = { ...this.policy, ...patch };
    writeJson(guardPath(), this.policy);
    return this.get();
  }

  rememberAlwaysAllow(command: string): void {
    const prefix = normalizePrefix(command);
    if (!prefix) return;
    if (this.policy.alwaysAllow.includes(prefix)) return;
    this.policy.alwaysAllow = [...this.policy.alwaysAllow, prefix];
    writeJson(guardPath(), this.policy);
  }

  assess(command: string): Assessment {
    const cmd = command.trim();

    if (!cmd) {
      return { risk: 'danger', reason: '空命令', blocked: true };
    }

    const lower = cmd.toLowerCase();
    for (const pattern of this.policy.denyPatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return {
          risk: 'danger',
          reason: `命中硬拒绝模式「${pattern}」，该命令被策略永久阻断`,
          blocked: true,
        };
      }
    }

    const prefix = normalizePrefix(cmd);
    if (prefix && this.policy.alwaysAllow.some((p) => prefix.startsWith(p))) {
      return { risk: 'safe', reason: `已授权前缀「${prefix}」`, blocked: false };
    }

    for (const pattern of SAFE_PATTERNS) {
      if (pattern.test(cmd)) {
        return { risk: 'safe', reason: '只读命令，命中安全白名单', blocked: false };
      }
    }

    if (this.policy.mode === 'auto') {
      return { risk: 'safe', reason: 'auto 模式：写操作自动放行', blocked: false };
    }

    return {
      risk: 'confirm',
      reason:
        this.policy.mode === 'strict'
          ? 'strict 模式：所有命令均需确认'
          : '可能产生副作用（写入 / 网络 / 构建），需要确认',
      blocked: false,
    };
  }
}

/** 取命令的前两个 token 作为「始终允许」的授权前缀 */
function normalizePrefix(command: string): string {
  return command
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
}

/**
 * 工作区边界校验。返回 true 表示 target 位于 workspace 之内。
 * 注意：必须用 realpath 结果比较，否则符号链接可以绕过。
 */
export function isInsideWorkspace(target: string, workspace: string): boolean {
  const rel = path.relative(path.resolve(workspace), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
