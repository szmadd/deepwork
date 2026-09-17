import { useEffect, useRef, useState } from 'react';
import {
  AGENT_MODE_LABEL,
  APP_VIEW_LABEL,
  CHART_HTML_MARKER,
  type AgentMode,
  type AppView,
  type AttachmentPreview,
  type ModelDescriptor,
} from '@deepwork/protocol';
import { formatBytes, describeError } from './api';
import { ActivityRail } from './components/ActivityRail';
import { PanelPage } from './components/PanelPage';
import { Sidebar } from './components/Sidebar';
import { ChatStream } from './components/ChatStream';
import { Composer } from './components/Composer';
import { ApprovalDialog } from './components/ApprovalDialog';
import { TrajectoryPanel } from './components/TrajectoryPanel';
import { FileTreePanel } from './components/FileTreePanel';
import { TerminalPanel } from './components/TerminalPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { SkillsPanel } from './components/SkillsPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { SchedulesPanel } from './components/SchedulesPanel';
import { ConnectorsPanel } from './components/ConnectorsPanel';
import { UsagePanel, formatTokens } from './components/UsagePanel';
import { BrowserPanel } from './components/BrowserPanel';
import { AttachmentBar } from './components/AttachmentBar';
import { useAgent } from './useAgent';
import { useTheme } from './useTheme';

const MODES: AgentMode[] = ['ptc', 'standard', 'minimal', 'creative'];

/**
 * 模型条目的来源提示（挂在下拉的 title 上）。
 *
 * 为什么不塞进选项文字里：下拉只有一行宽，「DeepSeek-V4-Flash（内核 session/new 公布）」
 * 会把真正的模型名挤掉。但来源必须能查到 —— 「这个条目的显示名是内核说的，还是我们编的」
 * 是判断界面可信度的关键信息，上一版正是编的，而且没留任何痕迹。
 */
function modelSourceHint(item: ModelDescriptor): string {
  const window = item.contextWindow ? `${item.contextWindow} token` : '未提供';
  switch (item.source) {
    case 'kernel':
      return `${item.id} · 内核 session/new 公布（provider: ${item.provider || '未知'}）· 上下文窗口 ${window}`;
    case 'endpoint':
      return `${item.id} · 自定义端点 ${item.endpoint ?? '(未填地址)'} · 上下文窗口 ${window}`;
    default:
      return `${item.id} · ${item.label}`;
  }
}

/** 打开某个视图前要拉的数据：面板的唯一事实来源在内核侧，不缓存第二份 */
const VIEW_REFRESH: Partial<
  Record<AppView, 'skills' | 'memory' | 'schedules' | 'connectors' | 'usage' | 'browser' | 'files'>
> = {
  skills: 'skills',
  memory: 'memory',
  schedules: 'schedules',
  connectors: 'connectors',
  usage: 'usage',
  browser: 'browser',
  files: 'files',
};

/**
 * 应用外壳。
 *
 * ── 布局契约（M2-J 起）──
 * ```
 * [活动栏] [会话列表?] [主区视图]
 * ```
 *  1. **活动栏（rail）是唯一的功能入口。** 此前八个功能挤在标题栏里横向排列，
 *     每加一个功能就多占一截宽度，窄窗口下只能换行把标题挤成一列字。竖排栏宽固定，
 *     第 10 个功能与第 1 个占用同样空间。理由见 `ActivityRail` 注释。
 *  2. **会话列表只在对话视图出现。** 管理类页面（技能 / 设置…）把主区全部让出来，
 *     否则它们又要和会话列表争宽度 —— 而那正是它们从弹窗里搬出来要解决的问题。
 *  3. **对话视图仍是「它说要改的」与「磁盘上真的变成了什么样」能对上眼的地方**：
 *     文件与终端从右侧并排改为整页，是形态上的取舍（见 DEVLOG），
 *     但两者的数据来源与高亮口径一字未改。
 *
 * 审批仍然是弹窗，且是唯一的弹窗：它的语义确实是「打断你，处理完再回来」。
 */
