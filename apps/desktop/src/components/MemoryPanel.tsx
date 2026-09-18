import { useEffect, useState } from 'react';
import type { MemoryEntry, MemoryLayer, MemoryLayerStat } from '@deepwork/protocol';
import { describeError } from '../api';

interface MemoryPanelProps {
  /** 当前会话绑定的工作区（工作区层条目按它取） */
  workspace: string | null;
  memories: MemoryEntry[];
  stats: MemoryLayerStat[];
  onRefresh: () => Promise<void>;
  onAdd: (layer: MemoryLayer, text: string, workspace?: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onSetProfile: (text: string) => Promise<void>;
  onClose: () => void;
  /**
   * 嵌进设置页时置 true（2026-09-18 起记忆是设置页里的「功能与数据 → 记忆」一节）。
   * 只影响外壳：不渲染页头与页脚里的「返回对话」，页体一字不改 ——
   * 两个入口下看到的必须是同一份内容。
   */
  embedded?: boolean;
}

const LAYER_TABS: Array<{ id: MemoryLayer; label: string; hint: string }> = [
  { id: 'profile', label: '画像', hint: '跨会话、跨项目的用户画像（本地画像，云同步未实现）。只读注入每轮对话，修改走整体保存。' },
  { id: 'user', label: '用户级', hint: '本机所有项目共享的显式记忆（「我喜欢…」「以后都…」）。受总字符预算约束，超限会被拒绝。' },
  { id: 'workspace', label: '工作区', hint: '仅当前项目的精选笔记。另有每日运行日志由宿主自动追加（append-only），超 30 天按月归档。' },
];

const ORIGIN_LABEL = { user: '用户', agent: '内核', distilled: '蒸馏' } as const;

/**
 * 记忆面板。
 *
 * ── 为什么预算要摆在这里 ──
 * 用户级与工作区层有总字符预算，超限的写入会被内核拒绝。如果界面不显示
 * 「还能写多少」，用户只能从一次失败里学到这条规则 —— 所以每层头顶直接
 * 挂 entries/chars/budget 用量，输入框旁边挂剩余预算。
 *
 * ── 事实来源 ──
 * 条目与用量全部来自内核侧（每次操作后重拉），渲染层不维护第二份副本，
 * 不存在「界面上还在、磁盘上没了」的幽灵状态。
 */
export function MemoryPanel({
  workspace,
  memories,
  stats,
  onRefresh,
  onAdd,
  onRemove,
  onSetProfile,
  onClose,
  embedded,
}: MemoryPanelProps) {
  const [tab, setTab] = useState<MemoryLayer>('profile');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const stat = stats.find((item) => item.layer === tab) ?? null;
  const tabMeta = LAYER_TABS.find((item) => item.id === tab)!;

  return (
    <div className={embedded ? 'panel-embed' : 'page-mask'}>
      <div className="page">
        {embedded ? null : (
          <div className="page-head">
            <button type="button" className="icon-btn page-back" onClick={onClose} title="返回对话">
              ←
            </button>
            <span className="page-title-text">记忆</span>
            <span className="panel-spacer" />
          </div>
        )}

        <div className="settings-tabs">
          {LAYER_TABS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`settings-tab${tab === item.id ? ' settings-tab-on' : ''}`}
              onClick={() => {
                setTab(item.id);
                setError(null);
              }}
            >
              {item.label}
              {stats.find((s) => s.layer === item.id)?.entries
                ? ` ${stats.find((s) => s.layer === item.id)!.entries}`
                : ''}
            </button>
          ))}
        </div>

        <div className="page-body">
          {error ? <div className="banner banner-error">{error}</div> : null}

          <div className="modal-hint">{tabMeta.hint}</div>
          {stat ? (
            <div className="memory-usage">
              {stat.entries} 条 · {stat.chars}/{stat.budget} 字符
              {stat.truncated ? ' · 注入时已截断' : ''}
            </div>
          ) : null}

          {tab === 'profile' ? (
            <ProfileEditor
              memories={memories}
              busy={busy}
              onSave={async (text) => {
                setBusy(true);
                setError(null);
                try {
                  await onSetProfile(text);
                } catch (cause) {
                  setError(describeError(cause));
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : (
            <EntryList
              layer={tab}
              workspace={workspace}
              memories={memories.filter((item) => item.layer === tab)}
              stat={stat}
              busy={busy}
              onAdd={async (text) => {
                setBusy(true);
                setError(null);
                try {
                  await onAdd(tab, text, tab === 'workspace' ? (workspace ?? undefined) : undefined);
                } catch (cause) {
                  // 预算超限等拒绝原因原样摆出 —— 这正是「先看见，再发生」
                  setError(describeError(cause));
                  throw cause;
                } finally {
                  setBusy(false);
                }
              }}
              onRemove={async (id) => {
                setError(null);
                try {
                  await onRemove(id);
                } catch (cause) {
                  setError(describeError(cause));
                }
              }}
            />
          )}
        </div>

        <div className="page-foot">
          <button type="button" className="btn" onClick={() => void onRefresh()}>
            刷新
          </button>
          {embedded ? null : (
            <button type="button" className="btn btn-primary" onClick={onClose}>
              返回对话
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 画像层：整段文本的展示与编辑（保存走 memory.setProfile 整体覆写） */
function ProfileEditor({
  memories,
  busy,
  onSave,
}: {
  memories: MemoryEntry[];
  busy: boolean;
  onSave: (text: string) => Promise<void>;
}) {
  const profile = memories.find((item) => item.layer === 'profile')?.text ?? '';
  const [draft, setDraft] = useState(profile);
  const [saved, setSaved] = useState(false);

  // 外部刷新（例如别处保存后重拉）时同步草稿；用户正在编辑时不覆盖其未保存内容
  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  return (
    <div className="memory-profile">
      <textarea
        className="settings-input settings-textarea memory-profile-editor"
        rows={10}
        placeholder="例：我是后端工程师，偏好简洁直接的回答；答复默认用中文。"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaved(false);
        }}
      />
      <div className="memory-editor-foot">
        <span className="memory-usage">{draft.trim().length} 字符（注入上限 2000，超出部分注入时截断）</span>
        <span className="panel-spacer" />
        {saved ? <span className="skill-clean">已保存</span> : null}
        <button
          type="button"
          className="btn btn-primary btn-tiny"
          disabled={busy || draft.trim() === profile}
          onClick={() => {
            void onSave(draft).then(() => setSaved(true));
          }}
        >
          {busy ? '保存中…' : profile ? '保存修改' : '保存画像'}
        </button>
      </div>
    </div>
  );
}

/** 用户级 / 工作区层：条目列表 + 显式添加（带剩余预算提示）+ 删除 */
function EntryList({
  layer,
  workspace,
  memories,
  stat,
  busy,
  onAdd,
  onRemove,
}: {
  layer: MemoryLayer;
  workspace: string | null;
  memories: MemoryEntry[];
  stat: MemoryLayerStat | null;
  busy: boolean;
  onAdd: (text: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const remaining = stat ? stat.budget - stat.chars : null;
  const workspaceMissing = layer === 'workspace' && !workspace;

  return (
    <div className="memory-entries">
      {memories.length === 0 ? (
        <div className="empty-hint">
          {layer === 'user' ? '还没有用户级记忆。' : '当前工作区还没有精选笔记。'}
          写入是显式动作：在这里添加，或在每轮对话结束后由宿主追加当日运行日志。
        </div>
      ) : (
        memories.map((entry) => (
          <div className="memory-entry" key={entry.id}>
            <div className="memory-entry-text">{entry.text}</div>
            <div className="memory-entry-meta">
              <span>
                {ORIGIN_LABEL[entry.origin]} · {entry.createdAt.slice(0, 10)}
              </span>
              <span className="panel-spacer" />
              <button type="button" className="btn-tiny btn-danger" onClick={() => void onRemove(entry.id)}>
                删除
              </button>
            </div>
          </div>
        ))
      )}

      <div className="memory-add">
        <textarea
          className="settings-input settings-textarea"
          rows={2}
          placeholder={
            layer === 'user' ? '记一条对所有项目生效的偏好或事实…' : '记一条仅本项目生效的精选笔记…'
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="memory-editor-foot">
          {remaining !== null ? (
            <span className={`memory-usage${draft.trim().length > remaining ? ' memory-usage-over' : ''}`}>
              剩余预算 {remaining} 字符{draft.trim().length > remaining ? '（超出，提交会被拒绝）' : ''}
            </span>
          ) : null}
          <span className="panel-spacer" />
          <button
            type="button"
            className="btn btn-primary btn-tiny"
            disabled={busy || !draft.trim() || workspaceMissing}
            title={workspaceMissing ? '当前没有会话工作区，无法写入工作区记忆' : undefined}
            onClick={() => {
              void onAdd(draft).then(
                () => setDraft(''),
                () => undefined,
              );
            }}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
