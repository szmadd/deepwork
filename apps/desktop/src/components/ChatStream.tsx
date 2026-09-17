import { useEffect, useRef, useState } from 'react';
import type { TimelineItem } from '../timeline';
import { ToolCard } from './ToolCard';

interface ChatStreamProps {
  items: TimelineItem[];
  /** 在某一轮之后分叉出新会话；未提供时不显示该入口 */
  onFork?: (atSeq: number) => void;
}

const RUN_LABEL: Record<string, string> = {
  completed: '完成',
  aborted: '已中断',
  failed: '失败',
};

export function ChatStream({ items, onFork }: ChatStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items, autoScroll]);

  return (
    <div
      className="stream"
      onScroll={(event) => {
        const el = event.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        setAutoScroll(atBottom);
      }}
    >
      {items.length === 0 ? (
        <div className="stream-empty">
          <div className="stream-empty-title">开始一个新任务</div>
          <div className="stream-empty-sub">
            内核会真实地读写工作区文件、执行命令，并在需要时向你申请授权。
          </div>
        </div>
      ) : null}

      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div className="row row-user" key={item.id}>
                <div className="bubble bubble-user">{item.text}</div>
              </div>
            );

          case 'reasoning':
            return (
              <div className="row" key={item.id}>
                <details className="reasoning" open={item.streaming}>
                  <summary>
                    思考过程{item.streaming ? <span className="pulse" /> : null}
                  </summary>
                  <div className="reasoning-body">{item.text}</div>
                </details>
              </div>
            );

          case 'message':
            return (
              <div className="row row-assistant" key={item.id}>
                <div className="bubble bubble-assistant">
                  <Markdown text={item.text} />
                  {item.streaming ? <span className="caret" /> : null}
                </div>
              </div>
            );

          case 'tool':
            return (
              <div className="row row-tool" key={item.id}>
                <ToolCard call={item.call} result={item.result} />
              </div>
            );

          case 'notice':
            /*
             * remedy 与 basis 分开成行，不折进 text：
             *  「发生了什么」「该怎么办」「凭什么这么说」是三件事，折成一段话之后
             *  用户会跳过整段。其中 basis 尤其不能省 —— 它是「这条结论有多新」的唯一线索
             *  （端点可达性提示的依据是最近一次探测，不是此刻的实时状态）。
             */
            return (
              <div className={`row notice notice-${item.level}`} key={item.id}>
                <div>{item.text}</div>
                {item.remedy ? <div className="notice-remedy">{item.remedy}</div> : null}
                {item.basis ? <div className="notice-basis">{item.basis}</div> : null}
              </div>
            );

          case 'run':
            return (
              <div className="row run-footer" key={item.id}>
                · {RUN_LABEL[item.status] ?? item.status}
                {item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''} ·
                {onFork ? (
                  /*
                   * 分叉入口放在轮次的边界上，而不是每条消息旁边：
                   * 只有一轮完整结束的位置才是合法分支点，界面顺着这个约束长，
                   * 用户就不会点到一个必然被内核拒绝的位置。
                   */
                  <button
                    type="button"
                    className="run-fork"
                    title="从这一轮之后分出新会话，改完的分支不影响当前这条"
                    onClick={() => onFork(item.atSeq)}
                  >
                    在此分支
                  </button>
                ) : null}
              </div>
            );

          default:
            return null;
        }
      })}

      <div ref={bottomRef} />
    </div>
  );
}

/**
 * 极简 Markdown 渲染：只处理代码块、行内代码、粗体、列表与换行。
 * M0 刻意不引入第三方 markdown 依赖——渲染层是唯一允许输出的位置，
 * 等 UI 稳定后再换成完整实现（届时必须同时上 XSS 防护）。
 */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/```/);
  return (
    <>
      {blocks.map((block, index) =>
        index % 2 === 1 ? (
          <pre className="code-block" key={index}>
            {block.replace(/^[a-zA-Z]*\n/, '')}
          </pre>
        ) : (
          <span key={index}>{renderInline(block)}</span>
        ),
      )}
    </>
  );
}

function renderInline(text: string) {
  const lines = text.split('\n');
  return lines.map((line, index) => {
    const bolded = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, partIndex) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={partIndex}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return <code key={partIndex}>{part.slice(1, -1)}</code>;
      }
      return <span key={partIndex}>{part}</span>;
    });
    return (
      <span key={index}>
        {bolded}
        {index < lines.length - 1 ? '\n' : null}
      </span>
    );
  });
}
