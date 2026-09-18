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
   * 嵌进设置页时置 true（用量是设置页里的「功能与数据 → 用量」一节）。
   *
   * 只影响**外壳**：页头（返回箭头 + 标题 + 副标题）整块不渲染 ——
   * 那三样在设置页里都是重复的，页头里唯一有用的 `actions` 会被挪到内容顶部。
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
 * ── 为什么功能页不再是居中弹窗 ──
 * 弹窗的语义是「打断当前动作，处理完这件事再回来」，所以它适合审批。
 * 而技能 / 记忆 / 自动化 / 连接器 / 设置这些页面，用户是**专门去管理**的：
 * 在弹窗里做管理，等于同时承受两件坏事 —— 可用面积被压到 620px 宽，
 * 以及背后那些「看起来还在、其实点不到」的界面元素。
 *
 * 因此这里给出的是一个真正的页面：占满主区、独立滚动、有自己的头部。
 * 审批弹窗保持弹窗（见 ApprovalDialog），因为它确实是在打断你。
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
        {/* 嵌进设置页时页头整块不在，`actions` 得有个落点 —— 否则「刷新」会跟着页头一起消失 */}
        {embedded && actions ? <div className="panel-embed-actions">{actions}</div> : null}
        <div className={`page-body${flush ? ' page-body-flush' : ''}`}>
          {flush ? <div className="page-fill">{children}</div> : children}
        </div>
        {footer ? <div className="page-foot">{footer}</div> : null}
      </section>
    </div>
  );
}
