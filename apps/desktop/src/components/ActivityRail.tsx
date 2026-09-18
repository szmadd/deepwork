import type { ReactElement } from 'react';
import { APP_VIEW_LABEL, type AppView } from '@deepwork/protocol';

interface ActivityRailProps {
  view: AppView;
  onSelect: (view: AppView) => void;
  /**
   * 设置对话框是否开着。
   *
   * 传的是「开着没有」而不是「当前视图 === 设置」—— 后者在设置变成覆盖层之后
   * 已经不可表达：设置盖住整根栏，`view` 仍然停在进来之前那一页，这是对的
   * （关掉设置要回到那一页）。这个布尔只用来点亮底部那个按钮。
   */
  settingsOpen: boolean;
  onOpenSettings: () => void;
  /** 本次会话改动过的文件数（文件视图的角标） */
  changedCount: number;
  /** 待审批请求数（对话视图的角标）——审批弹窗会盖住界面，角标只是「为什么卡住了」的线索 */
  pendingApprovals: number;
  /** 展开时图标旁显示文字标签；状态持久化在 config.railExpanded */
  expanded: boolean;
  onToggleExpand: () => void;
}

/**
 * 左侧活动栏（rail）。
 *
 * ── 为什么把横排按钮换成竖排图标 ──
 * 原来「文件 / 终端 / Trajectory / 技能 / 记忆 / 自动化 / 连接器 / 设置」是标题栏里的一排
 * 文字按钮：功能每加一个就要多占一截宽度，窄窗口下只能换行成两三排，把标题挤成一列字。
 * 竖排 rail 收起时宽度固定 56px，第 10 个功能与第 1 个功能占用同样的空间 ——
 * 这是当前桌面端的主流形态（也是它被选中的真正原因，而不是「好看」）。
 *
 * ── 可展开 ──
 * 纯图标的代价是语义要靠先验知识：手动调试期实测反馈「认不出哪个是哪个」。
 * 栏底切换按钮在「56px 纯图标」与「148px 图标 + 文字标签」之间切换，
 * 状态持久化在 `config.railExpanded`（默认展开）。
 *
 * ── 图标为什么是内联 SVG ──
 * 不引图标库：本项目「装完就能跑」是硬约束，多一个依赖就多一份体积与供应链面。
 *
 * ── 2026-09-18：这根栏只剩「工作台」（原来分上下两组）──────────────
 * 上组是「这台机器上正在发生什么」（对话 / 文件 / 终端 / 浏览器 / 轨迹），
 * 下组曾是「配置与账本」（技能 / 记忆 / 自动化 / 连接器 / 用量 / 设置）。
 * 下组里除了设置，其余五项**天天不点、偶尔来配一次**，却和日常动作抢同一根栏：
 * 栏越加越长，而两类入口的重要性差一个数量级。现在它们各自是设置里的一节
 * （`SettingsSection`），入口只剩一个 ——「设置」。设置本身固定在栏底：
 * 它是最不该和日常动作抢注意力的那一项。
 *
 * 同一天再改一次：**设置按钮不再是 `ICONS` 里的一个视图条目**。设置从整页变成了
 * 覆盖层，`APP_VIEWS` 里没有它了，于是这里也不能再借 `item(id, label)` 那条路径
 * 渲染它 —— 那条路径要求 id 是 `AppView`（要点亮、要落盘 `lastView`），
 * 而设置两样都不占。这不是类型体操，是两种东西：**上面是「去哪一页」，下面是
 * 「盖上一层」，只有长得像**。所以它有自己的图标常量和自己的一段 JSX。
 *
 * 所以这里**不要**再往栏上加管理类入口：那不是「少点一次」，而是把刚收起来的东西
 * 又摊开一遍。新增一节 = 契约层的 `SETTINGS_SECTIONS` 加一项 + 设置里加一块内容。
 */

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ICONS: Record<AppView, ReactElement> = {
  // 对话气泡
  chat: (
    <path {...STROKE} d="M3.5 5.2A2.2 2.2 0 0 1 5.7 3h6.6a2.2 2.2 0 0 1 2.2 2.2v4.1a2.2 2.2 0 0 1-2.2 2.2H8l-3.4 2.6v-2.6h-.1a1 1 0 0 1-1-1z" />
  ),
  // 文件夹
  files: <path {...STROKE} d="M3 5.6A1.6 1.6 0 0 1 4.6 4h2.6l1.4 1.7h4.8A1.6 1.6 0 0 1 15 7.3v6.1A1.6 1.6 0 0 1 13.4 15H4.6A1.6 1.6 0 0 1 3 13.4z" />,
  // 命令台（>_）
  terminal: (
    <>
      <rect {...STROKE} x="2.6" y="3.6" width="12.8" height="10.8" rx="2" />
      <path {...STROKE} d="M5.4 7.4 7.6 9.4l-2.2 2M9 12h3.2" />
    </>
  ),
  // 地球（浏览器）
  browser: (
    <>
      <circle {...STROKE} cx="9" cy="9" r="6.2" />
      <path {...STROKE} d="M2.9 9h12.2" />
      <ellipse {...STROKE} cx="9" cy="9" rx="2.7" ry="6.2" />
    </>
  ),
  // 时间线（轨迹）
  trajectory: (
    <>
      <path {...STROKE} d="M4.5 4.6v10.8M4.5 6.4h7.8M4.5 10h5.4M4.5 13.6h9" />
      <circle {...STROKE} cx="4.5" cy="6.4" r="1.5" />
    </>
  ),
};

