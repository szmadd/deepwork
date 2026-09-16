import crypto from 'node:crypto';
import type { AgentEventInput, RunStatus, RiskLevel, ToolCall } from '@deepwork/protocol';
import { createLogger } from '../logger';
import { createToolContext } from '../tools/registry';
import { assertNotAborted, type HarnessAdapter, type HealthReport, type RunContext } from './types';

const log = createLogger('adapter:mock');

/**
 * mock 自报的上下文容量。
 *
 * 它必须是一个**此处显式声明**的数，而不是从别处抄一个"看起来对"的值：
 * 真实容量由内核给（ACP usage_update 的 size），mock 没有内核，所以它只能自报。
 * 自报就得写在能被看见的地方，并且和它扮演的角色一起说出来。
 */
const MOCK_CONTEXT_WINDOW = 32_768;

/**
 * 一帧「被内核沙箱拦下」的工具输出 —— **真帧逐字副本，不要手改。**
 *
 * 来源：`node tools/sandbox-e2e.js` 于 2026-09-15 跑出的
 * `tool.completed.output`（场景 B1：workspace-write 下越界写工作区外的文件）。
 * 它与 `packages/protocol/src/security.ts` 里 `parseSandboxDenial` 的参照物、
 * 以及 `tools/sandbox-test.js` 第 7 节的 REAL_DENIALS 指的都是同一份字面量；
 * 三处一起改才算改对，只改一处会让「模拟出来的方言」与「解析的方言」分家。
 * 导出是为了让 sandbox-test.js 第 7 节能**断言**它与解析层参照物逐字相同 ——
 * 靠注释提醒「三处一起改」是提醒不住的，靠断言才拦得住。
 */
export const MOCK_SANDBOX_DENIAL = [
  'Error: [sandbox: file access denied under workspace-write mode]',
  '[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
].join('\n');

/**
 * 一次沙箱升级申请的演示内容（模型申请把本次调用提到最宽档位）。
 *
 * 与 `MOCK_SANDBOX_DENIAL` 配对：那张卡说明「被拦下了，还留了一跳」，
 * 这一帧演示**模型踩上那一跳之后界面长什么样**。入参形状取自 sandbox-e2e 的
 * E1 场景（替身端点照内核提示重试时真正发出去的那份 write 入参）。
 */
export const MOCK_SANDBOX_ESCALATION = {
  path: '../shared/cache.json',
  mode: 'danger-full-access',
  justification: '这份缓存要在工作区外的共享目录里落地，否则下一次运行读不到它。',
} as const;

/**
 * 用户拒绝升级时内核的原话 —— **真帧逐字副本，不要手改。**
 *
 * 来源：`node tools/sandbox-e2e.js` 的 E2 场景（2026-09-16）跑出的
 * `tool.completed.output`。它与 `tools/sandbox-test.js` 第 9 节的
 * REAL_ESCALATION_REJECTED 指同一份字面量，同样靠断言而不是注释来防漂移。
 */
export const MOCK_ESCALATION_REJECTED =
  'Error: the user rejected escalating this operation to "danger-full-access"';

/**
 * Mock 内核。
 *
 * 存在的意义有两个，都很重要：
 *  1. 让「壳 + UI + 协议 + 日志」这条链路在没有真实 Harness 的情况下可完整验证，
 *     不把开发进度绑死在第三方 0.1.x 内核的可用性上；
 *  2. 作为真实的工具执行者——它真的会去读文件、跑命令、走审批，
 *     而不是返回写死的假数据，因此能压出协议层与安全层的真实问题。
 *
 * 真实模型推理由 HarnessSidecarAdapter 承担；本类不假装自己有推理能力，
 * 它的"话术"是脚本化的，调用方必须知道当前用的是 mock（host.status.adapter === 'mock'）。
 */
export class MockHarnessAdapter implements HarnessAdapter {
  readonly kind = 'mock' as const;
  readonly version = 'mock-0.1.0';

