import type { ReactNode } from 'react';

interface PanelPageProps {
  title: string;
  /** 标题右侧的一句说明（这个页面存在的理由） */
  subtitle?: string;
  /** 页面头右侧的动作（刷新 / 新增 等） */
  actions?: ReactNode;
  /** 页面底部固定区（保存 / 关闭 等） */
  footer?: ReactNode;
  /**
   * 内容自带内边距与滚动区时置 true（文件树 / 终端这类「面板搬进页面」的视图）。
   * 不置时页体统一给内边距，让表单与表格不用各自对齐一次。
   */
  flush?: boolean;
  /**
   * 嵌进设置里时置 true（用量是设置里的「功能与数据 → 用量」一节）。
   *
   * 只影响**外壳**：页头（返回箭头 + 标题 + 副标题）整块不渲染 ——
   * 那三样在设置里都是重复的（标题是节标题、返回是对话框的 ✕），
   * 页头里唯一有用的 `actions` 会被挪到内容顶部。
   * 页体与页脚一字不改：两个入口下看到的必须是同一份内容。
   */
  embedded?: boolean;
  /** 返回对话 —— rail 之外的第二条退路，成本极低，但少了它用户会先怀疑自己点错了 */
  onBack: () => void;
  children: ReactNode;
}

/**
 * 整页视图外壳。
 *
 * ── 什么该是整页、什么该是浮层（2026-09-18 修过一次）──
 * 判据不是「内容多不多」，而是**它占不占主区里一个可以停下来的位置**：
 *   · 文件 / 终端 / 轨迹 = 整页。它们是工作台的一部分，用户会在那里停一会儿
 *     （翻目录、连着敲几条命令、顺着时间线往回看），而且常常要一边看一边回到对话。
 *   · 审批 = 打断式小弹窗（620px）。内核停下来等你拍板，你只能先处理它。
 *   · 设置 = 覆盖层对话框（880×600）。你是专门去配一次的，配完关掉就回到进来那一页。
 *
 * 这里曾经写着「技能 / 记忆 / … / 设置都不该是弹窗」，理由是弹窗把可用面积压到
 * 620px、且背景「看起来还在、其实点不到」。那两条是**那个弹窗**的具体缺陷，
 * 不是「浮层」这种形态本身的错：设置现在 880×600，遮罩整块盖住 rail 与会话列表，
 * 背景明确地不可点 —— 而用户在观感上要的恰恰是「它像一层盖上去的东西，
 * 而不是又一个页面」。
 *
 * 所以这段注释的正确读法是：**别把工作台的东西塞进浮层，也别把管理类的东西
 * 变回整页** —— 判据是上面那三条，不是「弹窗」「整页」这两个词本身。
 */
export function PanelPage({ title, subtitle, actions, footer, flush, embedded, onBack, children }: PanelPageProps) {
  return (
    <div className={embedded ? 'panel-embed' : 'page-mask'}>
      <section className="page">
        {embedded ? null : (
          <header className="page-head">
            <button type="button" className="icon-btn page-back" onClick={onBack} title="返回对话">
              ←
            </button>
            <div className="page-title">
              <span className="page-title-text">{title}</span>
              {subtitle ? <span className="page-sub">{subtitle}</span> : null}
            </div>
            <span className="panel-spacer" />
            {actions}
          </header>
        )}
        {/* 嵌进设置里时页头整块不在，`actions` 得有个落点 —— 否则「刷新」会跟着页头一起消失 */}
        {embedded && actions ? <div className="panel-embed-actions">{actions}</div> : null}
        <div className={`page-body${flush ? ' page-body-flush' : ''}`}>
          {flush ? <div className="page-fill">{children}</div> : children}
        </div>
        {footer ? <div className="page-foot">{footer}</div> : null}
      </section>
    </div>
  );
}
