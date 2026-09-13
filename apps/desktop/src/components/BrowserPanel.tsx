import { useCallback, useEffect, useState } from 'react';
import {
  BROWSER_ACTIONS,
  BROWSER_MCP_SERVER_NAME,
  BROWSER_TOOL_RISK,
  browserMcpToolName,
  type BrowserAction,
  type BrowserShotImage,
  type BrowserShotInfo,
  type BrowserState,
} from '@deepwork/protocol';
import { browserShotRead, browserShots, describeError, formatBytes } from '../api';
import { PanelPage } from './PanelPage';

interface BrowserPanelProps {
  state: BrowserState | null;
  notice: string | null;
  onRefresh: () => Promise<void>;
  onOpen: (url: string) => Promise<void>;
  onShutdown: () => Promise<void>;
  onDismissNotice: () => void;
  onClose: () => void;
}

/** 动作的中文名（与 core-host 的 BROWSER_ACTION_LABEL 同一含义；面板只用于展示） */
const ACTION_LABEL: Record<BrowserAction, string> = {
  navigate: '打开网址',
  content: '读取文本',
  click: '点击元素',
  type: '输入文本',
  evaluate: '执行脚本',
  screenshot: '截图',
};

/**
 * 浏览器面板。
 *
 * ── 它到底在管什么 ──────────────────────────────────────────────────
 * 管一个**受管浏览器**（专用 profile、默认无界面）的生死与现状：
 * 模型用它访问网页，用户在这里看到它在访问哪里、拍下了什么。
 *
 * 面板能做三件事：打开网页（用户自己的动作，不走审批）、查看截图、关闭浏览器。
 * 它**不做**点击/输入/求值：那些是模型的活，且必须过审批 ——
 * 面板替用户点一下页面，与模型替用户点一下，授权含义完全不同。
 *
 * ── 为什么「关闭浏览器」的返回文案要显示出来 ────────────────────────
 * 内核侧的 MCP 服务与宿主是两个进程，二者共用同一个浏览器实例。
 * 如果实例是 MCP 服务拉起的，宿主的「关闭」只能断开连接、不能杀进程 ——
 * 把这句话原样显示出来，用户才不会对着一个「关了但进程还在」的按钮反复点。
 */
