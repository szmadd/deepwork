import { useState } from 'react';
import type { SkillAuditReport, SkillInstallResult, SkillRecord } from '@deepwork/protocol';
import { describeError, pickWorkspace } from '../api';

interface SkillsPanelProps {
  skills: SkillRecord[];
  onRefresh: () => Promise<void>;
  onAudit: (source: string) => Promise<SkillAuditReport>;
  onInstall: (source: string) => Promise<SkillInstallResult>;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onUninstall: (name: string) => Promise<void>;
  onClose: () => void;
}

/** 安装向导的进度：先干跑审计给用户看报告，确认后才真正安装 */
type InstallState =
  | { step: 'idle' }
  | { step: 'auditing'; source: string }
  | { step: 'confirm'; source: string; audit: SkillAuditReport }
  | { step: 'done'; result: SkillInstallResult };

const SEVERITY_LABEL = { critical: '严重', warn: '警告', info: '提示' } as const;

/**
 * 技能面板。
 *
 * ── 为什么安装要先干跑审计再确认 ──
 * 技能 = 别人写的、会跑在你机器上的指令。「安装」按钮直接落盘是把
 * 「看看它有没有问题」和「让它生效」揉成了一步 —— 而这两步恰恰不该是同一步。
 * 这里的流程固定为：选目录 → 展示审计报告（每条发现带文件与行号）→ 用户确认 → 安装。
 * critical 发现时内核会直接拒绝，面板把报告原样摆出来，不替用户遮掩。
 *
 * ── warn 留档的展示 ──
 * 安装时的 warn/info 发现永久留在记录里，列表里可展开查看 ——
 * 「这个技能有什么前科」随时可查，而不是装完就没人记得。
 */
export function SkillsPanel({
  skills,
  onRefresh,
  onAudit,
  onInstall,
  onToggle,
  onUninstall,
  onClose,
}: SkillsPanelProps) {
  const [install, setInstall] = useState<InstallState>({ step: 'idle' });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickAndAudit = async () => {
    setError(null);
    const source = await pickWorkspace();
    if (!source) return;
    setInstall({ step: 'auditing', source });
    try {
      const audit = await onAudit(source);
      setInstall({ step: 'confirm', source, audit });
    } catch (cause) {
      setError(describeError(cause));
      setInstall({ step: 'idle' });
    }
  };

  const confirmInstall = async (source: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await onInstall(source);
      setInstall({ step: 'done', result });
      if (result.ok) await onRefresh();
    } catch (cause) {
      setError(describeError(cause));
      setInstall({ step: 'idle' });
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (name: string) => {
    // 卸载即删目录，不可逆；本地确认一次，不让误触直接毁掉一个技能
    if (!window.confirm(`卸载技能「${name}」？其目录将从数据目录中删除。`)) return;
    setError(null);
    try {
      await onUninstall(name);
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  return (
    <div className="page-mask">
      <div className="page">
        <div className="page-head">
          <button type="button" className="icon-btn page-back" onClick={onClose} title="返回对话">
            ←
          </button>
          <span className="page-title-text">技能</span>
          <span className="panel-spacer" />
        </div>

        <div className="page-body">
          {error ? <div className="banner banner-error">{error}</div> : null}

          {install.step === 'idle' || install.step === 'done' ? (
            <>
              {install.step === 'done' ? (
                install.result.ok ? (
                  <div className="modal-hint">
                    已安装「{install.result.record?.manifest.name}」v
                    {install.result.record?.manifest.version}
                    {install.result.audit.findings.length > 0
                      ? `；审计留有 ${install.result.audit.findings.length} 条发现（见下方记录）`
                      : '，审计零发现'}
                    。
                  </div>
                ) : (
                  <div className="modal-hint modal-hint-warn">
                    安装被拒绝：{install.result.reason ?? '未知原因'}
                  </div>
                )
              ) : null}

              {skills.length === 0 ? (
                <div className="empty-hint">
                  还没有安装技能。技能是一个含 SKILL.md 的目录，安装前会先过安全审计。
                </div>
              ) : (
                skills.map((skill) => (
                  <div className="skill-item" key={skill.manifest.name}>
                    <div className="skill-row">
                      <label className="modal-check">
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          onChange={(event) => void onToggle(skill.manifest.name, event.target.checked)}
                        />
                        <span className="skill-name">{skill.manifest.name}</span>
                      </label>
                      <code className="skill-version">v{skill.manifest.version}</code>
                      <span className="panel-spacer" />
                      {skill.audit.findings.length > 0 ? (
                        <button
                          type="button"
                          className="btn-tiny"
                          onClick={() =>
                            setExpanded(expanded === skill.manifest.name ? null : skill.manifest.name)
                          }
                        >
                          审计发现 {skill.audit.findings.length} 条{expanded === skill.manifest.name ? ' ▴' : ' ▾'}
                        </button>
                      ) : (
                        <span className="skill-clean">审计零发现</span>
                      )}
                      <button
                        type="button"
                        className="btn-tiny btn-danger"
                        onClick={() => void uninstall(skill.manifest.name)}
                      >
                        卸载
                      </button>
                    </div>
                    <div className="skill-desc">{skill.manifest.description || '（无描述）'}</div>
                    <div className="skill-source" title={skill.source}>
                      来源：{skill.source} · 装于 {skill.installedAt.slice(0, 10)}
                      {!skill.enabled ? ' · 已停用（对内核不可见）' : ''}
                    </div>
                    {expanded === skill.manifest.name ? (
                      <AuditFindings audit={skill.audit} />
                    ) : null}
                  </div>
                ))
              )}
            </>
          ) : null}

          {install.step === 'auditing' ? (
            <div className="empty-hint">正在审计 {install.source} …</div>
          ) : null}

          {install.step === 'confirm' ? (
            <>
              <div className="modal-label">安装前审计报告</div>
              <div className="skill-source" title={install.source}>
                源目录：{install.source}
              </div>
              <div className="modal-hint">
                扫描 {install.audit.scannedFiles} 个文本文件 / 共 {install.audit.totalBytes} 字节，
                {install.audit.findings.length === 0
                  ? '未发现风险。'
                  : `发现 ${install.audit.findings.length} 条（critical 会阻断安装）。`}
              </div>
              <AuditFindings audit={install.audit} />
              <div className="modal-hint">
                确认后技能目录将完整拷贝进数据目录；审计发现会随记录永久留档。
              </div>
            </>
          ) : null}
        </div>

        <div className="page-foot">
          {install.step === 'confirm' ? (
            <>
              <button type="button" className="btn" onClick={() => setInstall({ step: 'idle' })}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void confirmInstall(install.source)}
              >
                {busy ? '安装中…' : '确认安装'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose}>
                返回对话
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void pickAndAudit()}>
                从本地目录安装…
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AuditFindings({ audit }: { audit: SkillAuditReport }) {
  if (audit.findings.length === 0) return null;
  return (
    <div className="skill-findings">
      {audit.findings.map((finding, index) => (
        <div className={`skill-finding skill-finding-${finding.severity}`} key={index}>
          <span className="skill-finding-head">
            <span className="skill-severity">{SEVERITY_LABEL[finding.severity]}</span>
            <code>{finding.rule}</code>
            <span className="panel-spacer" />
            <code>
              {finding.file}
              {finding.line > 0 ? `:${finding.line}` : ''}
            </code>
          </span>
          <div>{finding.message}</div>
          {finding.snippet ? <pre className="skill-snippet">{finding.snippet}</pre> : null}
        </div>
      ))}
    </div>
  );
}