  private aborted = new Set<string>();
  private ready = false;
  /** 模拟的上下文占用：只增不减地累积，让「占用随对话增长」这个现象真的出现 */
  private contextUsed = 1_200;

  capabilities(): string[] {
    return ['fs', 'shell', 'search', 'approval', 'streaming', 'usage'];
  }

  async start(): Promise<HealthReport> {
    this.ready = true;
    return { ok: true, detail: 'mock 内核已就绪（无推理能力，用于链路验证）', processAlive: true };
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.aborted.clear();
  }

  async health(): Promise<HealthReport> {
    return { ok: this.ready, detail: this.ready ? 'ok' : '未启动', processAlive: this.ready };
  }

  /**
   * mock 内核没有 ACP 会话，也就没有 configOptions 真帧可公布 —— 返回 null。
   *
   * 这里刻意不返回一个「差不多」的清单：宿主拿到 null 会显示 mock 自己的
   * 内置条目（models.ts 的 mockCatalog），那条路径上的每个字都是真的
   * （它确实是 mock 自报的）。若在适配器这一层编一份官方清单顶上，
   * 「这个清单从哪来」就再也说不清了。
   */
  async modelCatalog(): Promise<null> {
    return null;
  }

  abort(runId: string): boolean {
    if (this.aborted.has(runId)) return false;
    this.aborted.add(runId);
    log.info(`收到中断信号: ${runId}`);
    return true;
  }