export default function App() {
  const agent = useAgent();
  // 主题：档位来自 config，解析与系统偏好订阅在 hook 里（config 未就绪时按浅色）
  useTheme(agent.config?.theme);
  const [view, setView] = useState<AppView>('chat');
  const [mode, setMode] = useState<AgentMode>('ptc');
  const [model, setModel] = useState<string>('');
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentPreview | null>(null);

  // 切换会话时，模式与模型跟随会话设置
  useEffect(() => {
    if (agent.current) {
      setMode(agent.current.mode);
      setModel(agent.current.model);
    }
  }, [agent.current?.id, agent.current?.mode, agent.current?.model]);

  // 首次拿到配置后，回到上次所在的视图 —— 但**只在用户还没动过左侧栏时**。
  //
  // 配置是异步到达的。原先写成「只要 config 变了就 setView(config.lastView)」，
  // 于是存在一条很隐蔽的竞争：用户在配置回来之前点了某个视图，配置随后到达，
  // 第 75 行那次 setView 会把他刚点的页面顶掉 —— 表现是「点了没反应，还停在对话页」。
  // 这个缺陷第一次出现是在 `ui-tree.png` 里：回执是 `ok`（按钮确实被点到了），
  // 画面却还是对话页。回执与画面不一致时必须两个都查，只信一个就会漏掉它。
  //
  // 恢复只做一次（viewRestoredRef）：之后 config 因任何原因变化都不再改视图。
  const viewRestoredRef = useRef(false);
  const viewPinnedRef = useRef(false);
  useEffect(() => {
    if (!agent.config || viewRestoredRef.current) return;
    viewRestoredRef.current = true;
    if (!viewPinnedRef.current) setView(agent.config.lastView);
  }, [agent.config]);

  const running = agent.activeRunId !== null;

  /*
   * 技能清单要尽早拉一次：`/` 补全的候选就是它，而清单原本只在打开技能
   * 视图时才拉。那样「刚启动就在输入框打 /」会一个候选都看不到，
   * 看起来像补全坏了 —— 而用户没有任何办法知道「先去看一眼技能页」是前提。
   * 拿到之后不再重复拉（清单由技能页那边的操作负责刷新）。
   */
  useEffect(() => {
    if (!agent.ready || agent.skills.length > 0) return;
    void agent.refreshSkills();
  }, [agent.ready, agent.skills.length]);

  // 就绪判定以内核 RPC 是否成功为准，而不是等 UI 收到 ready 事件
  // （窗口可能在 host.ready 发出之后才加载完成，只信事件会永久卡在「启动中」）
  const disabled = !agent.ready;
  const showStarting = !agent.ready || agent.hostState.state === 'restarting';

  /*
   * 「端点配置改了、内核还是按旧端点起来的」。
   *
   * 两个值都由宿主给（status.kernelEndpoint / status.configEndpoint），界面只做相等比较 ——
   * 判据不在渲染层自己重算，否则同一条规则会有第二份实现，而它们不一致的那天没人看得见。
   *
   * 为什么这件事必须显式提示，而不是留在设置页里当一句说明：它的后果不是「设置没生效」，
   * 而是**接下来每一轮都打到旧端点**。内网部署现场的形状是配置指向内网端点、内核仍打官方
   * 地址，于是表现为「消息发出去了、一直没有回应」—— 没有报错、没有回复，用户唯一的线索
   * 是一条永远转圈的 run。补丁在启动的组合期应用，这件事只能靠重启解决。
   */
  const endpointPending = Boolean(
    agent.status && agent.status.kernelEndpoint !== agent.status.configEndpoint,
  );
  const [endpointRestarting, setEndpointRestarting] = useState(false);
  const [endpointRestartError, setEndpointRestartError] = useState<string | null>(null);

  const restartForEndpoint = async () => {
    setEndpointRestarting(true);
    setEndpointRestartError(null);
    try {
      await agent.restartKernel();
    } catch (cause) {
      setEndpointRestartError(describeError(cause));
    } finally {
      setEndpointRestarting(false);
    }
  };

  /**
   * 切视图。
   *
   * 视图本身也落盘：下次打开停在同一页。刷新数据在这里做而不是在每个面板的
   * useEffect 里各做一遍 —— 面板只是渲染，不负责「什么时候该重新问内核」。
   */
  const openView = (next: AppView) => {
    // 用户一动手就锁住视图：此后配置再到达也不再把它顶回去（原因见上面的 useRef 注释）。
    viewPinnedRef.current = true;
    switch (VIEW_REFRESH[next]) {
      case 'skills':
        void agent.refreshSkills();
        break;
      case 'memory':
        void agent.refreshMemories();
        break;
      case 'schedules':
        void agent.refreshSchedules();
        break;
      case 'connectors':
        void agent.refreshConnectors();
        break;
      case 'usage':
        void agent.refreshUsage();
        break;
      case 'browser':
        void agent.refreshBrowser();
        break;
      case 'files':
        void agent.refreshTree();
        break;
      default:
        break;
    }
    setView(next);
    // 无条件写盘：这是只含 lastView 一个键的幂等 patch。
    // 「先和当前 config 比一下再决定写不写」看着更省，但 config 尚未就绪时比较的两侧
    // 分别是新值和 undefined，判断本身就是错的来源 —— 少一个分支比省一次写盘重要。
    void agent.updateConfig({ lastView: next });
  };

  const backToChat = () => openView('chat');

  return (
    <div className="app">
      <ActivityRail
        view={view}
        onSelect={openView}
        changedCount={agent.changedPaths.size}
        pendingApprovals={agent.approvals.length}
        /*
          展开态来自 config（落盘，下次启动保持）。config 未就绪时按默认展开渲染 ——
          与 DEFAULT_CONFIG.railExpanded 一致，避免「先展开、配置一到又塌回去」的闪烁。
        */
        expanded={agent.config?.railExpanded ?? true}
        onToggleExpand={() =>
          void agent.updateConfig({ railExpanded: !(agent.config?.railExpanded ?? true) })
        }
      />

      {view === 'chat' ? (
        <Sidebar
          sessions={agent.sessions}
          currentId={agent.current?.id ?? null}
          currentWorkspace={agent.current?.workspace ?? null}
          status={agent.status}
          hostState={agent.hostState}
          onSelect={(id) => void agent.selectSession(id)}
          onCreate={() => void agent.createSession()}
          onOpenWorkspace={() => void agent.openWorkspace()}
          onRemove={(id) => void agent.removeSession(id)}
          onRename={(id, title) => void agent.renameSession(id, title)}
        />
      ) : null}

      <main className="main">
        {/*
          横幅放在视图切换之外：内核起不来时，用户在哪个页面都需要看见这一句。
          把它塞进对话视图会让「为什么什么都点不动」只在某一个页面上有答案。
        */}
        {agent.error ? (
          <div className="banner banner-error">
            <span>{agent.error}</span>
            <button type="button" className="icon-btn" onClick={agent.dismissError}>
              ×
            </button>
          </div>
        ) : null}

        {showStarting ? (
          <div className="banner banner-warn">
            {agent.hostState.detail || '内核正在启动，请稍候…'}
          </div>
        ) : null}

        {endpointPending && !showStarting ? (
          <div className="banner banner-warn">
            <span>
              模型端点配置已改，但内核仍是按<strong>旧端点</strong>启动的 ——
              现在发消息会打到旧端点（内网环境下就是「一直没有回应」）。
            </span>
            <button
              type="button"
              className="btn-tiny"
              disabled={endpointRestarting || running}
              title={running ? '有正在运行的任务，先中断或等它结束' : '停止并重新拉起内核进程，使端点配置生效'}
              onClick={() => void restartForEndpoint()}
            >
              {endpointRestarting ? '重启中…' : '重启内核使配置生效'}
            </button>
            {endpointRestartError ? <span className="banner-detail">{endpointRestartError}</span> : null}
          </div>
        ) : null}

        {agent.notifyWarning ? (
          <div className="banner banner-warn">
            <span>桌面通知未能发出：{agent.notifyWarning}（窗口切走时不会收到提醒）</span>
            <button type="button" className="icon-btn" onClick={agent.dismissNotifyWarning}>
              ×
            </button>
          </div>
        ) : null}

        {agent.scheduleNotice ? (
          <div className="banner banner-info schedule-notice">
            <span>
              定时任务「{agent.scheduleNotice.title}」已触发，正在另一个会话中运行。
            </span>
            <button type="button" className="btn-tiny" onClick={() => void agent.dismissScheduleNotice(true)}>
              跳转到会话
            </button>
            <button type="button" className="icon-btn" onClick={() => void agent.dismissScheduleNotice(false)}>
              ×
            </button>
          </div>
        ) : null}

        {view === 'chat' ? (
          <>
            <header className="topbar">
              <div className="topbar-title">
                <div className="topbar-title-row">
                  {/*
                    标题必须包一层元素并自己负责省略号。
                    直接放裸文本的话，它在 flex 行里是一个匿名伸缩项：一旦被挤窄，
                    中文会逐字换行，标题就变成竖着的一列字 —— 看起来像排版崩了，
                    实际上是「没有可以截断的盒子」。
                  */}
                  <span className="topbar-title-text" title={agent.current?.title ?? ''}>
                    {agent.current?.title ?? '未选择会话'}
                  </span>
                  {agent.current ? <span className="topbar-id">{agent.current.id}</span> : null}
                </div>
                {/*
                  工作区放在标题下方并以按钮形式呈现：它是 Agent 全部文件操作的边界，
                  用户随时能看见「它现在能碰哪些文件」，比藏在设置里更安全。
                */}
                {agent.current ? (
                  <button
                    type="button"
                    className="topbar-workspace"
                    title="当前会话绑定的工作区；点击可另选目录开新会话"
                    onClick={() => void agent.openWorkspace()}
                  >
                    {agent.current.workspace}
                  </button>
                ) : null}
              </div>

              <div className="topbar-controls">
                <label className="control">
                  <span>模式</span>
                  <select value={mode} onChange={(event) => setMode(event.target.value as AgentMode)}>
                    {MODES.map((item) => (
                      <option value={item} key={item}>
                        {AGENT_MODE_LABEL[item]}
                      </option>
                    ))}
                  </select>
                </label>

                {/*
                  模型清单的条目来源不止一种（内核真帧 / 自定义端点 / mock），
                  标记跟着条目走而不是跟着页面走：同一次里用户可能正在看一份
                  「内核公布的官方模型 + 自己配的端点模型」混在一起的清单。
                */}
                <label className="control">
                  <span>模型</span>
                  <select value={model} onChange={(event) => setModel(event.target.value)}>
                    {/* 清单为空时也要能显示当前会话正在用的模型：否则用户面对一个空下拉，
                        看到的结论是「没有模型可用」，而实际上会话正跑在某个模型上 */}
                    {(agent.catalog?.models.length ?? 0) === 0 ? (
                      <option value={model}>{model || '默认'}</option>
                    ) : null}
                    {(agent.catalog?.models ?? []).map((item) => (
                      <option value={item.id} key={`${item.source}:${item.id}`} title={modelSourceHint(item)}>
                        {item.label}
                        {item.source === 'endpoint' ? '（自定义端点）' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                {/*
                  上下文占用：内核上报的「现在装了多少 / 最多能装多少」。
                  真实内核在每条助手消息后各报一次，取最近一次（写在会话 meta 上，
                  所以切走再切回来、重启应用之后仍然在）。

                  数据不在时**不显示 0% —— 什么都不显示**：0% 与「内核没说过」
                  在界面上必须是两件事，前者会让人以为上下文是空的。
                */}
                {agent.current?.context ? (
                  <button
                    type="button"
                    className="context-meter"
                    title={
                      `内核上报的上下文占用：${agent.current.context.used.toLocaleString()} / ` +
                      `${agent.current.context.size.toLocaleString()} token\n` +
                      `容量来自模型条目（自定义端点模型取你在设置里填的值）`
                    }
                    onClick={() => openView('usage')}
                  >
                    上下文 {formatTokens(agent.current.context.used)} /{' '}
                    {formatTokens(agent.current.context.size)}
                    {/*
                      分隔符写在文本里而不是只靠 flex 的 gap：截图脚本回读的是
                      textContent，只靠 gap 的话回执会变成「32.8k4%」那种连在一起的
                      字样 —— 回执本身是给人看的证据，不该需要脑补分隔。
                    */}
                    <span className="context-meter-pct">
                      {' · '}
                      {Math.round((agent.current.context.used / agent.current.context.size) * 100)}%
                    </span>
                  </button>
                ) : null}

                {/*
                  用量摘要做成入口：数字本身就是「点进去看详情」的最佳提示。

                  但「没上报」与「真的是 0」必须分开显示 —— 真实内核不上报 token 与费用，
                  照直渲染 0.0k / 0.0k · ¥0.0000 会让用户在花钱的同时看到一个
                  「一切正常、没有消耗」的界面。所以：
                    跑过但一轮都没上报 → 说「未上报」；一轮都没跑 → 说「尚无用量」。
                */}
                <button
                  type="button"
                  className="usage usage-btn"
                  title={
                    agent.usageCoverage.runs > 0 && agent.usageCoverage.runsWithUsage < agent.usageCoverage.runs
                      ? `本会话 ${agent.usageCoverage.runs} 轮中 ${agent.usageCoverage.runs - agent.usageCoverage.runsWithUsage} 轮没有用量数据：真实内核的 ACP 通道不上报 token 与费用，只上报上下文占用。点击查看跨会话用量详情`
                      : '本会话累计用量；点击查看跨会话用量详情'
                  }
                  onClick={() => openView('usage')}
                >
                  {agent.usageCoverage.runs === 0
                    ? '尚无用量'
                    : agent.usageCoverage.runsWithUsage < agent.usageCoverage.runs
                      ? `用量未上报（${agent.usageCoverage.runs} 轮）`
                      : `${(agent.usage.promptTokens / 1000).toFixed(1)}k / ${(agent.usage.completionTokens / 1000).toFixed(1)}k · ¥${agent.usage.costCny.toFixed(4)}`}
                </button>
              </div>
            </header>

            <ChatStream items={agent.timeline} onFork={(atSeq) => void agent.forkSession(atSeq)} />

            <AttachmentBar
              attachments={agent.attachments}
              onAdd={() => void agent.addAttachments()}
              onRemove={agent.removeAttachment}
              onPreview={setPreviewAttachment}
              disabled={disabled}
            />

            <Composer
              disabled={disabled}
              running={running}
              skills={agent.skills}
              onSend={(text) => void agent.send(text, { mode, model })}
              onAbort={() => void agent.abort()}
            />
          </>
        ) : null}

        {view === 'files' ? (
          <PanelPage
            title="工作区文件"
            subtitle={agent.current?.workspace ?? '未选择会话'}
            flush
            onBack={backToChat}
          >
            <FileTreePanel
              tree={agent.tree}
              loading={agent.treeLoading}
              changedPaths={agent.changedPaths}
              onRefresh={() => void agent.refreshTree()}
              onOpen={(path) => void agent.openPreview(path)}
            />
          </PanelPage>
        ) : null}

        {view === 'terminal' ? (
          <PanelPage title="终端" subtitle="命令台模式 · 按会话隔离工作目录" flush onBack={backToChat}>
            <TerminalPanel
              terminal={agent.terminal}
              onRun={(command) => void agent.runTerminal(command)}
              onWrite={(data) => void agent.terminalWrite(data)}
              onInterrupt={() => void agent.interruptTerminal()}
              onClear={agent.clearTerminal}
            />
          </PanelPage>
        ) : null}

        {view === 'browser' ? (
          <BrowserPanel
            state={agent.browser}
            notice={agent.browserNotice}
            onRefresh={agent.refreshBrowser}
            onOpen={agent.openBrowser}
            onShutdown={agent.closeBrowser}
            onDismissNotice={agent.dismissBrowserNotice}
            onClose={backToChat}
          />
        ) : null}

        {view === 'trajectory' ? (
          <PanelPage title="Trajectory" subtitle="事件流时间线 · 逐条可核验" flush onBack={backToChat}>
            <TrajectoryPanel
              events={agent.events}
              sessionId={agent.current?.id}
              parentSessionId={agent.current?.fork?.sessionId}
              onCompare={agent.compareBranches}
              onFork={(atSeq) => void agent.forkSession(atSeq)}
              onClose={backToChat}
            />
          </PanelPage>
        ) : null}

        {view === 'skills' ? (
          <SkillsPanel
            skills={agent.skills}
            onRefresh={agent.refreshSkills}
            onAudit={agent.auditSkillSource}
            onInstall={agent.installSkill}
            onToggle={agent.toggleSkill}
            onUninstall={agent.uninstallSkill}
            onClose={backToChat}
          />
        ) : null}

        {view === 'memory' ? (
          <MemoryPanel
            workspace={agent.current?.workspace ?? null}
            memories={agent.memories}
            stats={agent.memoryStats}
            onRefresh={agent.refreshMemories}
            onAdd={agent.addMemory}
            onRemove={agent.removeMemory}
            onSetProfile={agent.setMemoryProfile}
            onClose={backToChat}
          />
        ) : null}

        {view === 'schedules' ? (
          <SchedulesPanel
            workspace={agent.current?.workspace ?? null}
            schedules={agent.schedules}
            onRefresh={agent.refreshSchedules}
            onAdd={agent.addSchedule}
            onRemove={agent.removeSchedule}
            onToggle={agent.toggleSchedule}
            onRunNow={agent.runScheduleNow}
            onClose={backToChat}
          />
        ) : null}

        {view === 'connectors' ? (
          <ConnectorsPanel
            adapter={agent.status?.adapter ?? null}
            connectors={agent.connectors}
            onRefresh={agent.refreshConnectors}
            onAdd={agent.addConnector}
            onRemove={agent.removeConnector}
            onToggle={agent.toggleConnector}
            onRestartKernel={agent.restartKernel}
            onClose={backToChat}
          />
        ) : null}

        {view === 'usage' ? (
          <UsagePanel
            summary={agent.usageSummary}
            loading={agent.usageLoading}
            prices={agent.config?.modelPrices ?? {}}
            onRefresh={agent.refreshUsage}
            onSavePrices={agent.saveModelPrices}
            onOpenSession={async (sessionId) => {
              await agent.selectSession(sessionId);
              backToChat();
            }}
            onClose={backToChat}
          />
        ) : null}

        {view === 'settings' && agent.config && agent.guard ? (
          <SettingsPanel
            config={agent.config}
            guard={agent.guard}
            catalog={agent.catalog}
            status={agent.status}
            modelKeyStatus={agent.modelKeyStatus}
            onUpdateConfig={(patch) => void agent.updateConfig(patch)}
            onUpdateGuard={(patch) => void agent.updateGuard(patch)}
            onSetApiKey={agent.setModelApiKey}
            onClearApiKey={agent.clearModelApiKey}
            onRefreshKeyStatus={agent.refreshModelKeyStatus}
            onRefreshModels={agent.refreshModels}
            onTestEndpoint={agent.testEndpoint}
            onRestartKernel={agent.restartKernel}
            onClose={backToChat}
          />
        ) : null}
      </main>

      {agent.preview ? (
        <FilePreviewModal
          key={agent.preview.path}
          path={agent.preview.path}
          size={agent.preview.size}
          text={agent.preview.text}
          missing={agent.preview.missing}
          binary={agent.preview.binary}
          truncated={agent.preview.truncated}
          loading={agent.previewLoading}
          onClose={agent.closePreview}
        />
      ) : null}

      {previewAttachment ? (
        <FilePreviewModal
          key={previewAttachment.path}
          path={previewAttachment.path}
          size={previewAttachment.size}
          text={previewAttachment.text}
          missing={Boolean(previewAttachment.error)}
          binary={previewAttachment.binary}
          truncated={previewAttachment.truncated}
          note={previewAttachment.error}
          onClose={() => setPreviewAttachment(null)}
        />
      ) : null}

      {agent.approvals.length > 0 ? (
        <ApprovalDialog
          request={agent.approvals[0]}
          onDecide={(decision, persist, hunks) =>
            void agent.respondApproval(agent.approvals[0].id, decision, persist, hunks)
          }
        />
      ) : null}
    </div>
  );
}

interface FilePreviewModalProps {
  path: string;
  size: number;
  text: string;
  missing: boolean;
  binary: boolean;
  truncated: boolean;
  loading?: boolean;
  /** 额外的说明（例如附件的读取失败原因） */
  note?: string;
  onClose: () => void;
}

/**
 * 只读预览。
 *
 * 有意不做编辑、不做语法高亮、不做富文本 —— 它要回答的问题只有一个：
 * 「Agent 刚改的那个文件，现在到底长什么样」。任何额外能力都会让这个视图
 * 从「事实的窗口」变成「又一个可能出错的编辑器」。
 *
 * 唯一的例外是**图表产物**（FR-3.8）：HTML 源码回答不了「图长什么样」，
 * 所以带图表标记的文件默认渲染。渲染走 `sandbox=""` 的 iframe ——
 * 空 sandbox 等于「不给脚本、不给表单、不给顶层跳转、不给同源」，
 * 而产物本身也正是无脚本的（CSP `default-src 'none'`），
 * 于是「预览里看到的」与「浏览器里打开看到的」是同一张图。
 *
 * 为什么只对**带标记**的文件渲染，而不是给任意 .html 一个渲染视图：
 * 渲染这个动作的语义是「我刚才生成的东西长什么样」，它的可信度来自
 * 「这份 HTML 是我们自己按行拼出来的」。把任意工作区页面也拉进来渲染，
 * 收益（用户想看可以用系统浏览器）远小于「往应用进程里引入未知页面的加载行为」
 * 这一点风险。这不是安全边界，是范围划分。
 */
function FilePreviewModal({
  path,
  size,
  text,
  missing,
  binary,
  truncated,
  loading,
  note,
  onClose,
}: FilePreviewModalProps) {
  const problem = note
    ? `无法读取：${note}`
    : missing
      ? '文件不存在（可能已被删除或从未创建）'
      : binary
        ? '二进制文件，不展示内容'
        : truncated
          ? `文件体积 ${formatBytes(size)}，超出预览上限`
          : null;

  const renderable = !loading && !problem && text.includes(CHART_HTML_MARKER);
  /** 默认渲染；渲染不可用时无所谓取值 */
  const [source, setSource] = useState(false);
  const showRendered = renderable && !source;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-tool">只读预览</span>
          <code className="preview-path" title={path}>
            {path}
          </code>
          <span className="panel-spacer" />
          {renderable ? (
            <button
              type="button"
              className={`chip-toggle${showRendered ? ' chip-toggle-on' : ''}`}
              onClick={() => setSource((value) => !value)}
              title="图表产物默认渲染；源码视图可以看到它到底写了什么"
            >
              {showRendered ? '渲染' : '源码'}
            </button>
          ) : null}
          <span className="preview-size">{formatBytes(size)}</span>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {loading ? <div className="empty-hint">读取中…</div> : null}
          {problem ? <div className="modal-hint modal-hint-warn">{problem}</div> : null}
          {showRendered ? (
            <iframe className="chart-frame" sandbox="" srcDoc={text} title={path} />
          ) : null}
          {!loading && !problem && !showRendered ? <pre className="preview-text">{text || '(空文件)'}</pre> : null}
        </div>
      </div>
    </div>
  );
}
