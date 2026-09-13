import crypto from 'node:crypto';
import type { AgentEventInput, RunStatus, RiskLevel, ToolCall } from '@deepwork/protocol';
import { createLogger } from '../logger';
import { createToolContext } from '../tools/registry';
import { assertNotAborted, type HarnessAdapter, type HealthReport, type RunContext } from './types';

const log = createLogger('adapter:mock');

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

      const completionTokens = Math.round(summary.length / 2);
      ctx.emit({
        type: 'usage',
        runId: ctx.runId,
        usage: { promptTokens: 0, completionTokens, costCny: 0 },
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
