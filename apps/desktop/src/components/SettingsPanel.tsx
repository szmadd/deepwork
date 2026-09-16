import { useState } from 'react';
import type {
  AppConfig,
  AppView,
  EndpointTestResult,
  GuardPolicy,
  HostStatus,
  ModelCatalog,
  ModelEndpoint,
} from '@deepwork/protocol';
import { AGENT_MODE_LABEL, APP_VIEW_LABEL, DEFAULT_ENDPOINT_CONTEXT_WINDOW, type AgentMode } from '@deepwork/protocol';
import { DeploySettings } from './DeploySettings';

interface SettingsPanelProps {
  config: AppConfig;
  guard: GuardPolicy;
  /** 模型目录（含「这份清单从哪来」）；null = 还没拉过 */
  catalog: ModelCatalog | null;
  status: HostStatus | null;
  modelKeyStatus: { set: boolean; masked?: string } | null;
  onUpdateConfig: (patch: Partial<AppConfig>) => void;
  onUpdateGuard: (patch: Partial<GuardPolicy>) => void;
  onSetApiKey: (key: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onRefreshKeyStatus: () => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onTestEndpoint: (params: { baseUrl: string; apiKey?: string }) => Promise<EndpointTestResult>;
  onRestartKernel: () => Promise<void>;
  onClose: () => void;
}

const MODES: AgentMode[] = ['ptc', 'standard', 'minimal', 'creative'];

/**
 * 沙箱模式来源的显示名。
 *
 * `env-override` 刻意不写「你设的」以外的话：产品侧的 `DEEPWORK_SANDBOX_MODE`
 * 与用户直接设的内核变量 `DSH_PERMISSION_MODE` 都归到这一档，而两者谁生效由宿主的
 * 解析优先级决定 —— 界面只呈现「这个值不是产品默认」，不在渲染层重算一遍优先级
 * （那会让同一条规则有两个实现）。
 */
function sandboxSourceLabel(source?: 'product-default' | 'env-override'): string {
  if (source === 'env-override') return '环境变量指定';
  if (source === 'product-default') return '产品默认（内核默认值）';
  return '未知';
}

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
  catalog,
  status,
  modelKeyStatus,
  onUpdateConfig,
  onUpdateGuard,
  onSetApiKey,
  onClearApiKey,
  onRefreshKeyStatus,
  onRefreshModels,
  onTestEndpoint,
  onRestartKernel,
  onClose,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<'prefs' | 'model' | 'security'>('prefs');
  const [denyText, setDenyText] = useState(guard.denyPatterns.join('\n'));
  /** 「重新向内核核对」是个会真的建探针会话的动作，按钮要有忙碌态 */
  const [modelBusy, setModelBusy] = useState(false);

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
              catalog={catalog}
              status={status}
              keyStatus={modelKeyStatus}
              onUpdateConfig={onUpdateConfig}
              onSetApiKey={onSetApiKey}
              onClearApiKey={onClearApiKey}
              onRefreshModels={onRefreshModels}
              onTestEndpoint={onTestEndpoint}
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

              {/*
                默认模型由用户自行选定，候选来自模型目录 —— 官方内核公布的模型与
                自定义端点上的模型在这里不做区别对待（条目标注来源即可）。
                「跟随内核默认」是一个真实可选项而不是缺省占位：内核自己会随版本
                换默认模型，写死一个 id 就是把「内核的默认」变成「我们的猜测」。
              */}
              <div className="modal-label">新建会话的默认模型</div>
              <select
                className="settings-input"
                value={config.defaultModel}
                onChange={(event) => onUpdateConfig({ defaultModel: event.target.value })}
              >
                <option value="">
                  跟随内核默认
                  {catalog?.kernelDefaultModel ? `（当前：${catalog.kernelDefaultModel}）` : '（内核未公布）'}
                </option>
                {/* 清单里没有当前值时也要显示它：否则下拉会跳到第一项，
                    用户以为「已经改回去了」，其实配置里还存着原来那个模型 */}
                {config.defaultModel && !(catalog?.models ?? []).some((m) => m.id === config.defaultModel) ? (
                  <option value={config.defaultModel}>{config.defaultModel}（不在当前清单里）</option>
                ) : null}
                {(catalog?.models ?? []).map((model) => (
                  <option value={model.id} key={`${model.source}:${model.id}`}>
                    {model.label}
                    {model.source === 'endpoint' ? '（自定义端点）' : ''}
                  </option>
                ))}
              </select>
              <div className="modal-hint">
                {catalog ? catalog.note : '尚未拉取模型目录。'}
                {catalog?.checkedAt ? ` · 核对于 ${new Date(catalog.checkedAt).toLocaleTimeString()}` : ''}
              </div>
              <div className="modal-foot">
                <button
                  type="button"
                  className="btn btn-tiny"
                  disabled={modelBusy}
                  onClick={() => {
                    setModelBusy(true);
                    void onRefreshModels().finally(() => setModelBusy(false));
                  }}
                >
                  {modelBusy ? '核对中…' : '重新向内核核对模型目录'}
                </button>
              </div>

