import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentEvent,
  AgentMode,
  AppConfig,
  ApprovalDecision,
  ApprovalRequest,
  AttachmentPreview,
  ConnectorConfig,
  BrowserState,
  ConnectorState,
  EndpointTestResult,
  FilePreview,
  GuardPolicy,
  HostState,
  HostStatus,
  MemoryEntry,
  MemoryLayer,
  MemoryLayerStat,
  ModelCatalog,
  ModelPrice,
  ScheduleSpec,
  ScheduleTask,
  Session,
  SkillAuditReport,
  SkillInstallResult,
  SkillRecord,
  TerminalChunk,
  TerminalState,
  UsageSummary,
  WorkspaceTree,
} from '@deepwork/protocol';
import {
  bridge,
  describeError,
  hasBridge,
  invoke,
  pickAttachments,
  pickWorkspace,
  previewAttachment,
} from './api';
import { applyEvent, buildTimeline, EMPTY_TIMELINE, sumUsage, type TimelineItem } from './timeline';

/**
 * 渲染层的唯一状态容器。
 *
 * 数据来源只有两个：RPC 调用（拉取）与推送（事件流 / 终端流）。
 * 组件不直接调用 bridge，一律通过本 hook，便于后续换成别的状态方案。
 *
 * 由此带来一条纪律：**任何状态在「拉取」与「推送」两条路上都必须收敛到同一个形状**。
 * 例如终端条目的命令来自 terminal.open 的状态快照，而输出文本来自推送的块 ——
 * 两者用 entryId 对齐，谁也不去解析对方的字符串。
 */

export interface TerminalView {
  state: TerminalState | null;
  /** entryId → 累计输出文本 */
  text: Record<string, string>;
}

export interface UseAgentResult {
  ready: boolean;
  error: string | null;
  hostState: { state: HostState; detail?: string };
  status: HostStatus | null;
  config: AppConfig | null;
  guard: GuardPolicy | null;
  sessions: Session[];
  current: Session | null;
  timeline: TimelineItem[];
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  /**
   * 模型目录（含「这份清单从哪来」）。
   *
   * 权威来源是内核 session/new 真帧，渲染层不缓存第二份，也不自己拼一份 ——
   * 它与「设置页显示的模型」必须是同一份数据，否则用户会看到两个答案。
   * null = 还没拉过。
   */
  catalog: ModelCatalog | null;
  /** 强制重新向内核核对模型目录（会新建一个探针会话，用完即关） */
  refreshModels: () => Promise<void>;
  /** 端点连通性测试（设置页「测试连接」）：对未保存的输入值发一次真实请求 */
  testEndpoint: (params: { baseUrl: string; apiKey?: string }) => Promise<EndpointTestResult>;
  activeRunId: string | null;
  usage: { promptTokens: number; completionTokens: number; costCny: number };
  /**
   * 本会话的用量覆盖率：跑了几轮 / 其中几轮有内核上报。
   * 两者不等时，界面要说「未上报」，不能把 0 当结果。
   */
  usageCoverage: { runs: number; runsWithUsage: number };

  /** 当前会话中被改动过的文件路径（相对工作区），用于文件树高亮 */
  changedPaths: Set<string>;
  tree: WorkspaceTree | null;
  treeLoading: boolean;
  preview: FilePreview | null;
  previewLoading: boolean;
  terminal: TerminalView;
  attachments: AttachmentPreview[];
  skills: SkillRecord[];
  /** 记忆条目（含画像伪条目 id='profile'）；内核侧是唯一事实来源 */
  memories: MemoryEntry[];
  /** 三层的用量与预算画像（entries/chars/budget/truncated） */
  memoryStats: MemoryLayerStat[];
  /** 定时任务列表；内核侧是唯一事实来源 */
  schedules: ScheduleTask[];
  /** 定时任务触发且不在当前会话时的横幅提示（提供跳转） */
  scheduleNotice: { taskId: string; title: string; sessionId: string } | null;
  /** 连接器清单（MCP）；内核侧是唯一事实来源 */
  connectors: ConnectorState[];
  /** 受管浏览器状态（null = 还没拉过）；宿主侧是唯一事实来源 */
  browser: BrowserState | null;
  /** 浏览器操作的一次性提示（例如关闭时说明了「只断开连接」的原因） */
  browserNotice: string | null;
  /** 跨会话用量聚合（null = 还没拉过）；内核侧每次现算，渲染层不缓存第二份 */
  usageSummary: UsageSummary | null;
  usageLoading: boolean;

