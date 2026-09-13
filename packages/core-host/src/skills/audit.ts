/**
 * 安装前安全审计引擎。
 *
 * ── 它防什么 ────────────────────────────────────────────────────────
 * 技能是「别人写的、会跑在你机器上的指令」。审计引擎在安装**之前**扫描
 * 源目录（不先进家门），按规则找四类风险：
 *
 *   1. 破坏性命令     rm -rf / del /S /Q / 格式化 / 裸写磁盘设备
 *   2. 远程代码执行   curl … | sh / powershell -EncodedCommand / Invoke-Expression
 *   3. 凭据与环境窃取 读 ~/.ssh、id_rsa、.credentials；process.env 内容外发
 *   4. 隐藏载荷       双扩展名（report.md.exe）、PE/ELF 可执行二进制、
 *                     base64 解码落地（规避明文扫描的经典手法）
 *
 * ── 分级语义 ────────────────────────────────────────────────────────
 *   critical → 拒绝安装（store 层强制，不落盘）
 *   warn     → 允许安装，发现永久留档在清单（UI 可展示「这个技能有前科」）
 *   info     → 提示性（超大文件、node_modules 之类），不影响安装
 *
 * ── 刻意的取舍 ──────────────────────────────────────────────────────
 * 规则是启发式的，按行正则匹配。它不是沙箱：拦不住语义层面的混淆
 * （如把危险命令拆进多行字符串再拼起来）。定位是「把 99% 的粗制恶意包
 * 与 100% 的误打包事故挡在安装之前」，深度防御靠运行时的审批网关 ——
 * 两层各自承担，不指望一层包打天下。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SkillAuditFinding, SkillAuditReport, SkillAuditSeverity } from '@deepwork/protocol';

/** 单文件内容扫描超过此字节数时跳过逐行扫描，记 info（防规避扫描的超大载荷与防扫描器拖死） */
const MAX_SCAN_BYTES = 1_000_000;
/** 目录总大小超过此值记 warn */
const MAX_TOTAL_BYTES = 50_000_000;

interface LineRule {
  rule: string;
  severity: SkillAuditSeverity;
  /** 匹配后的人读前缀 */
  label: string;
  patterns: RegExp[];
}

/** 行级规则表。顺序即报告顺序，数据驱动便于测试与扩展。 */
const LINE_RULES: LineRule[] = [
  {
    rule: 'destructive-command',
    severity: 'critical',
    label: '破坏性命令',
    patterns: [
      /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i,
      /\brm\s+-[a-z]*r[a-z]*f/i,
      /\bdel\s+\/[sq]/i,
      /\brd\s+\/s/i,
      /\bformat\s+[a-z]:/i,
      /\bmkfs(\.\w+)?\b/i,
      /\bdd\s+[^\n]*\bof=\/dev\/(sd|nvme|disk)/i,
      /\bshutdown\b|\breboot\b/i,
    ],
  },
  {
    rule: 'remote-code-exec',
    severity: 'critical',
    label: '远程代码执行',
    patterns: [
      /\b(curl|wget|iwr|invoke-webrequest)[^\n|]{0,400}\|\s*(sudo\s+)?(ba)?sh\b/i,
      /\bpowershell[^\n]{0,200}-(enc|encodedcommand)\b/i,
      /\binvoke-expression\b|\biex\s+\$/i,
      /\beval\s*\(\s*(atob|window\.atob|buffer\.from)[^\n]{0,100}base64/i,
      /\bnc\s+-e\b|\bbash\s+-i\s+>&\s*\/dev\/tcp/i,
    ],
  },
  {
    rule: 'obfuscated-payload',
    severity: 'critical',
    label: '混淆载荷',
    patterns: [
      /\bbase64\s+(-d|--decode)\b/i,
      /\bcertutil\s+-decode\b/i,
      /\bopenssl\s+enc\s+-d\b/i,
    ],
  },
  {
    rule: 'secrets-access',
    severity: 'warn',
    label: '访问凭据路径',
    patterns: [
      /~\/\.ssh\b|\bid_rsa\b|\bid_ed25519\b|\b\.aws\b|\b\.credentials\b/i,
      /\/\.ssh\/|\\\.ssh\\/i,
      /\bcredentials\.ya?ml\b|\b\.netrc\b|\b\.env\b(?!iron)/i,
    ],
  },
  {
    rule: 'env-exfiltration',
    severity: 'warn',
    label: '读取环境变量',
    patterns: [
      /\bprocess\.env\b/,
      /\bGet-ChildItem\s+Env:/i,
      /\bprintenv\b|\benv\b\s*\|\s*(curl|wget)/i,
    ],
  },
  {
    rule: 'network-egress',
    severity: 'warn',
    label: '外部网络请求',
    patterns: [
      /\bcurl\s+(?!.*localhost)[^\n]{0,300}https?:\/\//i,
      /\bwget\s+[^\n]{0,300}https?:\/\//i,
      /\binvoke-webrequest\b|\binvoke-restmethod\b|\biwr\s+http/i,
      /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[a-z0-9.-]+/i,
    ],
  },
];

/** 双扩展名：最后两个扩展名中，外层是文档、内层是可执行 */
const DOC_EXTS = new Set(['.md', '.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.jpg', '.png', '.gif']);
const EXE_EXTS = new Set(['.exe', '.bat', '.cmd', '.ps1', '.sh', '.scr', '.vbs', '.js', '.com', '.msi', '.jar']);

export function auditSkillDir(dir: string): SkillAuditReport {
  const findings: SkillAuditFinding[] = [];
  let scannedFiles = 0;
  let totalBytes = 0;

  const files = collectFiles(dir, findings);
  for (const { rel, abs } of files) {
    const stat = fs.statSync(abs);
    totalBytes += stat.size;

    // 文件级检查（与内容无关）
    pushFileLevelFindings(findings, rel, abs, stat.size);

    if (stat.size > MAX_SCAN_BYTES) {
      findings.push({
        rule: 'oversized-file',
        severity: 'info',
        file: rel,
        line: 0,
        message: `文件 ${stat.size} 字节，超过逐行扫描上限，内容未审计`,
        snippet: '',
      });
      continue;
    }

    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) continue; // 可执行二进制已由文件级规则处理
    scannedFiles++;

    const lines = buf.toString('utf8').split(/\r?\n/);
    pushLineFindings(findings, rel, lines);
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    findings.push({
      rule: 'oversized-package',
      severity: 'warn',
      file: '(package)',
      line: 0,
      message: `技能目录共 ${(totalBytes / 1_000_000).toFixed(1)}MB，异常偏大`,
      snippet: '',
    });
  }

  findings.sort(bySeverityThenLine);
  return {
    findings,
    scannedFiles,
    totalBytes,
    auditedAt: new Date().toISOString(),
  };
}

