/**
 * 部署与运行时设置（ROADMAP §八）。
 *
 * ── 为什么这三块放在「偏好」而不是单开一栏 ──────────────────────────────
 * 它们回答的是同一个问题：「这台机器上，应用实际用的是哪一份运行时、
 * 能不能装包、还缺什么」。这与「用起来顺不顺手」是同一类关注点；
 * 而「安全」那栏回答的是「允许发生什么」。分错的代价很具体 ——
 * 用户要改 pip 源时会先去安全栏找，找不到就以为没有这个功能。
 *
 * ── 三条都守同一条纪律：显示事实，不显示猜测 ────────────────────────────
 * Python 来源显示**命中了哪一档**（随包 / 系统 / 显式指定），解析失败时把
 * 「找过哪几个位置」一并列出；体检显示每一项**查到了什么**；pip 源未配置时
 * 就写「未配置」，而不是显示一个看起来像默认值的地址。
 */

import { useEffect, useState } from 'react';
import { describeError, invoke } from '../api';
import { validatePipSource } from '@deepwork/protocol';
import type { AppConfig, PreflightReport, RuntimeStatus } from '@deepwork/protocol';

interface Props {
  config: AppConfig;
  onUpdateConfig: (patch: Partial<AppConfig>) => void;
}

/** 运行时来源的显示名（与「沙箱来源」同一套写法：来源要能一眼看懂） */
const SOURCE_LABEL: Record<NonNullable<RuntimeStatus['source']>, string> = {
  'explicit-env': '环境变量显式指定',
  bundled: '随包运行时',
  'system-path': '系统 PATH',
};

export function DeploySettings({ config, onUpdateConfig }: Props) {
  const [python, setPython] = useState<RuntimeStatus | null>(null);
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // pip 源是**草稿态**：改一个字符就落盘会让「正在输入的一个半截地址」
  // 变成生效配置，而它下一次会被 pip 真的拿去用。保存才生效。
  const [indexUrl, setIndexUrl] = useState(config.pipSource?.indexUrl ?? '');
  const [trustedHost, setTrustedHost] = useState(config.pipSource?.trustedHost ?? '');

  useEffect(() => {
    void invoke('runtime.python', {})
      .then(setPython)
      .catch(() => setPython(null));
  }, []);

  async function runPreflight() {
    setBusy(true);
    setNote(null);
    try {
      const result = await invoke('runtime.preflight', {});
      setReport(result);
    } catch (error) {
      setNote(`体检失败：${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function savePipSource() {
    setNote(null);
    if (!indexUrl.trim()) {
      // 「清空地址」是一个合法意图（= 回到未配置），但要和「填了个无效值」分开说
      onUpdateConfig({ pipSource: undefined });
      setNote('已清空 pip 源：pip 将走它自己的默认源。');
      return;
    }
    const candidate = { indexUrl: indexUrl.trim(), trustedHost: trustedHost.trim() || undefined };
    try {
      validatePipSource(candidate);
    } catch (error) {
      setNote(describeError(error));
      return;
    }
    onUpdateConfig({ pipSource: candidate });
    setNote('pip 源已保存。');
  }

  const blocked = report ? report.checks.filter((item) => !item.ok && item.level === 'block') : [];
  const warned = report ? report.checks.filter((item) => !item.ok && item.level === 'warn') : [];

  return (
    <>
      <div className="modal-label">随包 Python 运行时（内网离线部署用）</div>
      <div className="settings-kv">
        <div>
          <span>当前来源</span>
          <code>{python ? python.label : '查询中…'}</code>
        </div>
        <div>
          <span>命中档位</span>
          <code>{python?.source ? SOURCE_LABEL[python.source] : '未解析到'}</code>
        </div>
        <div>
          <span>解释器路径</span>
          <code>{python?.bin ?? '未找到'}</code>
        </div>
      </div>
      {python && !python.found ? (
        <div className="modal-hint modal-hint-warn">
          本机没有可用的 Python。查找顺序是「环境变量 <code>DEEPWORK_PYTHON_BIN</code> → 随包运行时 →
          系统 PATH」，找过这些位置：
          <br />
          {python.bundledDirs.map((dir) => (
            <code key={dir}>{dir}</code>
          ))}
        </div>
      ) : null}
      <div className="modal-hint">
        随包运行时优先于系统 PATH：目标机上那份 Python 可能是残缺或版本不符的，
        被优先选中后出的问题与环境相关，最难复现。要改用系统那份，设 <code>DEEPWORK_PYTHON_BIN</code> 指定路径。
      </div>

      <div className="modal-label">内网 pip 源（局域网镜像）</div>
      <div className="settings-row">
        <label className="settings-field">
          <span>索引地址</span>
          <input
            className="settings-input"
            placeholder="http://nexus.corp/repository/pypi/simple"
            value={indexUrl}
            onChange={(event) => setIndexUrl(event.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>受信主机（自签证书时填）</span>
          <input
            className="settings-input"
            placeholder="nexus.corp"
            value={trustedHost}
            onChange={(event) => setTrustedHost(event.target.value)}
          />
        </label>
      </div>
      <button className="ghost-button" type="button" onClick={savePipSource}>
        保存 pip 源
      </button>
      <div className="modal-hint">
        地址只经命令行参数传给 pip，**不写目标机的 pip.ini**，也不读它 ——
        配置是「我们这次怎么走」，不是「这台机器以后都这么走」。
        未配置时不伪造默认源：离线机器上 pip 会如实报连不上，比静默连公网好。
      </div>

      <div className="modal-label">环境体检（安装前提）</div>
      <button className="ghost-button" type="button" onClick={() => void runPreflight()} disabled={busy}>
        {busy ? '检查中…' : '运行环境体检'}
      </button>
      {note ? <div className="modal-hint">{note}</div> : null}
      {report ? (
        <div className="settings-kv">
          <div>
            <span>结论</span>
            <code>
              {report.blocked > 0
                ? `未通过：${report.blocked} 项阻断`
                : report.warned > 0
                  ? `通过（${report.warned} 项警告）`
                  : '通过'}
            </code>
          </div>
          <div>
            <span>检查项</span>
            <code>{report.checks.length} 项</code>
          </div>
        </div>
      ) : null}
      {report && blocked.length > 0 ? (
        <div className="modal-hint modal-hint-warn">
          {blocked.map((item) => (
            <div key={item.id}>
              <strong>{item.title}</strong>：{item.detail}
              <br />
              怎么办：{item.remedy}
            </div>
          ))}
        </div>
      ) : null}
      {report && warned.length > 0 ? (
        <div className="modal-hint">
          {warned.map((item) => (
            <div key={item.id}>
              <strong>{item.title}</strong>：{item.detail}
              <br />
              怎么办：{item.remedy}
            </div>
          ))}
        </div>
      ) : null}
      <div className="modal-hint">
        这份报告与安装器用的是同一份实现 —— 「装的时候说没事、用起来才发现缺东西」
        正是因为两边各写了一套判断才成为常态。
      </div>
    </>
  );
}
