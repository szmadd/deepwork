import { SETTINGS_GROUPS, SETTINGS_SECTION_LABEL, SETTINGS_SECTION_NOTE, type SettingsSection } from '@deepwork/protocol';

interface SettingsNavProps {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}

/**
 * 设置页的左导航。
 *
 * ── 分组与条目都从契约层渲染 ────────────────────────────────────────
 * `SETTINGS_GROUPS` / `SETTINGS_SECTION_LABEL` 是唯一真源，这里一个字符串都不写死。
 * 好处不是「少写几个字」，而是：新增一节时只改契约层一处，导航、页头副标题、
 * 「打开设置并定位到某一节」三个地方同时正确 —— 分开写的话，漏改的那一处
 * 不会报错，只会安静地少一个入口。
 *
 * ── 为什么整组一起渲染而不做成可折叠 ────────────────────────────────
 * 12 节摊开也只占一屏（组标题比条目矮一档），折叠省下的空间换不来任何东西，
 * 却多一个「我以为它没了」的状态。条目上的 title 给的是该节的说明，
 * 与页头副标题同源 —— 悬停时看到的和点进去看到的必须是同一句话。
 */
export function SettingsNav({ section, onSelect }: SettingsNavProps) {
  return (
    <nav className="settings-nav" aria-label="设置分节">
      {SETTINGS_GROUPS.map((group) => (
        <div className="settings-nav-group" key={group.id}>
          <div className="settings-nav-title">{group.label}</div>
          {group.sections.map((id) => (
            <button
              type="button"
              key={id}
              className={`settings-nav-item${section === id ? ' settings-nav-on' : ''}`}
              title={SETTINGS_SECTION_NOTE[id]}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => onSelect(id)}
            >
              {SETTINGS_SECTION_LABEL[id]}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