              {/*
                推理档位：取值同样来自内核公布（不在这里枚举），空 = 不干预。
                内核没公布这个选项时只留「不干预」—— 编一套看起来合理的档位
                会做出一个「界面能选、内核不认」的开关。
              */}
              <div className="modal-label">默认推理档位</div>
              <select
                className="settings-input"
                value={config.defaultReasoningEffort}
                onChange={(event) => onUpdateConfig({ defaultReasoningEffort: event.target.value })}
              >
                <option value="">不干预（用内核默认）</option>
                {config.defaultReasoningEffort
                && !(catalog?.reasoningEfforts ?? []).some((item) => item.value === config.defaultReasoningEffort) ? (
                  <option value={config.defaultReasoningEffort}>{config.defaultReasoningEffort}（内核未公布）</option>
                ) : null}
                {(catalog?.reasoningEfforts ?? []).map((item) => (
                  <option value={item.value} key={item.value} title={item.description}>
                    {item.label}
                  </option>
                ))}
              </select>
              <div className="modal-hint">
                {(catalog?.reasoningEfforts.length ?? 0) === 0
                  ? '内核未公布推理档位（mock 内核不提供，或尚未核对）。改动在下一轮对话生效。'
                  : `改动在下一轮对话生效；内核当前默认：${catalog?.kernelDefaultReasoningEffort ?? '未知'}`}
              </div>

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