  selectSession: (id: string) => Promise<void>;
  createSession: (title?: string) => Promise<void>;
  /** 在指定目录新建会话 */
  createSessionIn: (workspace: string) => Promise<void>;
  /** 弹出目录选择框，选中后在该目录新建会话 */
  openWorkspace: () => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /**
   * 从当前会话的某一轮结束处分叉出新会话，并切过去。
   * atSeq 省略表示从末尾分叉；内核会把落在半轮里的位置吸附回运行边界。
   */
  forkSession: (atSeq?: number) => Promise<void>;
  send: (text: string, options?: { mode?: AgentMode; model?: string }) => Promise<void>;
  abort: () => Promise<void>;
  respondApproval: (
    requestId: string,
    decision: ApprovalDecision,
    persist: boolean,
    hunks?: number[],
  ) => Promise<void>;

  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
  updateGuard: (patch: Partial<GuardPolicy>) => Promise<void>;
  refreshTree: () => Promise<void>;
  openPreview: (path: string) => Promise<void>;
  closePreview: () => void;
  runTerminal: (command: string) => Promise<void>;
  terminalWrite: (data: string) => Promise<void>;
  interruptTerminal: () => Promise<void>;
  clearTerminal: () => void;
  addAttachments: () => Promise<void>;
  removeAttachment: (path: string) => void;

  refreshSkills: () => Promise<void>;
  /** 干跑审计（安装向导第一步）；失败会抛出，由面板展示 */
  auditSkillSource: (source: string) => Promise<SkillAuditReport>;
  /** 真正安装（含审计闸门）；失败会抛出，由面板展示 */
  installSkill: (source: string) => Promise<SkillInstallResult>;
  toggleSkill: (name: string, enabled: boolean) => Promise<void>;
  uninstallSkill: (name: string) => Promise<void>;

  refreshMemories: () => Promise<void>;
  /** 显式写入一条记忆；预算超限等失败会抛出，由面板原样展示 */
  addMemory: (layer: MemoryLayer, text: string, workspace?: string) => Promise<void>;
  removeMemory: (id: string) => Promise<void>;
  setMemoryProfile: (text: string) => Promise<void>;

  refreshSchedules: () => Promise<void>;
  /** 新建定时任务；校验失败会抛出，由面板原样展示 */
  addSchedule: (input: { title: string; prompt: string; workspace: string; spec: ScheduleSpec }) => Promise<void>;
  removeSchedule: (id: string) => Promise<void>;
  toggleSchedule: (id: string, enabled: boolean) => Promise<void>;
  /** 手动立即触发一次（与定时触发同一条路径） */
  runScheduleNow: (id: string) => Promise<void>;
  /** 关掉调度横幅；传 true 时同时跳到触发会话 */
  dismissScheduleNotice: (jump: boolean) => Promise<void>;

  refreshConnectors: () => Promise<void>;
  /** 添加连接器；校验失败会抛出，由面板原样展示 */
  addConnector: (config: ConnectorConfig) => Promise<void>;
  removeConnector: (name: string) => Promise<void>;
  toggleConnector: (name: string, enabled: boolean) => Promise<void>;
  /** 重启内核使连接器清单生效；失败如实抛出，由面板原样展示 */
  restartKernel: () => Promise<void>;

  refreshBrowser: () => Promise<void>;
  /**
   * 用户亲手打开网页（面板地址栏）。
   *
   * 不走审批 —— 地址栏里那串 URL 是用户自己敲的。模型侧的六个 browser_* 动作
   * 走内核 MCP 服务并强制过审批，两条入口的授权语义不同，不能合并。
   */
  openBrowser: (url: string) => Promise<void>;
  /** 关闭受管浏览器；返回文案如实说明是「已关闭」还是「只断开连接」 */
  closeBrowser: () => Promise<void>;
  dismissBrowserNotice: () => void;

  refreshUsage: () => Promise<void>;
  /** 保存模型单价表；校验失败会抛出，由面板原样展示 */
  saveModelPrices: (prices: Record<string, ModelPrice>) => Promise<void>;

  /** 模型 API key 状态（掩码；null = 尚未拉取） */
  modelKeyStatus: { set: boolean; masked?: string } | null;
  refreshModelKeyStatus: () => Promise<void>;
  /** 设置当前模式的 key；失败如实抛出，由面板展示 */
  setModelApiKey: (key: string) => Promise<void>;
  clearModelApiKey: () => Promise<void>;

  dismissError: () => void;
}