function bySeverityThenLine(a: SkillAuditFinding, b: SkillAuditFinding): number {
  const order: Record<SkillAuditSeverity, number> = { critical: 0, warn: 1, info: 2 };
  if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

/** 递归收集文件（跳过符号链接 —— 链接可以指向家目录外，审计必须看真实拷贝会拿到的内容） */
function collectFiles(dir: string, findings: SkillAuditFinding[]): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  const walk = (current: string, rel: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
          findings.push({
            rule: 'vendored-deps',
            severity: 'warn',
            file: `${relPath}/(dir)`,
            line: 0,
            message: `技能包含 ${entry.name}/ 目录：应发布为纯静态资源，携带依赖树不可审计`,
            snippet: '',
          });
          continue;
        }
        walk(abs, relPath);
      } else if (entry.isFile()) {
        out.push({ rel: relPath, abs });
      }
    }
  };
  walk(dir, '');
  return out;
}

function pushFileLevelFindings(
  findings: SkillAuditFinding[],
  rel: string,
  abs: string,
  size: number,
): void {
  const base = path.basename(rel);
  const ext = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length);
  const innerExt = path.extname(stem).toLowerCase();

  // 双扩展名：report.md.exe —— 文档是伪装，真身是可执行
  if (ext && DOC_EXTS.has(innerExt) && EXE_EXTS.has(ext)) {
    findings.push({
      rule: 'double-extension',
      severity: 'critical',
      file: rel,
      line: 0,
      message: `双扩展名文件（${innerExt}${ext}）：文档外壳包着可执行，典型的伪装载荷`,
      snippet: base,
    });
  }

  // 可执行二进制：读 magic bytes
  if (EXE_EXTS.has(ext) || size >= 4) {
    const fd = fs.openSync(abs, 'r');
    const head = Buffer.alloc(4);
    const read = fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (read === 4) {
      if (head[0] === 0x4d && head[1] === 0x5a) {
        findings.push({
          rule: 'native-executable',
          severity: 'critical',
          file: rel,
          line: 0,
          message: 'PE 可执行文件（MZ 头），技能包不应携带原生二进制',
          snippet: '',
        });
      } else if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
        findings.push({
          rule: 'native-executable',
          severity: 'critical',
          file: rel,
          line: 0,
          message: 'ELF 可执行文件，技能包不应携带原生二进制',
          snippet: '',
        });
      }
    }
  }
}

function pushLineFindings(findings: SkillAuditFinding[], rel: string, lines: string[]): void {
  // 同文件内按规则收集命中，供组合升级判定
  const hitsByRule = new Map<string, SkillAuditFinding[]>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of LINE_RULES) {
      if (rule.patterns.some((re) => re.test(line))) {
        const finding: SkillAuditFinding = {
          rule: rule.rule,
          severity: rule.severity,
          file: rel,
          line: i + 1,
          message: `${rule.label}：${line.trim().slice(0, 120)}`,
          snippet: line.trim().slice(0, 200),
        };
        findings.push(finding);
        if (!hitsByRule.has(rule.rule)) hitsByRule.set(rule.rule, []);
        hitsByRule.get(rule.rule)!.push(finding);
      }
    }
  }

  // 组合升级：同一文件既碰凭据/环境变量又有外网出口 → 窃取链路成立，critical
  const exfilSources = [...(hitsByRule.get('secrets-access') ?? []), ...(hitsByRule.get('env-exfiltration') ?? [])];
  const egress = hitsByRule.get('network-egress');
  if (exfilSources.length > 0 && egress && egress.length > 0) {
    findings.push({
      rule: 'exfiltration-combo',
      severity: 'critical',
      file: rel,
      line: exfilSources[0].line,
      message: '同文件内既有凭据/环境变量访问又有外网请求：疑似数据外发链路',
      snippet: exfilSources[0].snippet,
    });
  }
}

function looksBinary(buf: Buffer): boolean {
  // 含 NUL 字节几乎必是二进制；UTF-8 解码失败率高也按二进制处理
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  if (probe.includes(0)) return true;
  let bad = 0;
  const text = buf.toString('utf8');
  for (const ch of text.slice(0, 4096)) {
    if (ch === '\uFFFD') bad++;
  }
  return bad > 8;
}