              {/* 部署与运行时（§8.1 / §8.2 / §8.3）：随包 Python 来源、内网 pip 源、环境体检 */}
              <DeploySettings config={config} onUpdateConfig={onUpdateConfig} />
            </>
          ) : null}
          {tab === 'security' ? (
            <>
              {/*
                沙箱排在审批档位**上面**，不是排版偏好：它更根本。
                审批档位回答「哪些命令要问人」，沙箱回答「命令能不能写成文件」——
                模型跑在内核里、用内核自己的工具，命令不过宿主，所以挡住越界写入的
                一直是这道沙箱，而不是下面那个档位。两者不分开说，用户会以为自己
                在设置的档位就是拦下写入的那道闸。
              */}
              <div className="modal-label">内核沙箱（模型改文件的实际边界）</div>
              <div className="settings-kv">
                <div>
                  <span>当前模式</span>
                  <code>{status?.sandbox?.mode ?? '未知'}</code>
                </div>
                <div>
                  <span>来源</span>
                  <code>{sandboxSourceLabel(status?.sandbox?.source)}</code>
                </div>
              </div>
              {status?.sandbox?.rejected ? (
                <div className="modal-hint modal-hint-warn">
                  你设置的沙箱模式「<code>{status.sandbox.rejected}</code>」不是合法值，
                  本次启动实际用的是 <code>{status.sandbox.mode}</code>。
                  合法值：read-only / workspace-write / danger-full-access。
                </div>
              ) : null}
              <div className="modal-hint">
                {status?.adapter === 'harness' ? (
                  <>
                    由内核强制执行，作用于模型在内核里执行的命令。
                    {status?.sandbox?.note ? ` ${status.sandbox.note}。` : ''}
                  </>
                ) : (
                  <>当前跑的是 mock 内核，模型的命令不经内核执行，这道沙箱不参与 —— 模式值只在真实内核下才有意义。</>
                )}
                模式是内核的启动参数：改环境变量（<code>DEEPWORK_SANDBOX_MODE</code>）后需要重启内核才生效。
              </div>

              <div className="modal-label">审批档位（哪些命令要问你）</div>
              <select
                className="settings-input"
                value={guard.mode}
                onChange={(event) => onUpdateGuard({ mode: event.target.value as GuardPolicy['mode'] })}
              >
                <option value="normal">标准 —— 只读自动放行，写操作逐次确认</option>
                <option value="strict">严格 —— 一切命令都要确认</option>
                <option value="auto">宽松 —— 写操作也自动放行（仅建议在隔离环境中使用）</option>
              </select>
              <div className="modal-hint">
                这一档管的是<strong>宿主自己执行的命令</strong>与逐 hunk 写授权。
                模型在内核里跑的命令不经过它 —— 那些命令的写入边界由上面的内核沙箱决定。
              </div>
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
  catalog: ModelCatalog | null;
  status: HostStatus | null;
  keyStatus: { set: boolean; masked?: string } | null;
  onUpdateConfig: (patch: Partial<AppConfig>) => void;
  onSetApiKey: (key: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onTestEndpoint: (params: { baseUrl: string; apiKey?: string }) => Promise<EndpointTestResult>;
  onRestartKernel: () => Promise<void>;
}

/**
 * 模型设置页。
 *
 * 三组动作分得很清楚，因为它们的影响面完全不同：
 *  - 内核选择（mock / 真实 Harness）：决定「有没有推理能力」；
 *  - 端点（官方 / 自定义 OpenAI 兼容）：决定「请求发到哪里去」；
 *  - API key：按模式分存，只显掩码，明文落 secrets.json 而不是 config.json。
 *
 * **端点不决定用哪个模型。** 这句话是有来历的：曾经新建会话会优先取端点里填的模型，
 * 于是用户在偏好页选好的默认模型被端点配置静默覆盖 —— 界面显示一个、实际跑另一个。
 * 端点是「往哪发」，模型是「用哪个」，两件事各有各的设置项。
 *
 * 内核与端点的变更都要重启内核生效（运行时补丁在组合期应用），
 * 所以页面上有显式的「重启内核」按钮，而不是假装改了立即生效。
 */
function ModelSettings({
  config,
  catalog,
  status,
  keyStatus,
  onUpdateConfig,
  onSetApiKey,
  onClearApiKey,
  onRefreshModels,
  onTestEndpoint,
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
  // 上下文窗口是**用户填的**：端点不会告诉我们，dsh 的模型目录又必须有它。
  // 留空即「按估计值处理」（补丁里落 DEFAULT_ENDPOINT_CONTEXT_WINDOW），
  // 界面上如实说明是估计 —— 不把一个猜测写成看起来很精确的数字。
  const [contextWindow, setContextWindow] = useState(
    endpoint.contextWindow !== undefined ? String(endpoint.contextWindow) : '',
  );
  const [keyInput, setKeyInput] = useState('');
  const [testResult, setTestResult] = useState<EndpointTestResult | null>(null);
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
        const parsedWindow = contextWindow.trim() ? Number(contextWindow.trim()) : undefined;
        if (parsedWindow !== undefined && !(Number.isInteger(parsedWindow) && parsedWindow > 0)) {
          throw new Error('上下文窗口应为正整数（token），留空表示按估计值处理');
        }
        onUpdateConfig({
          modelEndpoint:
            kind === 'custom'
              ? {
                  kind: 'custom',
                  baseUrl: baseUrl.trim(),
                  model: modelName.trim(),
                  contextWindow: parsedWindow,
                }
              : { kind: 'official' },
        });
      },
      '端点配置已保存（重启内核生效）',
    );

  /**
   * 测试连接：对**未保存**的输入值发一次真实请求（GET {baseUrl}/models）。
   * 这是把「模型无法访问」的四层原因（服务没起 / 地址错 / key 无效 / 少了 /v1）
   * 在配置的那一刻分开 —— 而不是等一轮对话发出去，换一句端点侧的 Model not found。
   */
  const testConnection = () =>
    run(
      'test',
      async () => {
        const result = await onTestEndpoint({
          baseUrl: baseUrl.trim(),
          apiKey: keyInput.trim() || undefined,
        });
        setTestResult(result);
        if (!result.ok) throw new Error(result.error ?? '连接失败');
      },
      '',
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
            placeholder="http://127.0.0.1:8000/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <div className="modal-hint">
            任意 OpenAI 兼容端点：局域网推理网关（GPUStack / vLLM / SGLang）、
            本机 Ollama（http://localhost:11434/v1）或 LM Studio（http://localhost:1234/v1）。
            填完点下面的「保存端点配置」，再重启内核生效。
          </div>
          <div className="modal-label">模型名（端点上的真实模型 id）</div>
          <input
            className="settings-input"
            value={modelName}
            spellCheck={false}
            placeholder="例如 qwen3-8-27b"
            onChange={(event) => setModelName(event.target.value)}
          />
          <div className="modal-label">上下文窗口（token，可留空）</div>
          <input
            className="settings-input"
            value={contextWindow}
            spellCheck={false}
            inputMode="numeric"
            placeholder={`留空按 ${DEFAULT_ENDPOINT_CONTEXT_WINDOW} 估计`}
            onChange={(event) => setContextWindow(event.target.value)}
          />
          <div className="modal-hint">
            端点不会告诉我们这个数，而内核的模型目录必须有它。留空即按
            {' '}{DEFAULT_ENDPOINT_CONTEXT_WINDOW.toLocaleString()} 估计（是估计值，不是探测结果）。
            实测提醒：端点请求里的 max_tokens 与这里填多少无关，所以别指望它决定压缩时机。
          </div>
          <div className="modal-foot">
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void saveEndpoint()}>
              {busy === 'endpoint' ? '保存中…' : '保存端点配置'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null || !baseUrl.trim()}
              onClick={() => void testConnection()}
            >
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
          </div>
          {testResult?.ok ? (
            <>
              <div className="modal-hint">
                连接正常 · {testResult.latencyMs}ms · 端点公布 {testResult.models.length} 个模型
                {testResult.models.length > 0 ? '（点击回填到模型名）：' : '（/models 为空，模型名仍需手填）'}
              </div>
              {testResult.models.length > 0 ? (
                <div className="modal-foot">
                  {testResult.models.map((id) => (
                    <button key={id} type="button" className="btn btn-tiny" onClick={() => setModelName(id)}>
                      {id}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {/*
        端点生效后内核会按覆盖补丁重新公布目录（只剩端点这一个模型）。
        这里给出「重启 → 核对」的引导，而不是等用户自己去猜为什么清单没变。
      */}
      <div className="modal-label">当前模型目录</div>
      <div className="modal-hint">{catalog ? catalog.note : '尚未拉取。'}</div>
      {config.defaultModel && catalog && catalog.models.length > 0
      && !catalog.models.some((item) => item.id === config.defaultModel) ? (
        <div className="modal-hint modal-hint-warn">
          默认模型「{config.defaultModel}」不在这份目录里 —— 发送时会被宿主在开跑前拦下。
          请到「偏好」修改默认模型，或先点下面「重新向内核核对」。
        </div>
      ) : null}
      {catalog && catalog.models.length > 0 ? (
        <div className="settings-kv">
          {catalog.models.map((model) => (
            <div key={`${model.source}:${model.id}`}>
              <span>{model.source === 'endpoint' ? '端点' : model.source === 'kernel' ? '内核' : 'mock'}</span>
              <code title={model.id}>
                {model.label} · 窗口 {model.contextWindow ? model.contextWindow.toLocaleString() : '未提供'}
              </code>
            </div>
          ))}
        </div>
      ) : null}
      <div className="modal-foot">
        <button type="button" className="btn btn-tiny" disabled={busy !== null} onClick={() => void onRefreshModels()}>
          重新向内核核对
        </button>
      </div>

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