export function BrowserPanel({
  state,
  notice,
  onRefresh,
  onOpen,
  onShutdown,
  onDismissNotice,
  onClose,
}: BrowserPanelProps) {
  const [url, setUrl] = useState('');
  const [shots, setShots] = useState<BrowserShotInfo[]>([]);
  const [shotError, setShotError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<BrowserShotImage | null>(null);
  const [busy, setBusy] = useState(false);

  const running = state?.running === true;

  const loadShots = useCallback(async () => {
    try {
      setShots(await browserShots());
      setShotError(null);
    } catch (cause) {
      setShotError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    void loadShots();
  }, [loadShots]);

  // 截图张数变化时重拉清单：模型刚截的那张要立刻出现在这里，
  // 否则用户得手动刷新才看得到 —— 而「看不到」会被理解成「没截图成功」。
  useEffect(() => {
    void loadShots();
  }, [state?.shotCount, loadShots]);

  const submit = async () => {
    const target = url.trim();
    if (!target) return;
    setBusy(true);
    try {
      await onOpen(target);
      await loadShots();
    } finally {
      setBusy(false);
    }
  };

  const openShot = async (shot: BrowserShotInfo) => {
    try {
      setViewing(await browserShotRead(shot.path));
      setShotError(null);
    } catch (cause) {
      setShotError(describeError(cause));
    }
  };

  return (
    <PanelPage
      title="浏览器"
      subtitle="CDP 驱动系统浏览器 · 默认后台运行（无窗口）"
      onBack={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={() => void onRefresh().then(loadShots)}>
            刷新
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void onShutdown()}
            disabled={!running}
            title={running ? '关闭受管浏览器进程' : '浏览器当前未运行'}
          >
            关闭浏览器
          </button>
        </>
      }
    >
      {notice ? (
        <div className="banner banner-info">
          <span>{notice}</span>
          <button type="button" className="icon-btn" onClick={onDismissNotice}>
            ×
          </button>
        </div>
      ) : null}

      <div className="browser-status">
        <span className={`browser-dot${running ? ' browser-dot-on' : ''}`} />
        <span className="browser-status-text">{running ? '运行中' : '未启动'}</span>
        {running ? (
          <>
            <span className="browser-meta">pid {state?.pid}</span>
            <span className="browser-meta">端口 {state?.port}</span>
            {state?.executable ? (
              <span className="browser-meta browser-meta-path" title={state.executable}>
                {state.executable}
              </span>
            ) : null}
          </>
        ) : (
          <span className="browser-meta">首次打开网页时自动启动</span>
        )}
        <span className="panel-spacer" />
        <span className="browser-meta">截图 {shots.length} 张</span>
      </div>

      <div className="browser-bar">
        <input
          className="browser-url"
          value={url}
          placeholder="输入网址后回车（例如 https://example.com）"
          spellCheck={false}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          disabled={busy}
        />
        <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || !url.trim()}>
          打开
        </button>
      </div>

      {running && state?.url ? (
        <div className="browser-current">
          <div className="browser-current-title" title={state.title ?? ''}>
            {state.title || '(无标题)'}
          </div>
          <div className="browser-current-url" title={state.url}>
            {state.url}
          </div>
        </div>
      ) : null}

      <div className="browser-section">
        <div className="browser-section-head">
          <span>截图</span>
          <span className="panel-spacer" />
          <button type="button" className="btn-tiny" onClick={() => void loadShots()}>
            重新载入
          </button>
        </div>
        {shotError ? <div className="banner banner-error">{shotError}</div> : null}
        {shots.length === 0 ? (
          <div className="empty-hint">
            还没有截图。模型调用 <code>browser_screenshot</code> 之后，截图会出现在这里。
          </div>
        ) : (
          <div className="browser-shot-grid">
            {shots.map((shot) => (
              <ShotCard key={shot.path} shot={shot} onOpen={() => void openShot(shot)} />
            ))}
          </div>
        )}
      </div>

      <div className="browser-section">
        <div className="browser-section-head">
          <span>模型可用的浏览器工具</span>
          <span className="panel-spacer" />
          <span className="browser-meta">
            经内核 MCP 服务注册为 mcp__{BROWSER_MCP_SERVER_NAME}__*
          </span>
        </div>
        <div className="browser-tools">
          {BROWSER_ACTIONS.map((action) => {
            const risk = BROWSER_TOOL_RISK[action];
            return (
              <div className="browser-tool" key={action}>
                <code className="browser-tool-name">{browserMcpToolName(action)}</code>
                <span className="browser-tool-label">{ACTION_LABEL[action]}</span>
                <span className={`browser-tool-risk browser-tool-risk-${risk}`}>
                  {risk === 'danger' ? '高风险 · 需确认' : risk === 'safe' ? '只读' : '需确认'}
                </span>
              </div>
            );
          })}
        </div>
        <div className="browser-hint">
          这六个动作由模型发起，每一次都要你确认；面板上的「打开」是你自己的动作，因此不弹确认。
        </div>
      </div>

      {viewing ? (
        <div className="modal-mask" onClick={() => setViewing(null)}>
          <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span className="modal-tool">截图</span>
              <code className="preview-path" title={viewing.path}>
                {viewing.path}
              </code>
              <span className="panel-spacer" />
              <span className="preview-size">{formatBytes(viewing.size)}</span>
              <button type="button" className="icon-btn" onClick={() => setViewing(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <img className="browser-shot-full" src={viewing.dataUrl} alt="浏览器截图" />
            </div>
          </div>
        </div>
      ) : null}
    </PanelPage>
  );
}

/**
 * 一张截图的缩略卡片。
 *
 * 每张卡片自己读自己的 dataUrl（而不是父组件一次读完整个清单）：
 * 截图可能有很多张，而用户通常只看最近一张 —— 一次读全部会在打开面板时
 * 同步搬几十 MB 的 base64 进渲染层。`alive` 标记防止组件卸载后 setState。
 */
function ShotCard({ shot, onOpen }: { shot: BrowserShotInfo; onOpen: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void browserShotRead(shot.path)
      .then((image) => {
        if (alive) setSrc(image.dataUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [shot.path]);

  return (
    <button type="button" className="browser-shot" onClick={onOpen} title={shot.path}>
      <div className="browser-shot-thumb">
        {src ? (
          <img src={src} alt={shot.name} loading="lazy" />
        ) : (
          <span className="browser-shot-placeholder">{failed ? '读取失败' : '读取中…'}</span>
        )}
      </div>
      <div className="browser-shot-name" title={shot.name}>
        {shot.name}
      </div>
      <div className="browser-shot-size">{formatBytes(shot.size)}</div>
    </button>
  );
}
