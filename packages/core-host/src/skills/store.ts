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
import type { SkillAuditFinding, SkillAuditReport, SkillInstallResult, SkillManifest, SkillRecord } from '@deepwork/protocol';
import { homeDir, readJson, writeJson } from '../paths';
import { parseSkillMd, SkillManifestError } from './manifest';
import { auditSkillDir } from './audit';
import { SKILL_MD } from './constants';
import { materializeSkillSource, type MaterializedSkill } from './fetch';

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
   * source 是技能源目录的绝对路径。URL 来源在拉取层落成本地目录后走同一条路
   * （见 installFromUrl）—— 这里不关心它是从哪来的。
   *
   * `originLabel` 只影响**记录里写下什么**（清单的 source 字段）：URL 安装时
   * 传原始 URL，这样清单里留下的是用户能再次访问的东西，而不是一个
   * 装完就被删掉的临时目录路径。
   */
  install(source: string, originLabel?: string): SkillInstallResult {
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
    const { manifest } = parsed;

    // 同版本已安装 = no-op：契约承诺「只比较字符串相等性做同版本已安装判断」。
    // 刻意放在审计之前 —— no-op 不落任何磁盘内容，源里即使查出 critical
    // 也阻止不了「什么都不做」这件事；把 no-op 伪装成全新安装成功才是要拦的。
    // list() 已剔除「目录被手删」的幽灵记录，能查到即视为真实已装。
    const existing = this.list().find((r) => r.manifest.name === manifest.name);
    if (existing && existing.manifest.version === manifest.version) {
      return { ok: true, reinstalled: true, audit: existing.audit, record: existing };
    }

    // 审计发生在源目录上、任何拷贝之前
    const audit = withManifestFindings(auditSkillDir(src), manifest);
    const critical = audit.findings.filter((f) => f.severity === 'critical');
    if (critical.length > 0) {
      return {
        ok: false,
        audit,
        reason: `审计发现 ${critical.length} 项 critical 风险，已拒绝安装（源目录未进入家目录）`,
      };
    }

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
      source: originLabel ?? src,
      installedAt: new Date().toISOString(),
      enabled: true,
      audit,
    };
    const manifestMap = readJson<Record<string, SkillRecord>>(this.manifestPath(), {});
    manifestMap[manifest.name] = record;
    writeJson(this.manifestPath(), manifestMap);
    return { ok: true, audit, record };
  }

  /**
   * 从 URL 安装（M2-C 遗留）。
   *
   * 三步：下载并落成临时目录 → 走 install（同一条审计与拷贝路径）→ 清理临时目录。
   *
   * 失败一律返回结果对象而不是抛错：这条路上「失败」的种类很多（网络、
   * 形态不对、缺 SKILL.md、审计阻断），每一种都得让用户在界面上看到原因 ——
   * 抛出去让上层笼统 catch 一句「安装失败」，等于把最有用的那句话丢掉。
   */
  async installFromUrl(url: string, options?: { workDir?: string }): Promise<SkillInstallResult> {
    let materialized: MaterializedSkill | null = null;
    try {
      materialized = await materializeSkillSource({
        source: url,
        workDir: options?.workDir ?? path.join(homeDir(), 'tmp'),
      });
      const result = this.install(materialized.dir, url.trim());
      // 来源摘要跟着结果回去：URL 安装有两个用户看不见的中间步骤（下载、剥壳），
      // 出问题时「下载到的到底是不是我以为的那个东西」是第一个要回答的问题
      return { ...result, source: materialized.digest };
    } catch (error) {
      return {
        ok: false,
        audit: emptyReport(),
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // 临时目录里是**未经审计**的外部内容，无论成败都不留：
      // 成功时它已被拷进技能目录，失败时留着也没有任何用处
      materialized?.cleanup();
    }
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

  /** 干跑审计：只看报告，不动任何状态。附带清单解析结果 —— 「这个包根本
   *  装不上」必须在用户确认安装之前就能看到，而不是确认之后才报。 */
  auditOnly(source: string): SkillAuditReport {
    const src = path.resolve(source);
    if (!fs.existsSync(path.join(src, SKILL_MD))) {
      throw new Error(`源目录缺 ${SKILL_MD}：${src}`);
    }
    const audit = auditSkillDir(src);
    try {
      const { manifest } = parseSkillMd(fs.readFileSync(path.join(src, SKILL_MD), 'utf8'));
      return { ...withManifestFindings(audit, manifest), manifest };
    } catch (err) {
      const message = err instanceof SkillManifestError ? err.message : String(err);
      return { ...audit, manifestError: message };
    }
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

/**
 * 清单层面的发现补进审计报告：缺 description 不阻断安装（有 '' 兜底），
 * 但 description 是语义匹配与「/」补全的输入，缺失会让触发质量静默打折 ——
 * 记一条 warn 让作者/用户看见，而不是装完才发现「装了但没被匹配到过」。
 * 插入位置保持在 info 级发现之前，不破坏「severity 降序」的排列纪律。
 */
function withManifestFindings(audit: SkillAuditReport, manifest: SkillManifest): SkillAuditReport {
  if (manifest.description.trim()) return audit;
  const finding: SkillAuditFinding = {
    rule: 'missing-description',
    severity: 'warn',
    file: SKILL_MD,
    line: 0,
    message: 'frontmatter 缺 description：该技能仍会被启用，但语义匹配与「/」补全缺少输入，触发质量会打折',
    snippet: '',
  };
  const infoAt = audit.findings.findIndex((f) => f.severity === 'info');
  const findings = [...audit.findings];
  if (infoAt === -1) findings.push(finding);
  else findings.splice(infoAt, 0, finding);
  return { ...audit, findings };
}