  async run(ctx: RunContext): Promise<RunStatus> {
    const startedAt = Date.now();
    ctx.emit({
      type: 'run.started',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      mode: ctx.mode,
      model: ctx.model,
    });

    try {
      assertNotAborted(ctx.signal);

      if (ctx.memoryContext) {
        // mock 没有推理能力，但注入链路是真的：如实确认收到，不假装自己「记得」用户
        await this.think(
          ctx,
          `宿主为本轮注入了记忆上下文（${ctx.memoryContext.length} 字符）。mock 内核已如实收到；按记忆调整回答需要真实 Harness 内核。`,
        );
      }

      if (ctx.skillContext) {
        // mock 没有推理能力，但注入链路是真的：如实确认收到，不假装自己「会用」这些技能
        await this.think(
          ctx,
          `宿主为本轮注入了技能上下文（${ctx.skillContext.length} 字符）。mock 内核已如实收到；语义匹配与按技能执行需要真实 Harness 内核。`,
        );
      }

      await this.think(ctx, '先看清工作区里有什么，再决定动手的范围。');
      const listing = await this.callTool(ctx, 'fs.list', { path: '.', depth: 2 }, '列出工作区文件');

      const fileCount = listing.ok ? listing.output.split('\n').filter(Boolean).length : 0;
      await this.say(ctx, `工作区里可见 ${fileCount} 个条目。`);

      assertNotAborted(ctx.signal);

      const candidate = this.pickReadableFile(listing.output);
      if (candidate) {
        await this.think(ctx, `挑一个体积合适的文本文件读一下：${candidate}`);
        const read = await this.callTool(ctx, 'fs.read', { path: candidate }, `读取 ${candidate}`);
        const lines = read.ok ? read.output.split('\n').length : 0;
        await this.say(ctx, `\n已读取 \`${candidate}\`，共 ${lines} 行。`);
      } else {
        await this.say(ctx, '\n工作区里没有可直接读取的文本文件，跳过读取。');
      }

      assertNotAborted(ctx.signal);

      await this.think(ctx, '确认一下运行时环境。');
      const version = await this.callTool(ctx, 'shell.run', { command: 'node -v' }, '查询 Node 版本');
      const nodeVersion = version.output.trim() || '未知';
      await this.say(ctx, `\n运行时：${nodeVersion}。`);

      assertNotAborted(ctx.signal);

      // ── 写操作 ──────────────────────────────────────────────
      // 这三步是差异审阅链路的验证用例，形态刚好互补：
      //   fs.write 新建文件       —— 差异全是新增行（created=true），不可逐块取舍
      //   fs.edit  精确替换       —— 差异是一进一出（+1 −1），只有一块，也不可逐块取舍
      //   fs.write 补全既有文件   —— 两处改动相隔较远，切出两个 hunk，可逐块取舍
      // 第三个用例是刻意加的：没有它，「逐 hunk 授权」这条链路在端到端里就只剩单测覆盖，
      // 而它恰恰是这一步里最容易在跨进程序列化过程中出问题的地方。
      //
      // 落点选在工作区根目录而不是 .deepwork/ 下面：后者在文件树里是忽略项，
      // 写进去的改动在界面上看不见，用户就没法把「审批时看到的差异」与「磁盘上的结果」对上。
      // 这只是一个演示脚本，但它必须落在用户真能看见的地方。
      const notes = 'AGENT-NOTES.md';

      /** 笔记正文。两处可变字段的位置刻意隔开 10 行以上，确保差异引擎切出两个独立 hunk */
      const notesBody = (review: string, analysis: string, todo: string) =>
        [
          '# Agent 运行笔记',
          '',
          '## 环境',
          `- Node 版本：${nodeVersion}`,
          `- 工作区条目：${fileCount}`,
          `- 平台：${process.platform}`,
          '',
          '## 观察',
          '- 工作区可读',
          '- 目录结构已列出',
          `- ${analysis}`,
          '- 未发现异常文件',
          '- 未执行写操作之外的命令',
          '',
          '## 复核',
          `- 复核结论：${review}`,
          '- 复核时间：-',
          '',
          '## 待办',
          '- 等待用户确认',
          `- ${todo}`,
          '',
        ].join('\n');

      await this.think(ctx, '把这一轮的观察写成一份笔记；这一步会新建文件，改动内容需要你先看过再授权。');
      const created = await this.callTool(
        ctx,
        'fs.write',
        { path: notes, content: notesBody('待复核', '尚未深入分析', '待补充后续改动') },
        `新建 ${notes}`,
      );

      assertNotAborted(ctx.signal);

      let revised: { ok: boolean; output: string } | null = null;
      if (created.ok) {
        await this.think(ctx, '复核一下刚写下的结论，把待复核那行替换成实际结果。');
        revised = await this.callTool(
          ctx,
          'fs.edit',
          {
            path: notes,
            old_string: '- 复核结论：待复核',
            new_string: `- 复核结论：已复核（读取到 ${fileCount} 个条目）`,
          },
          `更新 ${notes} 的复核结论`,
        );
      }

      assertNotAborted(ctx.signal);

      // 第三处改动与前两处相隔较远，差异会被切成两块 —— 用户可以只采纳其中一块。
      let finalized: { ok: boolean; output: string } | null = null;
      if (created.ok && revised?.ok) {
        await this.think(
          ctx,
          '最后把观察结论与待办一起收尾；这次有两处互不相邻的改动，你可以只采纳其中一处。',
        );
        finalized = await this.callTool(
          ctx,
          'fs.write',
          {
            path: notes,
            content: notesBody(
              `已复核（读取到 ${fileCount} 个条目）`,
              '已完成初步分析',
              '无（本轮已收尾）',
            ),
          },
          `补全 ${notes} 的结论与待办`,
        );
      }

      const notesLine = created.ok
        ? finalized?.ok
          ? `${finalized.output}`
          : revised?.ok
            ? `已新建并按复核结果更新，收尾未完成（${firstLine(finalized?.output ?? '已跳过')}）`
            : `已新建，但更新未完成（${firstLine(revised?.output ?? '已跳过')}）`
        : `未写入（${firstLine(created.output)}）`;

      const summary = [
        '\n\n---\n**本轮小结**',
        `- 工作区条目：${fileCount}`,
        `- Node 版本：${nodeVersion}`,
        `- 运行笔记：${notesLine}`,
        '',
        '当前内核为 mock：它只负责驱动工具与协议，真正的模型推理需要切到 Harness 适配器。',
      ].join('\n');

      await this.say(ctx, summary);

      /*
       * 模拟一帧「被内核沙箱拦下」。
       *
       * ── 为什么要让 mock 造这一帧 ────────────────────────────────────────
       * 与上面 `context.usage` 同理（见那一段的注释）：`[sandbox: file access denied
       * under <mode> mode]` 是**只有真实内核**才会产的帧。没有这一帧，界面上
       * 「被沙箱拦下」这条渲染路径在任何自动化测试与截图里都跑不到 ——
       * 只能靠人手动把真实内核配成受限档位、再诱导模型越界写，才看得见一眼。
       *
       * ── 它证明了什么、不证明什么（别混）────────────────────────────────
       * 证明：**渲染路径**可达（卡片、档位标签、升级说明真的画得出来）。
       * 不证明：沙箱真的会拦。那件事的取证在 tools/sandbox-e2e.js，那里是真内核 +
       * 真 ACP + 真落盘，真帧的来源写在那个文件头。
       *
       * ── 两个刻意的选择 ──────────────────────────────────────────────────
       * 1. 用环境变量开闸，而不是直接插进演示链：演示链（新建 → 编辑 → 收尾）是
       *    chat / tree / preview / hunk 四张验收截图的共同底稿，多一步会让那四张
       *    一起变样 —— 而「照着旧图能再跑出同一幅画面」正是验收截图的全部价值。
       * 2. 放在**演示链末尾**而不是中间：截图拍到的是视口底部，放中间会被后面流出来的
       *    内容顶出画面（第一次拍就是这样，回执说卡片在、图上却看不见）。
       *    靠 `DEEPWORK_CAPTURE_FOCUS` 把它滚回中央试过，没有生效；
       *    与其和滚动机制较劲，不如让它在结尾 —— 这是确定性的做法。
       */
      if (process.env.DEEPWORK_MOCK_SANDBOX_DENIAL === '1') {
        await this.think(ctx, '收尾前再试一次：把临时结果写到工作区外的目录，确认边界是否生效。');
        this.simulateSandboxDenial(ctx);
      }

      /*
       * 模拟「模型带 sandbox_permissions 重试，于是弹审批」。
       *
       * ── 为什么要有这一帧 ──────────────────────────────────────────────
       * 与上面那帧同理，而且更迫切：升级审批弹窗的**全部内容**（档位、模型写的理由）
       * 都是宿主从工具入参里补出来的，靠真实内核根本凑不齐一次可复现的画面 ——
       * 得先把内核配成受限档位、诱导模型越界、再赌它真的照提示重试。
       * 没有这一帧，这个弹窗在自动化路径上永远看不见，「显示了什么」只剩人工去试。
       *
       * ── 它证明什么、不证明什么 ────────────────────────────────────────
       * 证明：**渲染路径可达**（档位与理由真的画得出来）。
       * 不证明：真内核下模型会重试。那件事的取证在 tools/sandbox-e2e.js 的 E 组
       * （真内核 + 真 ACP + 真落盘），那里同时给出了「模型不会自动重试」的对照。
       *
       * ── 为什么 await 它的结果 ─────────────────────────────────────────
       * 因为它后面那一帧要如实反映用户点了什么。不给审批结论就编一个成功，
       * 等于在演示链里放进一句没人负责的话。
       */
      if (process.env.DEEPWORK_MOCK_SANDBOX_ESCALATION === '1') {
        await this.think(ctx, '工作区外那个目录写不进去 —— 按提示带 sandbox_permissions 申请一次更宽权限。');
        await this.simulateEscalation(ctx);
      }

      const completionTokens = Math.round(summary.length / 2);
      ctx.emit({
        type: 'usage',
        runId: ctx.runId,
        usage: { promptTokens: 0, completionTokens, costCny: 0 },
      });

      /*
       * 上下文占用。mock 是**模拟器**，所以它连内核这条上报也一并模拟 ——
       * 理由不是"补全功能"，而是：只有真实内核会报的话，界面这条渲染路径
       * 在任何自动化测试与截图里都跑不到，「显示了什么」就只能靠人去开真内核看。
       *
       * 数字随对话累积而不是取常量：常量会让「占用增长」这个唯一能看出它对不对的
       * 现象消失，渲染错了也看不出来。
       */
      this.contextUsed += completionTokens;
      ctx.emit({
        type: 'context.usage',
        runId: ctx.runId,
        used: this.contextUsed,
        size: MOCK_CONTEXT_WINDOW,
      });

      const status: RunStatus = ctx.signal.aborted ? 'aborted' : 'completed';
      ctx.emit({
        type: 'run.completed',
        runId: ctx.runId,
        status,
        durationMs: Date.now() - startedAt,
      });
      return status;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        ctx.emit({
          type: 'run.completed',
          runId: ctx.runId,
          status: 'aborted',
          durationMs: Date.now() - startedAt,
        });
        return 'aborted';
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error('run 失败', message);
      ctx.emit({ type: 'run.failed', runId: ctx.runId, message, retryable: true });
      return 'failed';
    } finally {
      this.aborted.delete(ctx.runId);
    }
  }

