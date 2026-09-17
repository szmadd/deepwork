import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  applySkillCommandCompletion,
  skillCommandCompletion,
  type SkillRecord,
} from '@deepwork/protocol';

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  /**
   * 已安装技能，供 `/` 补全用。
   * 宿主未就绪或还没拉过清单时是空数组 —— 此时不弹补全（而不是弹一个空列表）。
   */
  skills: SkillRecord[];
  /** 卡片左下角的附件入口；已附加的清单由 AttachmentBar 画在卡片上方 */
  onAddAttachment: () => void;
  /** 动作区里、发送按钮左侧的自定义控件（模式 / 模型 chip，由 App 传入） */
  controls?: ReactNode;
  onSend: (text: string) => void;
  onAbort: () => void;
}

/**
 * 输入卡片的正文区（输入框 + 动作栏 + 技能名补全）。
 *
 * ── 形态 ──────────────────────────────────────────────────────────
 * 动作栏两端各一个动作：左下角是附件（裸图标「+」），右下角依次是模式 /
 * 模型 chip 与圆形的发送按钮（空文本时是灰色禁用态）。
 * 快捷键说明不再占一行文字 —— 它挂在输入框的 title 上，而「输入 / 唤起技能」
 * 写在 placeholder 里（placeholder 是唯一必然被读到的一行）。
 *
 * ── 补全的判定与插入都在契约层 ──────────────────────────────────────
 * `skillCommandCompletion` / `applySkillCommandCompletion` 住在 protocol：
 * 「什么位置算在打技能名」「插入后要不要补一个空格」这两件事与内核侧
 * 认哪种写法（`EXPLICIT_RE`）是同一份知识，写在组件里就成了第二份实现，
 * 而两份不一致的表现很隐蔽 —— 补全出来的东西插进去不生效。
 *
 * ── 键盘优先级 ────────────────────────────────────────────────────
 * 补全打开时，↑↓ 选候选、Enter/Tab 采用候选、Esc 关掉；补全关闭时 Enter 才是发送。
 * 不这样分，用户选中候选按回车会**直接把半截技能名发出去** —— 那是一次
 * 真实的、会消耗额度并可能改文件的误操作，不是「体验稍差」。
 */
export function Composer({ disabled, running, skills, onAddAttachment, controls, onSend, onAbort }: ComposerProps) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  /** Esc 关掉之后，在文本再次变化前不再弹（否则一按键就重新出现，Esc 形同虚设） */
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  /** 待恢复的光标位置：受控组件重渲染后才能在 DOM 上设置 */
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    const el = ref.current;
    if (!el || pendingCaret.current === null) return;
    el.selectionStart = pendingCaret.current;
    el.selectionEnd = pendingCaret.current;
    pendingCaret.current = null;
  }, [text]);

  const completion = useMemo(
    () => (dismissed ? null : skillCommandCompletion({ text, caret, skills })),
    [text, caret, skills, dismissed],
  );

  // 候选变少时把高亮位拉回范围内：否则会出现「列表只剩 1 项，高亮还停在第 3 项」，
  // 那时回车采用的是一个看不见的候选
  const activeIndex = completion ? Math.min(active, completion.candidates.length - 1) : 0;

  const applyCandidate = (name: string) => {
    if (!completion) return;
    const next = applySkillCommandCompletion(text, completion, name);
    setText(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
    setActive(0);
  };

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText('');
    setCaret(0);
    setDismissed(false);
  };

  return (
    <div className="composer">
      {completion ? (
        <ul className="composer-complete" role="listbox">
          {completion.candidates.map((candidate, index) => (
            <li
              key={candidate.name}
              role="option"
              aria-selected={index === activeIndex}
              className={`composer-complete-item${index === activeIndex ? ' composer-complete-on' : ''}`}
              // 用 onMouseDown 而不是 onClick：onClick 之前 textarea 会先失焦，
              // 失焦会让 caret 状态停在旧值上，插入点就错了
              onMouseDown={(event) => {
                event.preventDefault();
                applyCandidate(candidate.name);
              }}
            >
              <code>/{candidate.name}</code>
              <span className="composer-complete-desc">{candidate.description || '（无描述）'}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={ref}
        className="composer-input"
        placeholder={disabled ? '等待内核就绪…' : '描述任务，「/」唤起技能…'}
        title="Enter 发送 · Shift+Enter 换行 · 输入 / 唤起技能"
        value={text}
        disabled={disabled}
        rows={1}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setActive(0);
          setDismissed(false);
        }}
        // 点选、方向键移动光标都会改插入点，补齐这三个事件补全才会跟着走
        onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyUp={(event) => {
          if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
            setCaret(event.currentTarget.selectionStart ?? 0);
          }
        }}
        onKeyDown={(event) => {
          if (completion) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((prev) => (prev + 1) % completion.candidates.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((prev) => (prev - 1 + completion.candidates.length) % completion.candidates.length);
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              if (!event.nativeEvent.isComposing) {
                event.preventDefault();
                applyCandidate(completion.candidates[activeIndex].name);
                return;
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setDismissed(true);
              return;
            }
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {/*
        动作栏：两端各一个动作。
        左下角是附件（原来是一枚「+ 附件」文字按钮，现在收成裸图标 ——
        文字说明挪到它的 title 上，那里本来也需要写清「附件路径会进会话日志」）；
        右下角是模式 / 模型 chip 与发送，发送是这张卡的主动作，做成圆形主色按钮。
      */}
      <div className="composer-actions">
        <button
          type="button"
          className="composer-icon"
          onClick={onAddAttachment}
          disabled={disabled}
          title="添加附件（路径会随本轮对话进入会话日志，Agent 可按需读取）"
          aria-label="添加附件"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

        {running ? (
          <button type="button" className="composer-icon composer-stop" onClick={onAbort} title="中断当前任务" aria-label="中断">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor" />
            </svg>
          </button>
        ) : null}

        <span className="composer-actions-gap" />
        {controls}
        <button
          type="button"
          className="composer-send"
          disabled={disabled || !text.trim()}
          onClick={submit}
          title="发送（Enter）"
          aria-label="发送"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M8 12.6V3.9M4.5 7.4 8 3.8l3.5 3.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
