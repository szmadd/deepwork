/**
 * 技能存储：目录布局、安装、卸载、启停、版本升级。
 *
 * ── 目录布局 ────────────────────────────────────────────────────────
 *   <home>/skills/<name>/     技能本体（SKILL.md + 资源，安装时完整拷贝）
 *   <home>/skills.json        清单：每个技能一条 SkillRecord（含审计留档）
 *
 * 拷贝而非引用：技能源可能在临时目录（安装完即删）。安装 = 把源完整搬进
 * 家目录，此后磁盘上的这份才是生效的那份。
 *
 * ── 安装顺序是不可重排的 ────────────────────────────────────────────
 *   验证清单 → 审计源目录 → critical? 拒绝（源不进家门）
 *            → 暂存拷贝 .staging-<name>/ → rename 到 <name>/
 *            → 写清单
 * 「先拷再审」会把恶意文件先落进家目录，哪怕随后删除也已在磁盘上存在过；
 * 审计永远发生在源目录上、拷贝之前。
 *
 * ── 升级语义 ────────────────────────────────────────────────────────
 * 同名不同 version = 升级：新版本照常过审计，旧目录移 .trash-<name> 后
 * 删除（不用 rm -rf 语义的递归删除工具函数名，这里就是受控的目录替换，
 * 且只发生在自家 skills/ 目录内，路径由清单 name 派生、已拒绝路径分隔符）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SkillAuditReport, SkillInstallResult, SkillRecord } from '@deepwork/protocol';
import { homeDir, readJson, writeJson } from '../paths';
import { parseSkillMd, SkillManifestError } from './manifest';
import { auditSkillDir } from './audit';

const SKILL_MD = 'SKILL.md';

export class SkillStore {
  private readonly root: string;

  constructor(baseDir?: string) {
    this.root = path.join(baseDir ?? homeDir(), 'skills');
  }

  skillsDir(): string {
    return this.root;
  }

  list(): SkillRecord[] {
    const manifest = readJson<Record<string, SkillRecord>>(this.manifestPath(), {});
    // 清单与磁盘对齐：目录没了的技能从清单剔除（防手删目录后出现幽灵记录）
    const result: SkillRecord[] = [];
    for (const [name, record] of Object.entries(manifest)) {
      if (fs.existsSync(this.skillDir(name))) result.push(record);
    }
    if (result.length !== Object.keys(manifest).length) {
      writeJson(this.manifestPath(), Object.fromEntries(result.map((r) => [r.manifest.name, r])));
    }
    return result.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  /**
   * 安装（含审计前置）。
   * source 是技能源目录的绝对路径；URL/市场来源在拉取层落成本地目录后走同一条路。
   */
  install(source: string): SkillInstallResult {
    const src = path.resolve(source);
    if (!fs.existsSync(path.join(src, SKILL_MD))) {
      return { ok: false, audit: emptyReport(), reason: `源目录缺 ${SKILL_MD}：${src}` };
    }

    let parsed;
    try {
      parsed = parseSkillMd(fs.readFileSync(path.join(src, SKILL_MD), 'utf8'));
    } catch (err) {
      const message = err instanceof SkillManifestError ? err.message : String(err);
      return { ok: false, audit: emptyReport(), reason: `清单不合法：${message}` };
    }

    // 审计发生在源目录上、任何拷贝之前
    const audit = auditSkillDir(src);
    const critical = audit.findings.filter((f) => f.severity === 'critical');
    if (critical.length > 0) {
      return {
        ok: false,
        audit,
        reason: `审计发现 ${critical.length} 项 critical 风险，已拒绝安装（源目录未进入家目录）`,
      };
    }

    const { manifest } = parsed;
    const target = this.skillDir(manifest.name);
    const staging = path.join(this.root, `.staging-${manifest.name}`);

    fs.mkdirSync(this.root, { recursive: true });
    rmDirIfExists(staging);
    copyDir(src, staging);

    // 升级：先移走旧目录再就位；全新安装则直接 rename
    if (fs.existsSync(target)) {
      const trash = path.join(this.root, `.trash-${manifest.name}`);
      rmDirIfExists(trash);
      fs.renameSync(target, trash);
      try {
        fs.renameSync(staging, target);
      } catch (err) {
        // 就位失败回滚旧版本
        fs.renameSync(trash, target);
        throw err;
      }
      rmDirIfExists(trash);
    } else {
      fs.renameSync(staging, target);
    }

    const record: SkillRecord = {
      manifest,
      source: src,
      installedAt: new Date().toISOString(),
      enabled: true,
      audit,
    };
    const manifestMap = readJson<Record<string, SkillRecord>>(this.manifestPath(), {});
    manifestMap[manifest.name] = record;
    writeJson(this.manifestPath(), manifestMap);
    return { ok: true, audit, record };
  }

  uninstall(name: string): boolean {
    if (!isValidName(name)) return false;
    const dir = this.skillDir(name);
    if (!fs.existsSync(dir)) return false;
    rmDirIfExists(dir);
    const manifestMap = readJson<Record<string, SkillRecord>>(this.manifestPath(), {});
    if (!(name in manifestMap)) return false;
    delete manifestMap[name];
    writeJson(this.manifestPath(), manifestMap);
    return true;
  }

  toggle(name: string, enabled: boolean): SkillRecord | null {
    if (!isValidName(name)) return null;
    const manifestMap = readJson<Record<string, SkillRecord>>(this.manifestPath(), {});
    const record = manifestMap[name];
    if (!record || !fs.existsSync(this.skillDir(name))) return null;
    record.enabled = enabled;
    manifestMap[name] = record;
    writeJson(this.manifestPath(), manifestMap);
    return record;
  }

  /** 干跑审计：只看报告，不动任何状态 */
  auditOnly(source: string): SkillAuditReport {
    const src = path.resolve(source);
    if (!fs.existsSync(path.join(src, SKILL_MD))) {
      throw new Error(`源目录缺 ${SKILL_MD}：${src}`);
    }
    return auditSkillDir(src);
  }

  /** 供宿主把已启用技能目录交给内核（触发匹配是内核侧职责） */
  enabledSkillDirs(): string[] {
    return this.list()
      .filter((r) => r.enabled)
      .map((r) => this.skillDir(r.manifest.name));
  }

  private skillDir(name: string): string {
    return path.join(this.root, name);
  }

  private manifestPath(): string {
    return path.join(this.root, '..', 'skills.json');
  }
}

function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && !name.includes('/') && !name.includes('\\');
}

function rmDirIfExists(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** 受控目录拷贝：跳过符号链接（防链接把家目录外内容带进来），只拷常规文件与目录 */
function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function emptyReport(): SkillAuditReport {
  return { findings: [], scannedFiles: 0, totalBytes: 0, auditedAt: new Date().toISOString() };
}
