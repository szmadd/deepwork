import { useEffect, useRef, useState } from 'react';
import {
  AGENT_MODE_LABEL,
  APP_VIEW_LABEL,
  type AgentMode,
  type AppView,
  type AttachmentPreview,
} from '@deepwork/protocol';
import { formatBytes } from './api';
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
import { UsagePanel } from './components/UsagePanel';
import { BrowserPanel } from './components/BrowserPanel';
import { AttachmentBar } from './components/AttachmentBar';
import { useAgent } from './useAgent';

const MODES: AgentMode[] = ['ptc', 'standard', 'minimal', 'creative'];

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
  // 就绪判定以内核 RPC 是否成功为准，而不是等 UI 收到 ready 事件
  // （窗口可能在 host.ready 发出之后才加载完成，只信事件会永久卡在「启动中」）
  const disabled = !agent.ready;
  const showStarting = !agent.ready || agent.hostState.state === 'restarting';

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

                <label className="control">
                  <span>模型</span>
                  <select value={model} onChange={(event) => setModel(event.target.value)}>
                    {agent.models.length === 0 ? <option value={model}>{model || '默认'}</option> : null}
                    {agent.models.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>

                {/* 用量摘要做成入口：数字本身就是「点进去看详情」的最佳提示 */}
                <button
                  type="button"
                  className="usage usage-btn"
                  title="本会话累计用量；点击查看跨会话用量详情"
                  onClick={() => openView('usage')}
                >
                  {(agent.usage.promptTokens / 1000).toFixed(1)}k /{' '}
                  {(agent.usage.completionTokens / 1000).toFixed(1)}k · ¥{agent.usage.costCny.toFixed(4)}
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
            <TrajectoryPanel events={agent.events} onClose={backToChat} />
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
            models={agent.models}
            status={agent.status}
            modelKeyStatus={agent.modelKeyStatus}
            onUpdateConfig={(patch) => void agent.updateConfig(patch)}
            onUpdateGuard={(patch) => void agent.updateGuard(patch)}
            onSetApiKey={agent.setModelApiKey}
            onClearApiKey={agent.clearModelApiKey}
            onRefreshKeyStatus={agent.refreshModelKeyStatus}
            onRestartKernel={agent.restartKernel}
            onClose={backToChat}
          />
        ) : null}
      </main>

      {agent.preview ? (
        <FilePreviewModal
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

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-tool">只读预览</span>
          <code className="preview-path" title={path}>
            {path}
          </code>
          <span className="panel-spacer" />
          <span className="preview-size">{formatBytes(size)}</span>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {loading ? <div className="empty-hint">读取中…</div> : null}
          {problem ? <div className="modal-hint modal-hint-warn">{problem}</div> : null}
          {!loading && !problem ? <pre className="preview-text">{text || '(空文件)'}</pre> : null}
        </div>
      </div>
    </div>
  );
}
