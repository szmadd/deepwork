import { useEffect, useMemo, useRef, useState } from 'react';
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
  onSend: (text: string) => void;
  onAbort: () => void;
}

/**
 * 输入框 + 技能名补全。
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
export function Composer({ disabled, running, skills, onSend, onAbort }: ComposerProps) {
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
        placeholder={
          disabled
            ? '等待内核就绪…'
            : '描述任务，Enter 发送，Shift+Enter 换行；输入 / 可补全技能名'
        }
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
      <div className="composer-actions">
        {running ? (
          <button type="button" className="btn btn-danger" onClick={onAbort}>
            中断
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || !text.trim()}
          onClick={submit}
        >
          发送
        </button>
      </div>
    </div>
  );
}