/**
 * 设置按钮的图标（滑杆）。
 *
 * 单独一个常量而不是 `ICONS.settings`：设置不在 `AppView` 里了，
 * 留一个用不到的表项等于「栏上图标数」与「栏上该有几个图标」不再对得上。
 */
const SETTINGS_ICON = (
  <>
    <path {...STROKE} d="M3.4 6.2h11.2M3.4 11.8h11.2" />
    <circle {...STROKE} cx="7.2" cy="6.2" r="1.7" />
    <circle {...STROKE} cx="11.4" cy="11.8" r="1.7" />
  </>
);

/**
 * 工作台视图。skill / memory / schedules / connectors / usage 的图标随它们一起
 * 搬进了设置 —— 那五个图标留在这里会变成 `ICONS` 里的死条目，
 * 而「栏上有几个图标」与「栏上该有几个图标」就不再对得上。
 */
const WORK_VIEWS: AppView[] = ['chat', 'files', 'terminal', 'browser', 'trajectory'];

export function ActivityRail({
  view,
  onSelect,
  settingsOpen,
  onOpenSettings,
  changedCount,
  pendingApprovals,
  expanded,
  onToggleExpand,
}: ActivityRailProps) {
  const item = (id: AppView, label: string, badge?: number) => (
    <button
      type="button"
      key={id}
      className={`rail-item${view === id ? ' rail-item-on' : ''}`}
      onClick={() => onSelect(id)}
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
        {ICONS[id]}
      </svg>
      {expanded ? <span className="rail-label">{label}</span> : null}
      {badge && badge > 0 ? <span className="rail-badge">{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  );

  return (
    <nav className={`rail${expanded ? ' rail-expanded' : ''}`} aria-label="主导航">
      <div className="rail-mark" title="深边AI Work" />
      <div className="rail-group">
        {WORK_VIEWS.map((id) => item(id, APP_VIEW_LABEL[id], id === 'chat' ? pendingApprovals : id === 'files' ? changedCount : undefined))}
      </div>
      <div className="rail-spacer" />
      {/*
        展开/收起切换：与设置相邻但不是一个视图，语义是「这根栏本身长什么样」。
        title 与 aria-label 在两种状态下各自说清「点它会变成什么」。
      */}
      <button
        type="button"
        className="rail-item rail-toggle"
        onClick={onToggleExpand}
        title={expanded ? '收起导航栏（只留图标）' : '展开导航栏（显示文字标签）'}
        aria-label={expanded ? '收起导航栏' : '展开导航栏'}
      >
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          {expanded ? (
            <path {...STROKE} d="M11 4.5 6.5 9l4.5 4.5" />
          ) : (
            <path {...STROKE} d="M7 4.5 11.5 9 7 13.5" />
          )}
        </svg>
        {expanded ? <span className="rail-label">收起</span> : null}
      </button>
      {/*
        设置固定底部：它是最不该与日常动作抢注意力的那一项。
        它盖住整根栏，所以点亮它用的是 `settingsOpen` 而不是 `view === ...`
        （见 props 注释）。aria-haspopup 说明「点它弹出的是对话框」——
        与上面那些「换一页」的按钮读给屏幕阅读器的信息不同。
      */}
      <button
        type="button"
        className={`rail-item${settingsOpen ? ' rail-item-on' : ''}`}
        onClick={onOpenSettings}
        title="设置"
        aria-label="设置"
        aria-haspopup="dialog"
      >
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          {SETTINGS_ICON}
        </svg>
        {expanded ? <span className="rail-label">设置</span> : null}
      </button>
    </nav>
  );
}