  private async think(ctx: RunContext, text: string): Promise<void> {
    await this.streamText(ctx, 'reasoning.delta', text, 18, 12);
  }

  private async say(ctx: RunContext, text: string): Promise<void> {
    await this.streamText(ctx, 'message.delta', text, 6, 8);
  }

  /** 按小块推送文本，模拟 token 流；同时响应中断 */
  private async streamText(
    ctx: RunContext,
    type: 'reasoning.delta' | 'message.delta',
    text: string,
    chunkSize: number,
    delayMs: number,
  ): Promise<void> {
    for (let i = 0; i < text.length; i += chunkSize) {
      assertNotAborted(ctx.signal);
      ctx.emit({ type, runId: ctx.runId, text: text.slice(i, i + chunkSize) });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  private async callTool(
    ctx: RunContext,
    name: string,
    args: Record<string, unknown>,
    summary: string,
  ): Promise<{ ok: boolean; output: string; risk: RiskLevel }> {
    const toolCtx = createToolContext({
      workspace: ctx.workspace,
      guard: ctx.guard,
      signal: ctx.signal,
      requestApproval: ctx.requestApproval,
    });

    // 副作用预览必须在 tool.started **之前**产出：
    // 这样工具卡片还在「执行中」的时候，用户就能看到即将发生的改动，
    // 而不是等结果回来、文件已经落盘了才补一份差异。
    const diff = await ctx.tools.previewFor(name, args, toolCtx);

    const call: ToolCall = {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      name,
      args,
      summary,
      risk: this.assessRisk(ctx, name, args),
      diff: diff ?? undefined,
    };
    ctx.emit({ type: 'tool.started', runId: ctx.runId, call });

    const startedAt = Date.now();
    // 同一个 toolCtx 继续交给执行阶段：预检快照沿用它，
    // 因此「展示给用户的差异」与「实际写入的内容」来自同一次文件读取
    const result = await ctx.tools.execute(name, args, toolCtx);

    ctx.emit({
      type: 'tool.completed',
      runId: ctx.runId,
      callId: call.id,
      ok: result.ok,
      output: result.output,
      durationMs: Date.now() - startedAt,
    });
    return { ok: result.ok, output: result.output, risk: call.risk };
  }

  /**
   * 造一帧「被内核沙箱拦下」的工具结果（只在 DEEPWORK_MOCK_SANDBOX_DENIAL=1 时走到）。
   *
   * 与 `context.usage` 那段同理：这一帧**只有真实内核会产**，不让模拟器造的话，
   * 界面的渲染路径在自动化截图里永远跑不到。它证明渲染可达，不证明沙箱会拦 ——
   * 后者是真内核取证的事（tools/sandbox-e2e.js）。
   */
  private simulateSandboxDenial(ctx: RunContext): void {
    const call: ToolCall = {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      name: 'fs.write',
      args: { path: '../shared/cache.json', content: '{}\n' },
      summary: '写入工作区外的 ../shared/cache.json',
      risk: 'confirm',
    };
    ctx.emit({ type: 'tool.started', runId: ctx.runId, call });
    ctx.emit({
      type: 'tool.completed',
      runId: ctx.runId,
      callId: call.id,
      ok: false,
      // 逐字真帧副本，与解析层的参照物是同一份字面量（见 MOCK_SANDBOX_DENIAL）
      output: MOCK_SANDBOX_DENIAL,
      durationMs: 3,
    });
  }

  /**
   * 造一次「带升级申请的审批」（只在 DEEPWORK_MOCK_SANDBOX_ESCALATION=1 时走到）。
   *
   * 注意它走的是**与真内核同一条**宿主审批通道（ctx.requestApproval），
   * 而不是自己伪造一帧审批事件 —— 伪造的话，这个场景证明的只是
   * 「弹窗会渲染我塞的字段」，证不了「适配器补出来的升级信息能到弹窗」。
   * 真内核那条路已在 sandbox-e2e 的 E1 里验过（宿主收到的档位与理由与发出去的逐字相同）。
   */
  private async simulateEscalation(ctx: RunContext): Promise<void> {
    const call: ToolCall = {
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      name: 'fs.write',
      args: {
        path: MOCK_SANDBOX_ESCALATION.path,
        content: '{}\n',
        sandbox_permissions: MOCK_SANDBOX_ESCALATION.mode,
        justification: MOCK_SANDBOX_ESCALATION.justification,
      },
      summary: `写入工作区外的 ${MOCK_SANDBOX_ESCALATION.path}（申请放宽沙箱）`,
      risk: 'confirm',
    };
    ctx.emit({ type: 'tool.started', runId: ctx.runId, call });

    const outcome = await ctx.requestApproval({
      tool: 'fs.write',
      subject: MOCK_SANDBOX_ESCALATION.path,
      reason: '模型在申请放宽沙箱档位（仅这一次调用）',
      escalation: {
        mode: MOCK_SANDBOX_ESCALATION.mode,
        knownMode: true,
        justification: MOCK_SANDBOX_ESCALATION.justification,
      },
    });

    ctx.emit({
      type: 'tool.completed',
      runId: ctx.runId,
      callId: call.id,
      ok: outcome.approved,
      output: outcome.approved
        ? `已按升级后的档位写入 ${MOCK_SANDBOX_ESCALATION.path}（仅这一次调用生效）`
        : MOCK_ESCALATION_REJECTED,
      durationMs: 4,
    });
  }

  private assessRisk(ctx: RunContext, name: string, args: Record<string, unknown>): RiskLevel {
    if (name === 'shell.run' && typeof args.command === 'string') {
      return ctx.guard.assess(args.command).risk;
    }
    if (name === 'fs.write') return 'confirm';
    return 'safe';
  }

  /** 从文件列表里挑一个适合读取的文本文件 */
  private pickReadableFile(listing: string): string | null {
    const entries = listing.split('\n').map((line) => line.trim()).filter(Boolean);
    const readable = entries.filter(
      (entry) =>
        !entry.endsWith('/') &&
        !entry.includes('node_modules') &&
        /\.(md|json|ts|tsx|js|jsx|txt|yml|yaml|css|html)$/i.test(entry),
    );
    const preferred = readable.find((entry) => /package\.json$/i.test(entry)) ?? readable[0];
    return preferred ?? null;
  }
}

/** 取输出首行作为简短引用，避免把多行错误整段塞进小结 */
function firstLine(text: string): string {
  const line = text.split('\n').map((item) => item.trim()).filter(Boolean)[0] ?? '无输出';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
