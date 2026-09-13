import { useEffect, useRef, useState } from 'react';

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function Composer({ disabled, running, onSend, onAbort }: ComposerProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText('');
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        className="composer-input"
        placeholder={disabled ? '等待内核就绪…' : '描述任务，Enter 发送，Shift+Enter 换行'}
        value={text}
        disabled={disabled}
        rows={1}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
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
