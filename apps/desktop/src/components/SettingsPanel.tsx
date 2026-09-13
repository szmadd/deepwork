import { useState } from 'react';
import type { AppConfig, AppView, GuardPolicy, HostStatus, ModelDescriptor, ModelEndpoint } from '@deepwork/protocol';
import { AGENT_MODE_LABEL, APP_VIEW_LABEL, type AgentMode } from '@deepwork/protocol';

interface SettingsPanelProps {
  config: AppConfig;
  guard: GuardPolicy;
  models: ModelDescriptor[];
  status: HostStatus | null;
  modelKeyStatus: { set: boolean; masked?: string } | null;
  onUpdateConfig: (patch: Partial<AppConfig>) => void;
  onUpdateGuard: (patch: Partial<GuardPolicy>) => void;
  onSetApiKey: (key: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onRefreshKeyStatus: () => Promise<void>;
  onRestartKernel: () => Promise<void>;
  onClose: () => void;
}

const MODES: AgentMode[] = ['ptc', 'standard', 'minimal', 'creative'];

/**
 * 设置面板。
 *
 * ── 为什么把「偏好」与「安全」分成两栏 ──
 * 主题、默认模型这些是「用起来顺不顺手」；审批档位与拒绝模式是「允许发生什么」。
 * 它们存在两份文件里（config.json / guard.json），界面上也刻意分开。
 * 混成一栏会让「改个主题」和「放宽审批」变成同一种动作 —— 那正是最不该被顺手做掉的事。
 *
 * ── 拒绝模式的编辑方式 ──
 * 逐行文本，而不是「添加一条」的碎按钮：这些模式是可以用正则思维批量写的，
 * 让用户一次看到全部、一次改完，比让他点十次「新增」更接近他脑子里的动作。
 * 保存前会去掉空行与首尾空白，但**不**做任何模糊化或自动补全 —— 用户写什么就是什么。
 */
export function SettingsPanel({
  config,
  guard,
  models,
  status,
  modelKeyStatus,
  onUpdateConfig,
  onUpdateGuard,
  onSetApiKey,
  onClearApiKey,
  onRefreshKeyStatus,
  onRestartKernel,
  onClose,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<'prefs' | 'model' | 'security'>('prefs');
  const [denyText, setDenyText] = useState(guard.denyPatterns.join('\n'));

  const saveDeny = () => {
    const patterns = denyText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    onUpdateGuard({ denyPatterns: patterns });
  };

  return (
    <div className="page-mask">
      <div className="page">
        <div className="page-head">
          <button type="button" className="icon-btn page-back" onClick={onClose} title="返回对话">
            ←
          </button>
          <span className="page-title-text">设置</span>
          <span className="panel-spacer" />
        </div>

        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab${tab === 'prefs' ? ' settings-tab-on' : ''}`}
            onClick={() => setTab('prefs')}
          >
            偏好
          </button>
          <button
            type="button"
            className={`settings-tab${tab === 'model' ? ' settings-tab-on' : ''}`}
            onClick={() => {
              setTab('model');
              void onRefreshKeyStatus();
            }}
          >
            模型
          </button>
          <button
            type="button"
            className={`settings-tab${tab === 'security' ? ' settings-tab-on' : ''}`}
            onClick={() => setTab('security')}
          >
            安全
          </button>
        </div>

        <div className="page-body">
          {tab === 'model' ? (
            <ModelSettings
              config={config}
              status={status}
              keyStatus={modelKeyStatus}
              onUpdateConfig={onUpdateConfig}
              onSetApiKey={onSetApiKey}
              onClearApiKey={onClearApiKey}
              onRestartKernel={onRestartKernel}
            />
          ) : null}
          {tab === 'prefs' ? (
            <>
              <div className="modal-label">新建会话的默认模式</div>
              <select
                className="settings-input"
                value={config.defaultMode}
                onChange={(event) => onUpdateConfig({ defaultMode: event.target.value as AgentMode })}
              >
                {MODES.map((mode) => (
                  <option value={mode} key={mode}>
                    {AGENT_MODE_LABEL[mode]}
                  </option>
                ))}
              </select>

              <div className="modal-label">新建会话的默认模型</div>
              <select
                className="settings-input"
                value={config.defaultModel}
                onChange={(event) => onUpdateConfig({ defaultModel: event.target.value })}
              >
                {models.length === 0 ? <option value={config.defaultModel}>{config.defaultModel}</option> : null}
                {models.map((model) => (
                  <option value={model.id} key={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>

              {/*
                原来这里是「右侧面板默认页签」。右侧并排面板已被活动栏的整页视图取代，
                所以这个设置项升级为「启动时打开哪个视图」—— 它仍然是同一种偏好
                （我通常从哪个页面开始干活），只是可选范围跟着布局一起变宽了。
              */}
              <div className="modal-label">启动时打开的视图</div>
              <select
                className="settings-input"
                value={config.lastView}
                onChange={(event) => onUpdateConfig({ lastView: event.target.value as AppView })}
              >
                {(Object.keys(APP_VIEW_LABEL) as AppView[]).map((item) => (
                  <option value={item} key={item}>
                    {APP_VIEW_LABEL[item]}
                  </option>
                ))}
              </select>

              <div className="settings-row">
                <label className="settings-field">
                  <span>文件树展开深度</span>
                  <input
                    className="settings-input"
                    type="number"
                    min={1}
                    max={8}
                    value={config.treeDepth}
                    onChange={(event) =>
                      onUpdateConfig({ treeDepth: clamp(Number(event.target.value), 1, 8, config.treeDepth) })
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>终端缓冲上限（字符）</span>
                  <input
                    className="settings-input"
                    type="number"
                    min={10_000}
                    step={10_000}
                    value={config.terminalBufferLimit}
                    onChange={(event) =>
                      onUpdateConfig({
                        terminalBufferLimit: clamp(Number(event.target.value), 10_000, 2_000_000, config.terminalBufferLimit),
                      })
                    }
                  />
                </label>
              </div>

              <label className="modal-check">
                <input
                  type="checkbox"
                  checked={config.collapseReasoning}
                  onChange={(event) => onUpdateConfig({ collapseReasoning: event.target.checked })}
                />
                默认折叠思考过程
              </label>

              <div className="modal-label">运行环境</div>
              <div className="settings-kv">
                <div>
                  <span>内核</span>
                  <code>{status ? `${status.adapter} · ${status.version}` : '未知'}</code>
                </div>
                <div>
                  <span>宿主 Node</span>
                  <code>{status?.nodeVersion ?? '未知'}</code>
                </div>
                <div>
                  <span>数据目录</span>
                  <code>{status?.home ?? '未知'}</code>
                </div>
                <div>
                  <span>默认工作区</span>
                  <code>{config.lastWorkspace || status?.workspace || '未设置'}</code>
                </div>
              </div>
            </>
          ) : null}
          {tab === 'security' ? (
            <>
              <div className="modal-label">审批档位</div>
              <select
                className="settings-input"
                value={guard.mode}
                onChange={(event) => onUpdateGuard({ mode: event.target.value as GuardPolicy['mode'] })}
              >
                <option value="normal">标准 —— 只读自动放行，写操作逐次确认</option>
                <option value="strict">严格 —— 一切命令都要确认</option>
                <option value="auto">宽松 —— 写操作也自动放行（仅建议在隔离环境中使用）</option>
              </select>
              {guard.mode === 'auto' ? (
                <div className="modal-hint modal-hint-warn">
                  宽松档位下，Agent 的写操作不再需要你逐次点头。审批链路本身不会失效，
                  但你将失去「看差异再授权」这一步 —— 请确认你清楚这一点。
                </div>
              ) : null}

              <div className="modal-label">硬拒绝模式（每行一条，包含即阻断）</div>
              <textarea
                className="settings-input settings-textarea"
                rows={8}
                value={denyText}
                spellCheck={false}
                onChange={(event) => setDenyText(event.target.value)}
                onBlur={saveDeny}
              />
              <div className="modal-hint">
                命中即永久阻断，不询问、不执行。改动会在离开输入框时保存。
              </div>

              <div className="modal-label">已记住的「始终允许」前缀</div>
              {guard.alwaysAllow.length === 0 ? (
                <div className="empty-hint">暂无。勾选「以后同类命令不再询问」后会累积在这里。</div>
              ) : (
                <div className="settings-chips">
                  {guard.alwaysAllow.map((prefix) => (
                    <span className="settings-chip" key={prefix}>
                      <code>{prefix}</code>
                      <button
                        type="button"
                        className="icon-btn"
                        title="撤销这条授权"
                        onClick={() =>
                          onUpdateGuard({ alwaysAllow: guard.alwaysAllow.filter((item) => item !== prefix) })
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="page-foot">
          <button type="button" className="btn" onClick={onClose}>
            返回对话
          </button>
        </div>
      </div>
    </div>
  );
}

/** 数字输入的兜底：非法值（NaN / 空）保留原值，而不是把它变成 0 */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface ModelSettingsProps {
  config: AppConfig;
  status: HostStatus | null;
  keyStatus: { set: boolean; masked?: string } | null;
  onUpdateConfig: (patch: Partial<AppConfig>) => void;
  onSetApiKey: (key: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onRestartKernel: () => Promise<void>;
}

/**
 * 模型设置页。
 *
 * 三组动作分得很清楚，因为它们的影响面完全不同：
 *  - 内核选择（mock / 真实 Harness）：决定「有没有推理能力」；
 *  - 端点（官方 / 自定义 OpenAI 兼容）：决定「请求发到哪里去」——
 *    本地 Ollama / LM Studio 走自定义端点，是离线运行的入口；
 *  - API key：按模式分存，只显掩码，明文落 secrets.json 而不是 config.json。
 *
 * 内核与端点的变更都要重启内核生效（运行时补丁在组合期应用），
 * 所以页面上有显式的「重启内核」按钮，而不是假装改了立即生效。
 */
function ModelSettings({
  config,
  status,
  keyStatus,
  onUpdateConfig,
  onSetApiKey,
  onClearApiKey,
  onRestartKernel,
}: ModelSettingsProps) {
  const endpoint = config.modelEndpoint;
  // 提供方选择是本地状态：切到「自定义」时模型名往往还没填，此刻就落盘会被
  // 宿主 validateEndpoint 拒绝（报错的还是顶部全局横幅，字段都还没显示出来）。
  // 所以切 custom 只在本地展开输入框，点「保存端点配置」才持久化；
  // 切回 official 永远合法，立即落盘。
  const [kind, setKind] = useState(endpoint.kind);
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl ?? '');
  const [modelName, setModelName] = useState(endpoint.model ?? '');
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<void>, done: string) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+':\s*/, '') : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveEndpoint = () =>
    run(
      'endpoint',
      async () => {
        if (kind === 'custom' && (!baseUrl.trim() || !modelName.trim())) {
          throw new Error('自定义端点需要 baseUrl 与模型名');
        }
        onUpdateConfig({
          modelEndpoint:
            kind === 'custom'
              ? { kind: 'custom', baseUrl: baseUrl.trim(), model: modelName.trim() }
              : { kind: 'official' },
        });
      },
      '端点配置已保存（重启内核生效）',
    );

  return (
    <>
      <div className="modal-label">内核</div>
      <select
        className="settings-input"
        value={config.adapter}
        onChange={(event) => onUpdateConfig({ adapter: event.target.value as AppConfig['adapter'] })}
      >
        <option value="auto">自动 —— 有内核命令才用真实内核（默认 mock）</option>
        <option value="harness">DeepSeek Harness —— 真实内核，失败即报错</option>
        <option value="mock">Mock —— 仅链路验证，无推理能力</option>
      </select>
      <div className="settings-kv">
        <div>
          <span>当前内核</span>
          <code>{status ? `${status.adapter} · ${status.version}` : '未知'}</code>
        </div>
        <div>
          <span>凭据</span>
          <code>{status?.credentialsConfigured ? '已配置' : '未配置'}</code>
        </div>
      </div>

      <div className="modal-label">模型提供方</div>
      <select
        className="settings-input"
        value={kind}
        onChange={(event) => {
          const next = event.target.value as ModelEndpoint['kind'];
          setKind(next);
          if (next === 'official') onUpdateConfig({ modelEndpoint: { kind: 'official' } });
        }}
      >
        <option value="official">DeepSeek 官方（api.deepseek.com）</option>
        <option value="custom">自定义 OpenAI 兼容端点（本地 / 私有）</option>
      </select>

      {kind === 'custom' ? (
        <>
          <div className="modal-label">端点地址（baseUrl）</div>
          <input
            className="settings-input"
            value={baseUrl}
            spellCheck={false}
            placeholder="http://localhost:11434/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <div className="modal-hint">
            Ollama 默认 http://localhost:11434/v1；LM Studio 默认 http://localhost:1234/v1。
            指向本机端点即可离线运行。
          </div>
          <div className="modal-label">模型名（端点上的真实模型 id）</div>
          <input
            className="settings-input"
            value={modelName}
            spellCheck={false}
            placeholder="例如 qwen2.5:7b"
            onChange={(event) => setModelName(event.target.value)}
          />
          <div className="modal-foot">
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void saveEndpoint()}>
              {busy === 'endpoint' ? '保存中…' : '保存端点配置'}
            </button>
          </div>
        </>
      ) : null}

      <div className="modal-label">API key（{endpoint.kind === 'custom' ? '自定义端点' : 'DeepSeek 官方'}）</div>
      <div className="modal-hint">
        {keyStatus?.set ? `已设置：${keyStatus.masked}` : '未设置。本地端点（如 Ollama）可留空，将使用占位值。'}
        key 按提供方分存，只在这里显掩码，明文不会出现在任何界面与日志里。
      </div>
      <div className="settings-row">
        <input
          className="settings-input"
          type="password"
          value={keyInput}
          placeholder={keyStatus?.set ? '输入新 key 以替换' : 'sk-...'}
          spellCheck={false}
          onChange={(event) => setKeyInput(event.target.value)}
        />
      </div>
      <div className="modal-foot">
        <button
          type="button"
          className="btn"
          disabled={busy !== null || !keyInput.trim()}
          onClick={() =>
            void run(
              'key',
              async () => {
                await onSetApiKey(keyInput.trim());
                setKeyInput('');
              },
              'key 已保存并同步到内核凭据',
            )
          }
        >
          {busy === 'key' ? '保存中…' : '保存 key'}
        </button>
        {keyStatus?.set ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void run('key', onClearApiKey, 'key 已清除')}
          >
            清除 key
          </button>
        ) : null}
      </div>

      {message ? <div className="modal-hint">{message}</div> : null}
      {error ? <div className="modal-hint modal-hint-warn">{error}</div> : null}

      <div className="modal-label">生效</div>
      <div className="modal-hint">
        内核选择、端点与连接器的变更在重启内核后生效（运行时补丁在内核启动的组合期应用）。
        有正在运行的任务时不能重启。
      </div>
      <div className="modal-foot">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={() => void run('restart', onRestartKernel, '内核已重启，配置生效')}
        >
          {busy === 'restart' ? '重启中…' : '重启内核使配置生效'}
        </button>
      </div>
    </>
  );
}