export function useAgent(): UseAgentResult {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostState, setHostState] = useState<{ state: HostState; detail?: string }>({ state: 'starting' });
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [guard, setGuard] = useState<GuardPolicy | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>(EMPTY_TIMELINE);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [terminalState, setTerminalState] = useState<TerminalState | null>(null);
  const [terminalText, setTerminalText] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [modelKeyStatus, setModelKeyStatus] = useState<{ set: boolean; masked?: string } | null>(null);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memoryStats, setMemoryStats] = useState<MemoryLayerStat[]>([]);
  const [schedules, setSchedules] = useState<ScheduleTask[]>([]);
  const [scheduleNotice, setScheduleNotice] = useState<{ taskId: string; title: string; sessionId: string } | null>(
    null,
  );
  const [connectors, setConnectors] = useState<ConnectorState[]>([]);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [browserNotice, setBrowserNotice] = useState<string | null>(null);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  // 事件回调只注册一次，用 ref 读取最新的会话 id，避免闭包读到旧值
  const currentIdRef = useRef<string | null>(null);
  const runSessionRef = useRef(new Map<string, string>());
  /** 供事件订阅回调使用（refreshSchedules 定义在下方，用 ref 打破顺序依赖） */
  const refreshSchedulesRef = useRef<() => Promise<void>>(async () => undefined);
  /** 同上：一轮结束后用量变了，用量面板若开着需要看到新值 */
  const refreshUsageRef = useRef<() => Promise<void>>(async () => undefined);
  /** 单条条目的文本上限，与内核侧的限流配合，防止渲染层被刷爆 */
  const textLimitRef = useRef(200_000);

  const setCurrent = useCallback((id: string | null) => {
    currentIdRef.current = id;
    setCurrentId(id);
  }, []);

  const refreshTerminalState = useCallback(async (sessionId: string) => {
    try {
      const state = await invoke('terminal.open', { sessionId });
      setTerminalState(state);
    } catch {
      // 终端未打开时不必报错：这只说明用户还没用过终端
    }
  }, []);

  const refreshTree = useCallback(async () => {
    const sessionId = currentIdRef.current;
    if (!sessionId) return;
    setTreeLoading(true);
    try {
      const result = await invoke('fs.tree', { sessionId });
      setTree(result);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const loadSession = useCallback(
    async (id: string) => {
      const history = await invoke('session.events', { sessionId: id });
      setEvents(history);
      setTimeline(buildTimeline(history));
      setCurrent(id);
      // 切会话即切边界：树、预览、终端都跟着换，避免看到上一个会话的残留
      setTerminalState(null);
      setTerminalText({});
      setPreview(null);
      setTree(null);
      void refreshTree();
    },
    [refreshTree, setCurrent],
  );

  const refreshSessions = useCallback(async () => {
    const list = await invoke('session.list');
    setSessions(list);
    return list;
  }, []);

  /** 首次装载：拿状态、配置、会话列表，列表为空则自动建一个会话 */
  useEffect(() => {
    if (!hasBridge()) {
      setError('未检测到 Electron 桥接层：请在桌面应用内运行（npm run dev 或 npm start）');
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const [hostStatus, modelCatalog, list, appConfig, guardPolicy] = await Promise.all([
          invoke('host.status'),
          invoke('models.list'),
          invoke('session.list'),
          invoke('config.get'),
          invoke('guard.get'),
        ]);
        if (cancelled) return;

        setStatus(hostStatus);
        setCatalog(modelCatalog);
        setSessions(list);
        setConfig(appConfig);
        setGuard(guardPolicy);
        textLimitRef.current = appConfig.terminalBufferLimit;

        if (list.length > 0) {
          await loadSession(list[0].id);
        } else {
          const created = await invoke('session.create', { workspace: hostStatus.workspace });
          setSessions([created]);
          await loadSession(created.id);
        }
        setReady(true);
      } catch (cause) {
        if (!cancelled) setError(describeError(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadSession]);

  /** 事件流订阅 */
  useEffect(() => {
    if (!hasBridge()) return;
    const api = bridge();

    const offState = api.onHostState((payload) => setHostState(payload));

    /**
     * 终端推送。
     *
     * 只做两件事：追加文本、在收到结束块时刷新状态快照。
     * 刻意不在渲染层判断「这条命令是哪条」—— 条目元数据（命令、cwd、退出码）统一来自
     * terminal.open 的快照，用 entryId 对齐。字符串解析在这里是可避免的错误来源。
     */
    const offTerminal = api.onTerminal((chunk: TerminalChunk) => {
      if (chunk.text) {
        setTerminalText((prev) => {
          const next = { ...prev };
          const merged = (next[chunk.entryId] ?? '') + chunk.text;
          next[chunk.entryId] =
            merged.length > textLimitRef.current
              ? `${merged.slice(0, textLimitRef.current)}\n[界面缓冲已满，更早的输出已丢弃]\n`
              : merged;
          return next;
        });
      }
      if (chunk.exit && chunk.sessionId === currentIdRef.current) {
        void refreshTerminalState(chunk.sessionId);
      }
    });

    const offEvent = api.onEvent((event) => {
      if (event.type === 'run.started') {
        runSessionRef.current.set(event.runId, event.sessionId);
        if (event.sessionId === currentIdRef.current) setActiveRunId(event.runId);
      }

      const sessionId =
        event.type === 'schedule.fired'
          ? // schedule.fired 先于 run.started 到达，runId 映射此刻还不存在；
            // 但它自带 sessionId —— 用它归属，否则会漏进当前会话的视图
            event.sessionId
          : 'runId' in event
            ? runSessionRef.current.get(event.runId)
            : undefined;
      /**
       * 「这条事件属不属于当前会话」有两类判据：
       *  - 带 session 的（created / updated / forked）按 session.id 比；
       *  - 带 runId 的按 run → session 的映射比；
       *  - 两者都没有的（如 host.ready）不与任何会话绑定，视为全局事件。
       *
       * 分叉标记必须走第一类：它不带 runId，若按「无 runId 即全局」处理，
       * 别的会话分叉时就会在当前视图里凭空多出一条记录。
       */
      const belongsToCurrent =
        event.type === 'session.created' ||
        event.type === 'session.updated' ||
        event.type === 'session.forked'
          ? event.session.id === currentIdRef.current
          : sessionId === undefined || sessionId === currentIdRef.current;

      if (belongsToCurrent) {
        setEvents((prev) => [...prev, event]);
        setTimeline((prev) => applyEvent(prev, event));
      }

      switch (event.type) {
        case 'session.created':
        case 'session.forked':
          setSessions((prev) => (prev.some((s) => s.id === event.session.id) ? prev : [event.session, ...prev]));
          break;
        case 'session.updated':
          setSessions((prev) => prev.map((s) => (s.id === event.session.id ? event.session : s)));
          break;
        case 'schedule.fired': {
          // 预登记 run → session 映射：后续 user.message / run.started 到达时
          // 归属立即可用，不必等 run.started 那一拍
          runSessionRef.current.set(event.runId, event.sessionId);
          // 任务被触发后 runCount/nextRunAt 已变，面板若开着需要看到新值
          void refreshSchedulesRef.current();
          if (event.sessionId !== currentIdRef.current) {
            setScheduleNotice({ taskId: event.task.id, title: event.task.title, sessionId: event.sessionId });
          }
          break;
        }
        case 'approval.requested':
          if (belongsToCurrent) setApprovals((prev) => [...prev, event.request]);
          break;
        case 'approval.resolved':
          setApprovals((prev) => prev.filter((item) => item.id !== event.requestId));
          break;
        case 'tool.completed':
          // 工具跑完文件可能变了，刷新一次树：这是「改动在磁盘上真的发生了」的确认时机
          if (belongsToCurrent) void refreshTree();
          break;
        case 'run.completed':
        case 'run.failed':
          setActiveRunId((prev) => (prev === event.runId ? null : prev));
          runSessionRef.current.delete(event.runId);
          if (belongsToCurrent) void refreshTree();
          // run 结局会在宿主侧写回定时任务（lastStatus），稍后重拉一次让面板看到；
          // 延迟是因为写回发生在事件发出之后的 promise 回调里，立即拉可能拿到旧值
          setTimeout(() => void refreshSchedulesRef.current(), 500);
          // 同一拍里把用量也重拉一次：usage 事件已经落盘，面板上的数字不该等用户手动刷新
          void refreshUsageRef.current();
          break;
        default:
          break;
      }
    });

    return () => {
      offState();
      offEvent();
      offTerminal();
    };
  }, [refreshTerminalState, refreshTree]);

  const selectSession = useCallback(
    async (id: string) => {
      try {
        await loadSession(id);
        setApprovals([]);
        setActiveRunId(null);
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [loadSession],
  );

  const createSessionIn = useCallback(
    async (workspace: string) => {
      try {
        const created = await invoke('session.create', { workspace });
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        await loadSession(created.id);
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [loadSession],
  );

  /** 默认在宿主启动时的默认工作区里新建会话 */
  const createSession = useCallback(
    async (title?: string) => {
      const workspace = config?.lastWorkspace || status?.workspace;
      if (!workspace) return;
      try {
        const created = await invoke('session.create', { workspace, title });
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        await loadSession(created.id);
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [config, loadSession, status],
  );

  /**
   * 选择任意目录作为工作区。
   *
   * 关键点：会话一经创建就绑定工作区，之后所有文件操作都受该边界约束。
   * 因此这里不是「切个路径看看」，而是要明确地开一个新会话 ——
   * 不允许在既有会话上改工作区，否则同一份日志里的操作会跨越不同的边界，
   * 回放和审计都会失去意义。
   */
  const openWorkspace = useCallback(async () => {
    try {
      const workspace = await pickWorkspace();
      if (!workspace) return;
      await createSessionIn(workspace);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [createSessionIn]);

  const removeSession = useCallback(
    async (id: string) => {
      try {
        await invoke('session.delete', { sessionId: id });
        const list = await refreshSessions();
        if (currentIdRef.current === id) {
          if (list.length > 0) await loadSession(list[0].id);
          else {
            setCurrent(null);
            setTimeline(EMPTY_TIMELINE);
            setEvents([]);
            setTree(null);
          }
        }
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [loadSession, refreshSessions, setCurrent],
  );

  const renameSession = useCallback(async (id: string, title: string) => {
    try {
      const updated = await invoke('session.rename', { sessionId: id, title });
      setSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  /**
   * 分叉：把「某一轮之后」变成一条能独立走下去的新分支。
   *
   * 界面只负责给出「在哪一轮之后」（atSeq），合法性判断全在内核 ——
   * UI 不重复业务规则，也就不会出现「界面允许但内核拒绝」的两套说法。
   */
  const forkSession = useCallback(
    async (atSeq?: number) => {
      const sessionId = currentIdRef.current;
      if (!sessionId) return;
      try {
        const forked = await invoke('session.fork', { sessionId, atSeq });
        setSessions((prev) => [forked.session, ...prev.filter((s) => s.id !== forked.session.id)]);
        await loadSession(forked.session.id);
        setApprovals([]);
        setActiveRunId(null);
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [loadSession],
  );

  const send = useCallback(
    async (text: string, options?: { mode?: AgentMode; model?: string }) => {
      const sessionId = currentIdRef.current;
      if (!sessionId || !text.trim()) return;
      try {
        setActiveRunId('pending');
        const { runId } = await invoke('run.send', {
          sessionId,
          text,
          mode: options?.mode,
          model: options?.model,
          attachments: attachments.map((item) => item.path),
        });
        runSessionRef.current.set(runId, sessionId);
        setActiveRunId(runId);
        // 发送即清空暂存：附件已经作为这一轮的一部分进了事件流，留在输入区只会让人以为它会重复生效
        setAttachments([]);
      } catch (cause) {
        setActiveRunId(null);
        setError(describeError(cause));
      }
    },
    [attachments],
  );

  const abort = useCallback(async () => {
    const runId = activeRunId;
    if (!runId || runId === 'pending') return;
    try {
      await invoke('run.abort', { runId });
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [activeRunId]);

  const respondApproval = useCallback(
    async (requestId: string, decision: ApprovalDecision, persist: boolean, hunks?: number[]) => {
      try {
        await invoke('approval.respond', { requestId, decision, persist, hunks });
        setApprovals((prev) => prev.filter((item) => item.id !== requestId));
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [],
  );

  const updateConfig = useCallback(async (patch: Partial<AppConfig>) => {
    try {
      const next = await invoke('config.set', { patch });
      setConfig(next);
      if (patch.terminalBufferLimit) textLimitRef.current = patch.terminalBufferLimit;
      // 端点变更立即刷新目录（endpoint 源目录无需重启即可反映）；
      // 内核侧生效仍要重启 —— 两件事，别让用户以为刷新了就等于生效了。
      if (patch.modelEndpoint) {
        try {
          setCatalog(await invoke('models.list'));
        } catch {
          // 目录刷新失败不阻断配置保存
        }
      }
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  const updateGuard = useCallback(async (patch: Partial<GuardPolicy>) => {
    try {
      const next = await invoke('guard.set', { policy: patch });
      setGuard(next);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  const openPreview = useCallback(async (path: string) => {
    const sessionId = currentIdRef.current;
    if (!sessionId) return;
    setPreview({ path, missing: false, binary: false, size: 0, text: '', truncated: false });
    setPreviewLoading(true);
    try {
      const result = await invoke('fs.preview', { sessionId, path });
      setPreview(result);
    } catch (cause) {
      setError(describeError(cause));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const closePreview = useCallback(() => setPreview(null), []);

  /** 打开终端面板时确保内核侧已有终端，并取回快照 */
  const ensureTerminal = useCallback(async () => {
    const sessionId = currentIdRef.current;
    if (!sessionId) return;
    await refreshTerminalState(sessionId);
  }, [refreshTerminalState]);

  const runTerminal = useCallback(
    async (command: string) => {
      const sessionId = currentIdRef.current;
      if (!sessionId || !command.trim()) return;
      try {
        await ensureTerminal();
        const { entryId } = await invoke('terminal.run', { sessionId, command });
        // 立刻把「正在跑」这一条放进界面：否则命令启动到第一次输出之间会有可见的空档
        setTerminalText((prev) => (prev[entryId] === undefined ? { ...prev, [entryId]: '' } : prev));
        await refreshTerminalState(sessionId);
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [ensureTerminal, refreshTerminalState],
  );

  const terminalWrite = useCallback(
    async (data: string) => {
      const sessionId = currentIdRef.current;
      if (!sessionId) return;
      try {
        await invoke('terminal.write', { sessionId, data });
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [],
  );

  const interruptTerminal = useCallback(async () => {
    const sessionId = currentIdRef.current;
    if (!sessionId) return;
    try {
      await invoke('terminal.interrupt', { sessionId });
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  /**
   * 清屏只清界面缓冲，不动内核侧的历史。
   * 这样「清掉噪音」与「丢掉记录」是两件事，用户不必担心清屏会毁掉什么。
   */
  const clearTerminal = useCallback(() => setTerminalText({}), []);

  const addAttachments = useCallback(async () => {
    try {
      const paths = await pickAttachments();
      if (paths.length === 0) return;
      const previews = await Promise.all(
        paths.map(async (target) => {
          try {
            return await previewAttachment(target);
          } catch (cause) {
            return {
              path: target,
              name: target.split(/[\\/]/).pop() ?? target,
              size: 0,
              text: '',
              binary: false,
              truncated: false,
              error: describeError(cause),
            } satisfies AttachmentPreview;
          }
        }),
      );
      setAttachments((prev) => {
        const seen = new Set(prev.map((item) => item.path));
        return [...prev, ...previews.filter((item) => !seen.has(item.path))];
      });
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((item) => item.path !== path));
  }, []);

  // ── 技能系统 ──────────────────────────────────────────────
  // 列表只在内核侧维护（skills.json + 磁盘目录对齐），渲染层不缓存第二份事实，
  // 每次操作后重新拉取，避免「界面上还亮着、磁盘上已没了」的幽灵状态。
  const refreshSkills = useCallback(async () => {
    try {
      setSkills(await invoke('skills.list'));
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  const auditSkillSource = useCallback(
    (source: string) => invoke('skills.audit', { source }),
    [],
  );

  const installSkill = useCallback(
    async (source: string) => {
      const result = await invoke('skills.install', { source });
      if (result.ok) await refreshSkills();
      return result;
    },
    [refreshSkills],
  );

  const toggleSkill = useCallback(
    async (name: string, enabled: boolean) => {
      try {
        await invoke('skills.toggle', { name, enabled });
        await refreshSkills();
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [refreshSkills],
  );

  const uninstallSkill = useCallback(
    async (name: string) => {
      try {
        await invoke('skills.uninstall', { name });
        await refreshSkills();
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [refreshSkills],
  );

  // ── 三层记忆 ──────────────────────────────────────────────
  // 与技能同一条纪律：内核侧是唯一事实来源，渲染层不缓存第二份，
  // 每次操作后重新拉取。预算超限等失败向面板抛出，原样展示，
  // 不让「没记下」以「看起来记下了」的形态混过去。
  const currentWorkspaceRef = useRef<string | null>(null);

  const refreshMemories = useCallback(async () => {
    const workspace = currentWorkspaceRef.current ?? undefined;
    try {
      const [list, stats] = await Promise.all([
        invoke('memory.list', { workspace }),
        invoke('memory.stats', { workspace }),
      ]);
      setMemories(list);
      setMemoryStats(stats);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  const addMemory = useCallback(
    async (layer: MemoryLayer, text: string, workspace?: string) => {
      await invoke('memory.add', { layer, text, workspace });
      await refreshMemories();
    },
    [refreshMemories],
  );

  const removeMemory = useCallback(
    async (id: string) => {
      await invoke('memory.remove', { id });
      await refreshMemories();
    },
    [refreshMemories],
  );

  const setMemoryProfile = useCallback(
    async (text: string) => {
      await invoke('memory.setProfile', { text });
      await refreshMemories();
    },
    [refreshMemories],
  );

  // ── 自动化调度 ────────────────────────────────────────────
  // 与技能/记忆同一条纪律：内核侧是唯一事实来源，每次操作后重拉。
  // 校验失败（如一次性任务时刻已过）向面板抛出，原样展示。
  const refreshSchedules = useCallback(async () => {
    try {
      setSchedules(await invoke('schedule.list'));
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    refreshSchedulesRef.current = refreshSchedules;
  }, [refreshSchedules]);

  const addSchedule = useCallback(
    async (input: { title: string; prompt: string; workspace: string; spec: ScheduleSpec }) => {
      await invoke('schedule.add', input);
      await refreshSchedules();
    },
    [refreshSchedules],
  );

  const removeSchedule = useCallback(
    async (id: string) => {
      await invoke('schedule.remove', { id });
      await refreshSchedules();
    },
    [refreshSchedules],
  );

  const toggleSchedule = useCallback(
    async (id: string, enabled: boolean) => {
      await invoke('schedule.toggle', { id, enabled });
      await refreshSchedules();
    },
    [refreshSchedules],
  );

  const runScheduleNow = useCallback(async (id: string) => {
    await invoke('schedule.runNow', { id });
    // 触发后 runCount/nextRunAt 由 schedule.fired 事件回调负责刷新，这里不重复拉
  }, []);

  const dismissScheduleNotice = useCallback(
    async (jump: boolean) => {
      const notice = scheduleNotice;
      setScheduleNotice(null);
      if (jump && notice) await selectSession(notice.sessionId);
    },
    [scheduleNotice, selectSession],
  );

  // ── 连接器（MCP）──────────────────────────────────────────
  // 与技能/记忆同一条纪律：内核侧是唯一事实来源，每次操作后重拉。
  // 清单变更在内核（重）启动后生效 —— 重启失败向面板抛出，原样展示。
  const refreshConnectors = useCallback(async () => {
    try {
      setConnectors(await invoke('connectors.list'));
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  const addConnector = useCallback(
    async (config: ConnectorConfig) => {
      await invoke('connectors.add', { config });
      await refreshConnectors();
    },
    [refreshConnectors],
  );

  const removeConnector = useCallback(
    async (name: string) => {
      await invoke('connectors.remove', { name });
      await refreshConnectors();
    },
    [refreshConnectors],
  );

  const toggleConnector = useCallback(
    async (name: string, enabled: boolean) => {
      await invoke('connectors.toggle', { name, enabled });
      await refreshConnectors();
    },
    [refreshConnectors],
  );

  const restartKernel = useCallback(async () => {
    const next = await invoke('kernel.restart');
    // 重启可能改变内核类型（例如配置变化后走了另一条适配路径），状态以返回值为准
    setStatus(next);
    // 目录的权威在内核：重启就是为了让新补丁（端点 / 连接器）生效，
    // 不把目录一起刷新，界面上看到的就是重启前那份旧清单 ——
    // 内网部署时这正是「端点配好了，模型下拉里却没有」的直接原因。
    try {
      setCatalog(await invoke('models.refresh'));
    } catch {
      // 状态已返回，目录沿用旧的；核对失败会在设置页的 note 里如实呈现
    }
  }, []);

  // ── 浏览器（M2-H）────────────────────────────────────────
  // 状态由宿主现算（读 endpoint 文件 + pid 存活），渲染层不推断、不缓存。
  // 「关掉了但进程还在」这类事情只能由宿主说清楚，面板照着显示即可。
  const refreshBrowser = useCallback(async () => {
    try {
      setBrowser(await invoke('browser.state'));
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  const openBrowser = useCallback(async (url: string) => {
    setBrowserNotice(null);
    try {
      setBrowser(await invoke('browser.open', { url }));
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  const closeBrowser = useCallback(async () => {
    try {
      const result = await invoke('browser.close');
      setBrowserNotice(result.message);
      await refreshBrowser();
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [refreshBrowser]);

  const dismissBrowserNotice = useCallback(() => setBrowserNotice(null), []);

  // ── 用量聚合（M2-J）──────────────────────────────────────
  // 与技能/记忆同一条纪律：宿主侧是唯一事实来源，每次现算、不缓存第二份。
  // 单价表属于 config，因此保存单价走 config.set 再重拉 —— 不在渲染层另存一份价格。
  const refreshUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      setUsageSummary(await invoke('usage.summary'));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUsageRef.current = refreshUsage;
  }, [refreshUsage]);

  const saveModelPrices = useCallback(
    async (prices: Record<string, ModelPrice>) => {
      await updateConfig({ modelPrices: prices });
      await refreshUsage();
    },
    [refreshUsage, updateConfig],
  );

  // ── 模型 API key（明文只在输入框里短暂存在，状态里只放掩码）──
  const refreshModelKeyStatus = useCallback(async () => {
    try {
      setModelKeyStatus(await invoke('model.apiKey.status'));
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  const setModelApiKey = useCallback(async (key: string) => {
    setModelKeyStatus(await invoke('model.apiKey.set', { key }));
  }, []);

  const clearModelApiKey = useCallback(async () => {
    setModelKeyStatus(await invoke('model.apiKey.clear'));
  }, []);

  /**
   * 重新向内核核对模型目录。
   *
   * 走的是 models.refresh 而不是 models.list：前者才允许新建探针会话真的去问一次内核。
   * 区别很重要 —— 用户点这个按钮的场景正是「我在端点上换完模型了」，
   * 若复用缓存就会回同一份旧清单，看起来像功能没生效。
   */
  const refreshModels = useCallback(async () => {
    try {
      setCatalog(await invoke('models.refresh'));
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  /** 端点连通性测试：纯透传，结果（含错误文案）由设置页就地展示 */
  const testEndpoint = useCallback(
    (params: { baseUrl: string; apiKey?: string }) => invoke('models.testEndpoint', params),
    [],
  );

  const current = useMemo(
    () => sessions.find((session) => session.id === currentId) ?? null,
    [sessions, currentId],
  );
  // 当前会话的工作区给记忆面板用：工作区层条目按它取
  useEffect(() => {
    currentWorkspaceRef.current = current?.workspace ?? null;
  }, [current]);
  const usage = useMemo(() => sumUsage(events), [events]);

  /**
   * 当前会话的用量覆盖率：跑了几轮、其中几轮有内核上报的用量。
   *
   * 存在的理由：真实内核（ACP 通道）不上报 token 与费用，只上报上下文占用。
   * 少了这个判断，顶栏在真实内核下会显示 `0.0k / 0.0k · ¥0.0000` ——
   * 用户明明在花钱，界面却"看起来一切正常"。所以「没上报」必须与「真的是 0」分开。
   */
  const usageCoverage = useMemo(() => {
    const runs = new Set<string>();
    const withUsage = new Set<string>();
    for (const event of events) {
      if (event.type === 'run.started') runs.add(event.runId);
      else if (event.type === 'usage') withUsage.add(event.runId);
    }
    return { runs: runs.size, runsWithUsage: withUsage.size };
  }, [events]);

  /**
   * 当前会话改动过的文件。
   *
   * 直接从会话事件里的工具调用差异推出来，而不是再去问一次内核 ——
   * 那些差异正是用户当初审批时看到的东西，口径天然一致；
   * 另开一条查询路径只会带来「树上的高亮与审批记录对不上」的困惑。
   */
  const changedPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const item of timeline) {
      if (item.kind === 'tool' && item.call.diff?.path) paths.add(item.call.diff.path);
    }
    return paths;
  }, [timeline]);

  const terminal = useMemo<TerminalView>(
    () => ({ state: terminalState, text: terminalText }),
    [terminalState, terminalText],
  );

  return {
    ready,
    error,
    hostState,
    status,
    config,
    guard,
    sessions,
    current,
    timeline,
    events,
    approvals,
    catalog,
    refreshModels,
    testEndpoint,
    activeRunId,
    usage,
    usageCoverage,    changedPaths,
    tree,
    treeLoading,
    preview,
    previewLoading,
    terminal,
    attachments,
    skills,
    memories,
    memoryStats,
    schedules,
    scheduleNotice,
    connectors,
    browser,
    browserNotice,
    usageSummary,
    usageLoading,
    selectSession,
    createSession,
    createSessionIn,
    openWorkspace,
    removeSession,
    renameSession,
    forkSession,
    send,
    abort,
    respondApproval,
    updateConfig,
    updateGuard,
    refreshTree,
    openPreview,
    closePreview,
    runTerminal,
    terminalWrite,
    interruptTerminal,
    clearTerminal,
    addAttachments,
    removeAttachment,
    refreshSkills,
    auditSkillSource,
    installSkill,
    toggleSkill,
    uninstallSkill,
    refreshMemories,
    addMemory,
    removeMemory,
    setMemoryProfile,
    refreshSchedules,
    addSchedule,
    removeSchedule,
    toggleSchedule,
    runScheduleNow,
    dismissScheduleNotice,
    refreshConnectors,
    addConnector,
    removeConnector,
    toggleConnector,
    restartKernel,
    refreshBrowser,
    openBrowser,
    closeBrowser,
    dismissBrowserNotice,
    refreshUsage,
    saveModelPrices,
    modelKeyStatus,
    refreshModelKeyStatus,
    setModelApiKey,
    clearModelApiKey,
    dismissError: () => setError(null),
  };
}
