import { useState } from 'react';
import type { ConnectorConfig, ConnectorState } from '@deepwork/protocol';
import { validateConnectorConfig } from '@deepwork/protocol';
import { describeError } from '../api';

interface ConnectorsPanelProps {
  /** 当前内核类型：mock 内核没有 MCP 能力，面板如实标注 */
  adapter: 'mock' | 'harness' | null;
  connectors: ConnectorState[];
  onRefresh: () => Promise<void>;
  onAdd: (config: ConnectorConfig) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
  /** 重启内核使清单生效；失败会抛出，由面板原样展示 */
  onRestartKernel: () => Promise<void>;
  onClose: () => void;
}

/**
 * 连接器管理面板（MCP）。
 *
 * ── 分工如实呈现 ──
 * DeepWork 只管清单：连接、工具发现与注册由内核的 dsh-mcp-client 插件托管，
 * 工具以 mcp__<名称>__ 前缀进入内核工具列表。这里不显示「已连接/未连接」——
 * DeepWork 不掌握实时连接状态，显示了就是造假；生效时机与查看口径写在提示里。
 *
 * ── 生效语义 ──
 * 插件只在内核启动时加载：增删启停只改清单，必须重启内核才生效。
 * 面板给出醒目的提示与「重启内核」按钮，不让用户以为改完即生效。
 */
export function ConnectorsPanel({
  adapter,
  connectors,
  onRefresh,
  onAdd,
  onRemove,
  onToggle,
  onRestartKernel,
  onClose,
}: ConnectorsPanelProps) {
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restarted, setRestarted] = useState(false);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusyName(name);
    setError(null);
    try {
      await fn();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusyName(null);
    }
  };

  const restart = async () => {
    setRestarting(true);
    setError(null);
    setRestarted(false);
    try {
      await onRestartKernel();
      setRestarted(true);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="page-mask">
      <div className="page">
        <div className="page-head">
          <button type="button" className="icon-btn page-back" onClick={onClose} title="返回对话">
            ←
          </button>
          <span className="page-title-text">连接器</span>
          <span className="panel-spacer" />
        </div>

        <div className="page-body">
          {error ? <div className="banner banner-error">{error}</div> : null}
          {restarted ? <div className="banner banner-info">内核已重启，当前连接器清单已生效。</div> : null}

          <div className="modal-hint modal-hint-warn">
            连接器是外部 MCP server（文件系统、GitHub、数据库等工具源）。
            <strong>连接器由内核在启动时加载，变更后需重启内核生效</strong>；
            启用的连接器会把工具注册为 <code>mcp__名称__工具名</code>。
            连接与重连由内核托管，实时连接状态以内核日志为准。
          </div>

          {adapter === 'mock' ? (
            <div className="modal-hint modal-hint-warn">
              当前为 mock 内核，连接器不生效（mock 没有 MCP 能力）。清单可以照常维护，
              切换到真实内核后随启动加载。
            </div>
          ) : null}

          {connectors.length === 0 && !showForm ? (
            <div className="empty-hint">还没有连接器。点击「添加连接器」，给出名称与启动命令即可。</div>
          ) : null}

          {connectors.map((state) => (
            <div className={`schedule-item${state.config.enabled ? '' : ' schedule-item-off'}`} key={state.config.name}>
              <div className="schedule-row">
                <label className="modal-check">
                  <input
                    type="checkbox"
                    checked={state.config.enabled}
                    disabled={busyName === state.config.name}
                    onChange={(event) => void act(state.config.name, () => onToggle(state.config.name, event.target.checked))}
                  />
                  <span className="schedule-title connector-name">{state.config.name}</span>
                </label>
                <span className="panel-spacer" />
                <button
                  type="button"
                  className="btn-tiny btn-danger"
                  disabled={busyName === state.config.name}
                  onClick={() => void act(state.config.name, () => onRemove(state.config.name))}
                >
                  删除
                </button>
              </div>
              <div className="schedule-desc">
                {state.config.command}
                {state.config.args?.length ? ` ${state.config.args.join(' ')}` : ''}
              </div>
              <div className="schedule-meta">
                工具前缀 mcp__{state.config.name}__
                {state.config.env && Object.keys(state.config.env).length > 0
                  ? ` · 环境变量 ${Object.keys(state.config.env).join('、')}`
                  : ''}
              </div>
              <div className="schedule-meta" title={state.note}>
                {state.config.enabled ? '启用中 · 内核（重）启动后生效' : '已停用'}
              </div>
            </div>
          ))}

          {showForm ? (
            <ConnectorForm
              onSubmit={async (config) => {
                setError(null);
                try {
                  await onAdd(config);
                  setShowForm(false);
                } catch (cause) {
                  setError(describeError(cause));
                }
              }}
              onCancel={() => setShowForm(false)}
            />
          ) : null}
        </div>

        <div className="page-foot">
          <button type="button" className="btn" onClick={() => void onRefresh()}>
            刷新
          </button>
          <button
            type="button"
            className="btn"
            disabled={restarting || adapter === 'mock'}
            title={adapter === 'mock' ? 'mock 内核无需重启（连接器不生效）' : '停止并重新拉起内核进程，使连接器清单生效'}
            onClick={() => void restart()}
          >
            {restarting ? '重启中…' : '重启内核'}
          </button>
          <span className="panel-spacer" />
          {!showForm ? (
            <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
              添加连接器
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            返回对话
          </button>
        </div>
      </div>
    </div>
  );
}

/** 添加表单：名称 / 命令 / 参数 / 环境变量（每行一个 KEY=VALUE） */
function ConnectorForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (config: ConnectorConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 参数按行拆分（一行一个参数；带空格的参数维持在一行内） */
  const args = argsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const env: Record<string, string> = {};
  let envError: string | null = null;
  for (const line of envText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      envError = `环境变量行缺少 KEY=VALUE 形式：${trimmed}`;
      break;
    }
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }

  const config: ConnectorConfig = {
    name: name.trim(),
    command: command.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    enabled: true,
  };
  const invalid = envError ?? validateConnectorConfig(config);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(config);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="schedule-form">
      <div className="modal-label">添加连接器</div>
      {error ? <div className="banner banner-error">{error}</div> : null}

      <input
        className="settings-input"
        placeholder="名称（小写字母/数字/中划线，如 github —— 工具名前缀 mcp__github__）"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <input
        className="settings-input"
        placeholder="命令（如 npx 或某个可执行文件的绝对路径）"
        value={command}
        onChange={(event) => setCommand(event.target.value)}
      />
      <textarea
        className="settings-input settings-textarea"
        rows={2}
        placeholder={'参数（可选，每行一个）\n-y\n@modelcontextprotocol/server-github'}
        value={argsText}
        onChange={(event) => setArgsText(event.target.value)}
      />
      <textarea
        className="settings-input settings-textarea"
        rows={2}
        placeholder={'环境变量（可选，每行一个 KEY=VALUE）\nGITHUB_TOKEN=…'}
        value={envText}
        onChange={(event) => setEnvText(event.target.value)}
      />

      <div className="modal-hint">
        {invalid ?? `将以 ${name.trim() || '<名称>'} 注册，工具形如 mcp__${name.trim() || '<名称>'}__xxx；添加后需重启内核生效。`}
      </div>

      <div className="schedule-form-foot">
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || Boolean(invalid)} onClick={() => void submit()}>
          {busy ? '添加中…' : '添加'}
        </button>
      </div>
    </div>
  );
}
