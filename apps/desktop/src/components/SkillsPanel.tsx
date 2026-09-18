import { useState } from 'react';
import type { SkillAuditReport, SkillInstallResult, SkillRecord } from '@deepwork/protocol';
import { describeSkillSource } from '@deepwork/protocol';
import { describeError, pickWorkspace } from '../api';

interface SkillsPanelProps {
  skills: SkillRecord[];
  onRefresh: () => Promise<void>;
  onAudit: (source: string) => Promise<SkillAuditReport>;
  onInstall: (source: string) => Promise<SkillInstallResult>;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  onUninstall: (name: string) => Promise<void>;
  onClose: () => void;
  /**
   * 嵌进设置页时置 true。
   *
   * 2026-09-18 起技能是设置页里的「功能与数据 → 技能」一节，不再是 rail 上的一级视图。
   * 这个开关只影响**外壳**：不渲染页头（返回箭头与「技能」标题在设置页里是重复的），
   * 页脚里那个「返回对话」也收掉（设置页自己有）。**页体一字不改** ——
   * 两个入口下看到的必须是同一份内容，任何「嵌进来时少显示一点」的写法都会
   * 让同一个缺陷只在其中一个入口可见。
   */
  embedded?: boolean;
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
  embedded,
}: SkillsPanelProps) {
  const [install, setInstall] = useState<InstallState>({ step: 'idle' });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** URL 安装行：默认收起，点「从 URL 安装…」才展开 */
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState('');

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

  /**
   * 从 URL 安装（M2-C 遗留）。
   *
   * 与本地目录那条路的关键差别：**审计没法在下载之前做** —— 内容还在别人
   * 的机器上。所以这里的顺序是「下载 → 审计 → 落盘」，审计仍然在内容进入
   * 技能目录之前（critical 一律拒绝，源目录不进家目录），但报告只能在下完之后
   * 才看得到。这一点必须写在界面上：不说的话，用户会以为这与本地安装
   * 是同一套流程（本地那条能先看报告再决定）。
   */
  const installFromUrl = async () => {
    const source = url.trim();
    if (!source) return;
    setBusy(true);
    setError(null);
    setInstall({ step: 'auditing', source });
    try {
      const result = await onInstall(source);
      setInstall({ step: 'done', result });
      if (result.ok) {
        await onRefresh();
        setUrl('');
        setUrlOpen(false);
      }
    } catch (cause) {
      setError(describeError(cause));
      setInstall({ step: 'idle' });
    } finally {
      setBusy(false);
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
    <div className={embedded ? 'panel-embed' : 'page-mask'}>
      <div className="page">
        {embedded ? null : (
          <div className="page-head">
            <button type="button" className="icon-btn page-back" onClick={onClose} title="返回对话">
              ←
            </button>
            <span className="page-title-text">技能</span>
            <span className="panel-spacer" />
          </div>
        )}

        <div className="page-body">
          {error ? <div className="banner banner-error">{error}</div> : null}

          {install.step === 'idle' || install.step === 'done' ? (
            <>
              {urlOpen ? (
                <>
                  <div className="skill-url-row">
                    <input
                      className="settings-input"
                      placeholder="技能地址（zip 归档，或单个 SKILL.md 的 http(s) 链接）"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy || !url.trim()}
                      onClick={() => void installFromUrl()}
                    >
                      {busy ? '安装中…' : '安装'}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setUrlOpen(false);
                        setUrl('');
                      }}
                    >
                      取消
                    </button>
                  </div>
                  <div className="modal-hint">
                    URL 来源的顺序是「先下载、再审计、后落盘」：审计仍然发生在内容进入技能目录之前，
                    critical 会拒绝安装；但报告要等下载完才能看（本地目录那条路可以先看报告再决定）。
                  </div>
                </>
              ) : null}
              {install.step === 'done' ? (
                install.result.ok ? (
                  <div className="modal-hint">
                    {install.result.reinstalled
                      ? `「${install.result.record?.manifest.name}」v${install.result.record?.manifest.version} 已安装，未做改动。`
                      : `已安装「${install.result.record?.manifest.name}」v${
                          install.result.record?.manifest.version
                        }${
                          install.result.audit.findings.length > 0
                            ? `；审计留有 ${install.result.audit.findings.length} 条发现（见下方记录）`
                            : '，审计零发现'
                        }。`}
                    {/* URL 来源多两个看不见的中间步骤，摘要必须显示 ——
                        「装上的到底是不是我以为的那个包」是这里唯一能回答它的地方 */}
                    {install.result.source
                      ? ` 来源：${describeSkillSource(install.result.source)}。`
                      : ''}
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
              {install.audit.manifestError ? (
                <div className="modal-hint modal-hint-warn">
                  清单不合法，这个包装不上：{install.audit.manifestError}
                </div>
              ) : install.audit.manifest ? (
                <div className="modal-hint">
                  将要安装：{install.audit.manifest.name} v{install.audit.manifest.version}
                  {install.audit.manifest.description
                    ? ` —— ${install.audit.manifest.description}`
                    : '（无描述，会记一条警告）'}
                </div>
              ) : null}
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
                disabled={busy || Boolean(install.audit.manifestError)}
                onClick={() => void confirmInstall(install.source)}
              >
                {busy ? '安装中…' : install.audit.manifestError ? '清单不合法，无法安装' : '确认安装'}
              </button>
            </>
          ) : (
            <>
              {embedded ? null : (
                <button type="button" className="btn" onClick={onClose}>
                  返回对话
                </button>
              )}
              <button type="button" className="btn" onClick={() => setUrlOpen(true)}>
                从 URL 安装…
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
