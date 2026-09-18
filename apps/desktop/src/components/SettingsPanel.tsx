import { useState, type ReactNode } from 'react';
import type {
  AppConfig,
  AppView,
  EndpointTestResult,
  GuardPolicy,
  HostStatus,
  ModelCatalog,
  ModelEndpoint,
} from '@deepwork/protocol';
import {
  AGENT_MODE_LABEL,
  APP_VIEW_LABEL,
  APP_VIEWS,
  DEFAULT_ENDPOINT_CONTEXT_WINDOW,
  SANDBOX_MODE_INFO,
  SANDBOX_MODES,
  SETTINGS_SECTION_LABEL,
  SETTINGS_SECTION_NOTE,
  TERMINAL_SHELL_LABEL,
  TERMINAL_SHELL_NOTE,
  TERMINAL_SHELLS,
  THEME_MODE_LABEL,
  THEME_MODES,
  type AgentMode,
  type SandboxMode,
  type SettingsSection,
  type TerminalShell,
} from '@deepwork/protocol';
import { SettingsNav } from './SettingsNav';
import { DeploySettings } from './DeploySettings';

interface SettingsPanelProps {
  config: AppConfig;
  guard: GuardPolicy;
  /** 模型目录（含「这份清单从哪来」）；null = 还没拉过 */
  catalog: ModelCatalog | null;
  status: HostStatus | null;
  modelKeyStatus: { set: boolean; masked?: string } | null;
  /** 当前分节（由 App 持有并落盘，见 AppConfig.settingsSection） */
  section: SettingsSection;
  onSelectSection: (section: SettingsSection) => void;
  /**
   * 收进设置页的管理面板（技能 / 记忆 / 自动化 / 连接器 / 用量）。
   *
   * 由 **App** 构造好再传进来，而不是让设置页去认识这几个面板的 props：
   * 那些回调全都已经接在 App 上（与它们当年是独立视图时同一份），
   * 设置页只需要「把属于这一节的那块内容渲染出来」。
   */
  panels: Partial<Record<SettingsSection, ReactNode>>;
  onUpdateConfig: (patch: Partial<AppConfig>) => void;
  onUpdateGuard: (patch: Partial<GuardPolicy>) => void;
  onSetApiKey: (key: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onTestEndpoint: (params: { baseUrl: string; apiKey?: string }) => Promise<EndpointTestResult>;
  onRestartKernel: () => Promise<void>;
  onClose: () => void;
}

const MODES: AgentMode[] = ['ptc', 'standard', 'minimal', 'creative'];

/**
 * 沙箱档位来源的显示名。
 *
 * 「环境变量」与「设置里选的」必须分成两句：前者意味着**用户在下面选什么都不生效**，
 * 后者意味着这是他的选择。合成一句「你设的」会让用户对着一个改不动的选项反复尝试。
 * 界面只呈现「这个值从哪来」，不在渲染层重算一遍优先级 ——
 * 谁压过谁是宿主的规则（`resolveSandboxMode`），在这里再实现一次就会漂。
 */
function sandboxSourceLabel(source?: 'product-default' | 'config' | 'env-override'): string {
  if (source === 'env-override') return '环境变量指定（优先于设置）';
  if (source === 'config') return '设置里选的';
  if (source === 'product-default') return '产品默认（你没选过）';
  return '未知';
}

/**
 * 档位的显示名。
 *
 * 文案取自契约层的 `SANDBOX_MODE_INFO`，渲染层不再写第二份中文名 ——
 * 两处同义不同词的后果是「设置里显示『限定工作区』、状态里显示『工作区可写』」，
 * 用户会以为是两个不同的东西。
 */
function sandboxModeLabel(mode?: string): string {
  return SANDBOX_MODE_INFO.find((item) => item.mode === mode)?.label ?? mode ?? '未知';
}

/**
 * 设置页外壳。
 *
 * ── 为什么从「顶部三个页签」改成「左侧分组导航」（2026-09-18）──
 * 三页签装得下「偏好 / 模型 / 安全」，装不下这一版要收进来的东西：技能、记忆、
 * 自动化、连接器、用量原本各自是 rail 上的一级入口，与「对话 / 文件 / 终端」
 * 这类天天点的动作挤在同一根栏上。参考形态（用户给的 WorkBuddy 截图）把管理类
 * 全部收进设置，于是设置页要从 3 节长到 12 节 —— 顶部横排页签到六七个就开始
 * 折行、把页头挤高，而左导航天然可分组、可扩展，且「哪一组里有什么」一眼可见。
 *
 * ── 分组的顺序不是排版偏好 ──────────────────────────────────────────
 * 从「我改完立刻看得见」排到「改完要重启内核 / 动系统」：外观 → 会话默认 → 界面 →
 * 模型 → 功能与数据 → 安全与部署。审批与沙箱刻意压在后面：混在偏好里，
 * 用户会把它当成又一个开关顺手改掉，而它决定的是「允许发生什么」。
 *
 * ── 管理面板的 props 为什么不在这里 ──────────────────────────────────
 * 见 `panels` 的注释：设置页不该知道技能面板需要哪些回调，否则每给某个面板加一个
 * 回调，设置页都要跟着改一次签名 —— 而它根本不关心。
 */
export function SettingsPanel({
  config,
  guard,
  catalog,
  status,
  modelKeyStatus,
  section,
  onSelectSection,
  panels,
  onUpdateConfig,
  onUpdateGuard,
  onSetApiKey,
  onClearApiKey,
  onRefreshModels,
  onTestEndpoint,
  onRestartKernel,
  onClose,
}: SettingsPanelProps) {
  return (
    <div className="page-mask">
      <div className="page">
        <header className="page-head">
          <button type="button" className="icon-btn page-back" onClick={onClose} title="返回对话">
            ←
          </button>
          <div className="page-title">
            <span className="page-title-text">设置</span>
            <span className="page-sub">{SETTINGS_SECTION_LABEL[section]}</span>
          </div>
          <span className="panel-spacer" />
        </header>

        <div className="settings-body">
          <SettingsNav section={section} onSelect={onSelectSection} />

          {/*
            内容列自己滚动（而不是整页滚）：左导航要在长内容里保持可见 ——
            用量页有图表、技能页有几十条记录，让导航跟着滚上去等于每换一节都要先滚回顶。
          */}
          <div className="settings-content">
            <div className="settings-sec-head">
              <span className="settings-sec-title">{SETTINGS_SECTION_LABEL[section]}</span>
              <span className="settings-sec-note">{SETTINGS_SECTION_NOTE[section]}</span>
            </div>

            {section === 'appearance' ? (
              <AppearanceSection config={config} onUpdateConfig={onUpdateConfig} />
            ) : null}

            {section === 'session' ? (
              <SessionSection
                config={config}
                catalog={catalog}
                onUpdateConfig={onUpdateConfig}
                onRefreshModels={onRefreshModels}
              />
            ) : null}

            {section === 'interface' ? <InterfaceSection config={config} onUpdateConfig={onUpdateConfig} /> : null}

            {section === 'model' ? (
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

            {section === 'security' ? (
              <SecuritySection
                config={config}
                guard={guard}
                status={status}
                onUpdateConfig={onUpdateConfig}
                onUpdateGuard={onUpdateGuard}
                onRestartKernel={onRestartKernel}
              />
            ) : null}

            {section === 'deploy' ? <DeploySettings config={config} onUpdateConfig={onUpdateConfig} /> : null}

            {section === 'about' ? <AboutSection config={config} status={status} /> : null}

            {/*
              管理类五节的内容由 App 传进来（见 panels 注释）。
              外壳由这里给：它们当年是独立整页，各自的 page-mask / page-head 已经
              在 embedded 模式下关掉了，所以现在只剩内容本身。
            */}
            {panels[section] ? <div className="settings-embed">{panels[section]}</div> : null}
          </div>
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

interface SectionProps {
  config: AppConfig;
  onUpdateConfig: (patch: Partial<AppConfig>) => void;
}

/**
 * 外观。
 *
 * 只放「改完立刻能看见」的两项。它们排在最前不是偶然：用户对设置页的第一印象
 * 来自「我一改，界面就变了」，这一节是唯一能给出这个反馈的地方。
 * 左侧导航栏的展开/收起**不在这里** —— 它的入口是栏底那个切换按钮，
 * 两处入口写同一个配置会让人怀疑它们是不是同一件事。
 */
function AppearanceSection({ config, onUpdateConfig }: SectionProps) {
  return (
    <>
      <div className="modal-label">主题</div>
      <div className="theme-chips">
        {THEME_MODES.map((mode) => (
          <button
            type="button"
            key={mode}
            className={`theme-chip${config.theme === mode ? ' theme-chip-on' : ''}`}
            onClick={() => onUpdateConfig({ theme: mode })}
          >
            {THEME_MODE_LABEL[mode]}
          </button>
        ))}
      </div>
      <div className="modal-hint">
        {config.theme === 'system'
          ? '跟随系统外观：系统切深色时应用一起切，不必回来改这一项。'
          : '立即生效，不需要重启内核。'}
      </div>

      <label className="modal-check">
        <input
          type="checkbox"
          checked={config.collapseReasoning}
          onChange={(event) => onUpdateConfig({ collapseReasoning: event.target.checked })}
        />
        默认折叠思考过程
      </label>
      <div className="modal-hint">
        只影响显示：思考内容仍然完整地产生并留在记录里，随时可以展开。
      </div>
    </>
  );
}

interface SessionSectionProps extends SectionProps {
  catalog: ModelCatalog | null;
  onRefreshModels: () => Promise<void>;
}

/**
 * 会话默认。
 *
 * 这一节回答的问题是「新建一个会话时，它从什么状态起步」——
 * 模式、模型、推理档位、启动视图都是**新会话的初值**，而不是对已有会话的重写。
 * 全部立即生效（不存在需要重启内核的项），但都只在**下一次新建会话**时才被读到。
 */
function SessionSection({ config, catalog, onUpdateConfig, onRefreshModels }: SessionSectionProps) {
  /** 「重新向内核核对」是个会真的建探针会话的动作，按钮要有忙碌态 */
  const [busy, setBusy] = useState(false);

  return (
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
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onRefreshModels().finally(() => setBusy(false));
          }}
        >
          {busy ? '核对中…' : '重新向内核核对模型目录'}
        </button>
      </div>

      {/*
        按会话模式指定模型（FR-10.2 后半：快模型 / 推理模型分工）。
        顺序沿用上面的 MODES，不在这里另排一遍 —— 两个下拉的同一批选项
        顺序不一致，会让人以为它们是两组不同的东西。
      */}
      <div className="modal-label">按会话模式指定模型（可选）</div>
      <div className="modal-hint">
        轻问答和要动代码的活可以用不同的模型。留空的模式跟随上面的默认模型。
        映射在<strong>新建会话</strong>时生效 —— 会话建好之后改模式不会自动换模型
        （在对话中途静默换模型比不换更糟）；那时要换模型，用会话自己的模型选择器。
      </div>
      {MODES.map((item) => {
        const value = config.modeModels?.[item] ?? '';
        const inCatalog = !value || (catalog?.models ?? []).some((m) => m.id === value);
        return (
          <div className="settings-row" key={item}>
            <label className="settings-field">
              <span>{AGENT_MODE_LABEL[item]}</span>
              <select
                className="settings-input"
                value={value}
                onChange={(event) =>
                  onUpdateConfig({ modeModels: { ...config.modeModels, [item]: event.target.value } })
                }
              >
                <option value="">
                  跟随默认模型{config.defaultModel ? `（${config.defaultModel}）` : '（内核默认）'}
                </option>
                {/* 配置里存着一个当前目录里没有的模型时也要显示它，
                    否则下拉会静默跳到「跟随默认模型」，用户以为已经改回去了 */}
                {inCatalog ? null : <option value={value}>{value}（不在当前清单里）</option>}
                {(catalog?.models ?? []).map((model) => (
                  <option value={model.id} key={`${model.source}:${model.id}`}>
                    {model.label}
                    {model.source === 'endpoint' ? '（自定义端点）' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        );
      })}

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
        候选现在从 APP_VIEWS 出：收进设置页的那五页不再是视图，也就不该出现在这里。
      */}
      <div className="modal-label">启动时打开的视图</div>
      <select
        className="settings-input"
        value={config.lastView}
        onChange={(event) => onUpdateConfig({ lastView: event.target.value as AppView })}
      >
        {APP_VIEWS.map((item) => (
          <option value={item} key={item}>
            {APP_VIEW_LABEL[item]}
          </option>
        ))}
      </select>
    </>
  );
}

/**
 * 界面与终端。
 *
 * 这一节的两组东西看着不相干（文件树深度、终端档位），但它们回答的是同一个问题：
 * **这两个面板长什么样、能做什么**。放在一起是因为用户找它们时的念头是
 * 「我要调一下终端」，而不是「我要改个偏好」。
 */
function InterfaceSection({ config, onUpdateConfig }: SectionProps) {
  return (
    <>
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

      {/*
        终端 shell 档位。
        与主题同类：**选完即刻生效**，不需要重启内核 —— 终端是宿主的进程，
        内核不参与；档位在每次执行命令时解析，所以下一条命令就换 shell。
        这一点必须写在提示里，否则用户会按习惯去找「应用」按钮。
      */}
      <div className="modal-label">终端 shell</div>
      <div className="theme-chips terminal-shell-chips">
        {TERMINAL_SHELLS.map((kind) => (
          <button
            type="button"
            key={kind}
            className={`theme-chip${config.terminalShell === kind ? ' theme-chip-on' : ''}`}
            onClick={() => onUpdateConfig({ terminalShell: kind as TerminalShell })}
          >
            {TERMINAL_SHELL_LABEL[kind]}
          </button>
        ))}
      </div>
      <div className="modal-hint">
        {TERMINAL_SHELL_NOTE[config.terminalShell] ?? ''}{' '}
        改完即刻生效，下一条命令就换 shell，不需要重启内核。
      </div>
    </>
  );
}

/** 关于：这台机器上实际跑着哪些东西。全是只读事实，没有任何可改的项。 */
function AboutSection({ config, status }: { config: AppConfig; status: HostStatus | null }) {
  return (
    <>
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
      <div className="modal-hint">
        这几项都不是设置，改动它们的唯一途径是换机器或改启动方式 ——
        写在这里是为了排障时能直接报出来，而不是让用户去翻日志。
      </div>
    </>
  );
}

interface SecuritySectionProps extends SectionProps {
  guard: GuardPolicy;
  status: HostStatus | null;
  onUpdateGuard: (patch: Partial<GuardPolicy>) => void;
  onRestartKernel: () => Promise<void>;
}

/**
 * 审批与沙箱。
 *
 * ── 为什么沙箱排在审批档位**上面** ──
 * 不是排版偏好：它更根本。审批档位回答「哪些命令要问人」，沙箱回答「命令能不能写成文件」——
 * 模型跑在内核里、用内核自己的工具，命令不过宿主，所以挡住越界写入的一直是这道沙箱，
 * 而不是下面那个档位。两者不分开说，用户会以为自己在设置的档位就是拦下写入的那道闸。
 *
 * ── 拒绝模式的编辑方式 ──
 * 逐行文本，而不是「添加一条」的碎按钮：这些模式是可以用正则思维批量写的，
 * 让用户一次看到全部、一次改完，比让他点十次「新增」更接近他脑子里的动作。
 * 保存前会去掉空行与首尾空白，但**不**做任何模糊化或自动补全 —— 用户写什么就是什么。
 */
function SecuritySection({
  config,
  guard,
  status,
  onUpdateConfig,
  onUpdateGuard,
  onRestartKernel,
}: SecuritySectionProps) {
  const [denyText, setDenyText] = useState(guard.denyPatterns.join('\n'));

  /**
   * 沙箱档位的**草稿**选择（还没落盘前不碰配置）。
   *
   * 与端点表单同一个理由：选档位与「让它生效」是两步，中间隔着一次内核重启。
   * 边选边落盘会让「我选错了但还没重启」也变成已保存的事实。
   * null = 用户从没选过（配置里没有这个键），此时单选框停在当前生效的档位上，
   * 但**不**把它写成选择 —— 「产品默认恰好是 workspace-write」与
   * 「用户明确选了 workspace-write」在界面上与配置里都必须是两件事。
   */
  const [chosen, setChosen] = useState<SandboxMode | null>(config.sandboxMode ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savedMode = config.sandboxMode ?? null;
  const effectiveMode = status?.sandbox?.mode ?? null;
  /** 单选框停在哪：没选过就停在当前生效的那个，让用户一眼看到现状 */
  const shownMode = chosen ?? effectiveMode;
  const needsSave = chosen !== null && chosen !== savedMode;
  const needsRestart = savedMode !== null && savedMode !== effectiveMode;
  const canApply = needsSave || needsRestart;

  /**
   * 保存档位并重启内核。
   *
   * 两件事绑成一个按钮，因为单做任何一件都没有意义：只保存不重启 = 用户以为换好了，
   * 只重启不保存 = 重启用的是旧配置。失败时的措辞分两种 ——
   * **已保存但重启失败**要明确说「选择已经存下了，修好后再点一次即可」，
   * 否则用户会以为白选了、回去重选一遍。
   */
  const applySandboxMode = async () => {
    setBusy('sandbox');
    setError(null);
    setMessage(null);
    try {
      if (needsSave) onUpdateConfig({ sandboxMode: chosen as SandboxMode });
      await onRestartKernel();
      setMessage(
        needsSave
          ? `已切到「${sandboxModeLabel(chosen ?? undefined)}」并重启内核，新档位已生效。`
          : '内核已重启，档位生效。',
      );
    } catch (cause) {
      const reason =
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+':\s*/, '')
          : String(cause);
      setError(
        needsSave
          ? `档位已保存，但内核没能重启：${reason}。已保存的选择不会丢 —— 条件允许后点这个按钮再试一次即可生效。`
          : `内核没能重启：${reason}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const saveDeny = () => {
    const patterns = denyText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    onUpdateGuard({ denyPatterns: patterns });
  };

  return (
    <>
      <div className="modal-label">内核沙箱（模型改文件的实际边界）</div>
      <div className="settings-kv">
        <div>
          <span>当前生效</span>
          <code>{status?.sandbox?.mode ?? '未知'}</code>
        </div>
        <div>
          <span>来源</span>
          <code>{sandboxSourceLabel(status?.sandbox?.source)}</code>
        </div>
      </div>

      {/*
        环境变量压住设置页时的提示必须排在最前面。这一档来源优先级最高
        （它是排障用的旁路），有它在时下面选什么都不生效 —— 不说清楚的话，
        用户会反复「选了、保存了、重启了，还是没变」，然后把问题归到软件坏了。
      */}
      {status?.sandbox?.source === 'env-override' ? (
        <div className="modal-hint modal-hint-warn">
          档位由环境变量指定（<code>DEEPWORK_SANDBOX_MODE</code> 或内核的{' '}
          <code>DSH_PERMISSION_MODE</code>），它优先于这里的设置 ——
          你现在选什么都不会生效。要在这里控制档位，请先清掉那个环境变量。
        </div>
      ) : null}
      {status?.sandbox?.rejected ? (
        <div className="modal-hint modal-hint-warn">
          档位「<code>{status.sandbox.rejected}</code>」不是合法值（有人拼错了），
          已跳过它、实际用的是 <code>{status.sandbox.mode}</code>。
          合法值：{SANDBOX_MODES.join(' / ')}。
        </div>
      ) : null}

      {/*
        三档选项。顺序与后果说明都来自契约层的 SANDBOX_MODE_INFO ——
        这里不自己排一遍：档位的宽窄关系是内核事实，在渲染层复制一份就会漂。
      */}
      <div className="sandbox-modes">
        {SANDBOX_MODE_INFO.map((item) => (
          <label
            key={item.mode}
            className={[
              'sandbox-mode',
              shownMode === item.mode ? 'sandbox-mode-on' : '',
              item.emphasis === 'danger' ? 'sandbox-mode-danger' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <input
              type="radio"
              name="sandbox-mode"
              checked={shownMode === item.mode}
              disabled={busy !== null}
              onChange={() => {
                setChosen(item.mode);
                setError(null);
                setMessage(null);
              }}
            />
            <span className="sandbox-mode-body">
              <span className="sandbox-mode-head">
                <span className="sandbox-mode-name">{item.label}</span>
                <code className="sandbox-mode-code">{item.mode}</code>
                {status?.sandbox?.mode === item.mode ? (
                  <span className="sandbox-mode-badge">当前生效</span>
                ) : null}
              </span>
              <span className="sandbox-mode-consequence">{item.consequence}</span>
            </span>
          </label>
        ))}
      </div>

      {/*
        「选了」与「生效了」是两个状态，必须都能看见。
        档位是内核进程的启动参数（见 core-host/src/security/sandbox.ts），
        存进配置只是记下意图，换档要重启内核 —— 这个中间态最容易被做成
        「假装立即生效」，然后在用户重启后才发现没变。
      */}
      {savedMode !== null && savedMode !== status?.sandbox?.mode ? (
        <div className="modal-hint modal-hint-warn">
          已保存为「{sandboxModeLabel(savedMode)}」，但运行中的内核还是原来的档位 ——
          点下面的按钮重启内核后生效（重启不会动你的文件与会话记录）。
        </div>
      ) : null}

      <div className="modal-hint">
        {status?.adapter === 'harness' ? (
          <>
            由内核强制执行，作用于模型在内核里执行的命令。
            {status?.sandbox?.note ? ` ${status.sandbox.note}。` : ''}
          </>
        ) : (
          <>当前跑的是 mock 内核，模型的命令不经内核执行，这道沙箱不参与 —— 档位只在真实内核下才有意义。</>
        )}
      </div>

      <div className="modal-foot">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null || !canApply}
          onClick={() => void applySandboxMode()}
        >
          {busy === 'sandbox' ? '切换中…' : '保存并重启内核'}
        </button>
        {canApply ? null : (
          <span className="modal-hint">
            {chosen === null ? '先选一个档位。' : '当前已是你选中的档位，无需改动。'}
          </span>
        )}
      </div>
      {message ? <div className="modal-hint">{message}</div> : null}
      {error ? <div className="modal-hint modal-hint-warn">{error}</div> : null}

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
      <div className="modal-hint">命中即永久阻断，不询问、不执行。改动会在离开输入框时保存。</div>

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
                onClick={() => onUpdateGuard({ alwaysAllow: guard.alwaysAllow.filter((item) => item !== prefix) })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
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
 * 模型与端点。
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
            端点不会告诉我们这个数，而内核的模型目录必须有它。留空即按{' '}
            {DEFAULT_ENDPOINT_CONTEXT_WINDOW.toLocaleString()} 估计（是估计值，不是探测结果）。
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
          请到「会话默认」修改默认模型，或先点下面「重新向内核核对」。
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
