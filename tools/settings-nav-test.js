'use strict';

/**
 * 设置页导航与「管理类页面收进设置」的契约测试。
 *
 *   npm run test:settings
 *
 * ── 这一层为什么必须有 ────────────────────────────────────────────────
 * 2026-09-18 那次改动把「技能 / 记忆 / 自动化 / 连接器 / 用量」从 rail 的一级入口
 * 收进设置页，`AppView` 随之收窄。这类改动的失败形态**全都是静默的**：
 *   · 契约收了、rail 忘了改 → 栏上留着一个点不到任何东西的入口；
 *   · `lastView` 折回漏了 → 升级上来的机器主区一片空白，而原因只写在 config.json 里；
 *   · `SETTINGS_GROUPS` 漏掉一节 → 那一节**永远打不开**（设置页里没有入口），
 *     而它对应的面板代码、配置项、测试全都还在，谁都不会注意到少了它；
 *   · 分组里某一节写了两遍 → 导航里出现两个同名条目，点哪个「都对」。
 * 这几条都不是「看一眼截图能发现」的，所以断言落在**集合关系**上：
 * 覆盖恰好一次、无孤儿、无重复、与 rail 的清单同源。
 *
 * ── 为什么读源码文本也算数 ────────────────────────────────────────────
 * 这一层验的是「接线」，不是「渲染」。Electron 起不来的时候（沙箱、CI），
 * 源码断言仍然能挡住「改了一半」；而真正长什么样由 tools/capture.sh 的截图负责。
 * 两者的分工写在 docs/CONVENTIONS.md 里，不用一条断言假装它验证了另一件事。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-settings-'));
process.env.DEEPWORK_HOME = path.join(root, '.deepwork');
const workspace = path.join(root, 'ws');
fs.mkdirSync(workspace, { recursive: true });

const {
  APP_VIEWS,
  APP_VIEW_LABEL,
  CONFIG_FIELDS,
  DEFAULT_CONFIG,
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_LABEL,
  SETTINGS_SECTION_NOTE,
  isAppView,
  isSettingsSection,
} = require('../packages/protocol/dist/config');
const { DeepworkHost } = require('../packages/core-host/dist/host');

const repo = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const read = (...parts) => fs.readFileSync(path.join(repo, ...parts), 'utf8');

/**
 * 已经收进设置页的五个旧视图名。
 *
 * 刻意在测试里**再写一遍字面量**而不是从契约推导：这一条断言的用途正是
 * 「收窄没有漏掉任何一个」—— 从 APP_VIEWS 推导出来的清单永远等于 APP_VIEWS，
 * 那它就什么都验不了。
 */
const RETIRED_VIEWS = ['skills', 'memory', 'schedules', 'connectors', 'usage'];

// ══════════════════════════════════════════════════════════
// 1. 契约：视图收窄 + 设置分节
// ══════════════════════════════════════════════════════════
console.log('\n── 契约：视图与设置分节 ──');

check(
  '主区视图只剩工作台 + 设置（六个）',
  APP_VIEWS.join(',') === 'chat,files,terminal,browser,trajectory,settings',
  APP_VIEWS.join(','),
);
check(
  '五个管理类页面不再是视图',
  RETIRED_VIEWS.every((id) => !APP_VIEWS.includes(id)),
  RETIRED_VIEWS.filter((id) => APP_VIEWS.includes(id)).join(', ') || 'ok',
);
check(
  '收进设置页的那五个各有对应分节（一个都没漏）',
  RETIRED_VIEWS.every((id) => SETTINGS_SECTIONS.includes(id)),
  RETIRED_VIEWS.filter((id) => !SETTINGS_SECTIONS.includes(id)).join(', ') || 'ok',
);
check(
  'isAppView 只认这六个（旧值必须被拒，不能悄悄放行）',
  APP_VIEWS.every((v) => isAppView(v)) && !isAppView('skills') && !isAppView(undefined) && !isAppView(7),
);
check(
  '每个视图都有中文标签，且标签表与清单同源',
  APP_VIEWS.every((v) => Boolean(APP_VIEW_LABEL[v])) &&
    Object.keys(APP_VIEW_LABEL).sort().join(',') === [...APP_VIEWS].sort().join(','),
);

const grouped = SETTINGS_GROUPS.flatMap((g) => g.sections);
check(
  '每一节都出现在分组里（漏掉的那一节在设置页里永远打不开）',
  SETTINGS_SECTIONS.every((s) => grouped.includes(s)),
  SETTINGS_SECTIONS.filter((s) => !grouped.includes(s)).join(', ') || 'ok',
);
check(
  '分组里没有契约之外的节（写错的节名会渲染成一个点不开的条目）',
  grouped.every((s) => SETTINGS_SECTIONS.includes(s)),
  grouped.filter((s) => !SETTINGS_SECTIONS.includes(s)).join(', ') || 'ok',
);
check(
  '每一节在导航里恰好出现一次（重复的后果是两个同名条目，点哪个「都对」）',
  new Set(grouped).size === grouped.length && grouped.length === SETTINGS_SECTIONS.length,
  `${grouped.length} 个条目 / ${SETTINGS_SECTIONS.length} 节`,
);
check(
  '每一节都有名字与一句说明（左导航 title 与页头副标题共用它）',
  SETTINGS_SECTIONS.every((s) => Boolean(SETTINGS_SECTION_LABEL[s]) && Boolean(SETTINGS_SECTION_NOTE[s])),
);
check(
  '默认分节是合法值（配置里第一次落盘的也是它）',
  isSettingsSection(DEFAULT_SETTINGS_SECTION) && DEFAULT_CONFIG.settingsSection === DEFAULT_SETTINGS_SECTION,
  DEFAULT_CONFIG.settingsSection,
);
check(
  'isSettingsSection 只认白名单',
  SETTINGS_SECTIONS.every((s) => isSettingsSection(s)) && !isSettingsSection('models') && !isSettingsSection(null),
);
check(
  '「启动时打开的视图」下拉的候选与视图清单同源',
  CONFIG_FIELDS.lastView.values.join(',') === APP_VIEWS.join(','),
  CONFIG_FIELDS.lastView.values.join(','),
);

// ══════════════════════════════════════════════════════════
// 2. 宿主：读时折回、写时拒绝
// ══════════════════════════════════════════════════════════
async function hostSection() {
  console.log('\n── 宿主：配置闸门与升级路径 ──');
  const host = new DeepworkHost();
  await host.start(workspace);
  try {
    let rejected = '';
    try {
      host.setConfig({ lastView: 'skills' });
    } catch (error) {
      rejected = String(error instanceof Error ? error.message : error);
    }
    check(
      '旧的视图名被拒绝，且报错说明它去哪了（不静默落到某个默认视图）',
      rejected.includes('不是合法值') && rejected.includes('收进设置页'),
      rejected,
    );

    let badSection = '';
    try {
      host.setConfig({ settingsSection: 'models' });
    } catch (error) {
      badSection = String(error instanceof Error ? error.message : error);
    }
    check('非法分节被拒绝且报出合法值', badSection.includes('不是合法值') && badSection.includes('appearance'), badSection);

    const saved = host.setConfig({ lastView: 'files', settingsSection: 'usage' });
    check(
      '合法值落盘并回读一致',
      saved.lastView === 'files' && saved.settingsSection === 'usage' &&
        host.getConfig().lastView === 'files' && host.getConfig().settingsSection === 'usage',
    );
    const raw = JSON.parse(fs.readFileSync(path.join(process.env.DEEPWORK_HOME, 'config.json'), 'utf8'));
    check('两个键都真的写进了 config.json', raw.lastView === 'files' && raw.settingsSection === 'usage');

    /*
     * 升级路径：磁盘上那份配置可能是旧版本写下的。
     * 这是本轮最该被守住的一条 —— 折回漏了的表现是「启动后主区一片空白」，
     * 而界面上一个字都不会说，用户只能去翻 config.json。
     */
    fs.writeFileSync(
      path.join(process.env.DEEPWORK_HOME, 'config.json'),
      JSON.stringify({ lastView: 'skills', settingsSection: 'nope', theme: 'dark' }, null, 2),
    );
    const folded = host.getConfig();
    check(
      '旧 config.json 里的 lastView（skills）被折回合法视图',
      folded.lastView === DEFAULT_CONFIG.lastView && APP_VIEWS.includes(folded.lastView),
      folded.lastView,
    );
    check(
      '非法 settingsSection 同样折回默认（同一份旧文件里另一个键）',
      folded.settingsSection === DEFAULT_SETTINGS_SECTION,
      folded.settingsSection,
    );
    check('折回只动这两个键，其余照旧（不能顺手把用户设置清掉）', folded.theme === 'dark', folded.theme);

    /*
     * 两条护栏缺一不可：只折回不拒绝 = 界面自己可以写出坏值；
     * 只拒绝不折回 = 手改过的旧文件让界面停在一个不存在的页面上。
     */
    const afterFold = JSON.parse(fs.readFileSync(path.join(process.env.DEEPWORK_HOME, 'config.json'), 'utf8'));
    check('折回只发生在读的路径上，不改写磁盘（读不该有副作用）', afterFold.lastView === 'skills', afterFold.lastView);
  } finally {
    await host.stop();
  }
}

// ══════════════════════════════════════════════════════════
// 3. 渲染层接线（读源码文本）
// ══════════════════════════════════════════════════════════
function wiringSection() {
  console.log('\n── 渲染层接线 ──');

  const rail = read('apps', 'desktop', 'src', 'components', 'ActivityRail.tsx');
  const workMatch = rail.match(/const WORK_VIEWS: AppView\[\] = \[([^\]]*)\]/);
  const workViews = workMatch
    ? workMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    : null;
  check(
    '活动栏的视图清单 = 契约里的工作台视图（设置挂在底部，不算在内）',
    workViews !== null && workViews.join(',') === APP_VIEWS.filter((v) => v !== 'settings').join(','),
    workViews ? workViews.join(',') : '没找到 WORK_VIEWS',
  );
  check(
    '活动栏不再有管理类入口',
    RETIRED_VIEWS.every((id) => !new RegExp(`['"]${id}['"]`).test(rail)),
    RETIRED_VIEWS.filter((id) => new RegExp(`['"]${id}['"]`).test(rail)).join(', ') || 'ok',
  );

  const nav = read('apps', 'desktop', 'src', 'components', 'SettingsNav.tsx');
  check(
    '左导航从契约渲染（分组与条目名都不写死在 JSX 里）',
    nav.includes('SETTINGS_GROUPS.map') && nav.includes('SETTINGS_SECTION_LABEL[id]') && nav.includes('SETTINGS_SECTION_NOTE[id]'),
  );

  const panel = read('apps', 'desktop', 'src', 'components', 'SettingsPanel.tsx');
  check('设置页改用左导航（三页签已退休）', panel.includes('<SettingsNav') && !panel.includes('settings-tabs'));
  check(
    '五个管理面板由 App 注入（设置页不认识它们的 props）',
    panel.includes('panels: Partial<Record<SettingsSection, ReactNode>>') && panel.includes('panels[section]'),
  );

  const app = read('apps', 'desktop', 'src', 'App.tsx');
  check(
    'App 为每一节都传了内容（缺一节 = 那一节点开是空白）',
    RETIRED_VIEWS.every((id) => new RegExp(`^\\s*${id}: \\(`, 'm').test(app)),
    RETIRED_VIEWS.filter((id) => !new RegExp(`^\\s*${id}: \\(`, 'm').test(app)).join(', ') || 'ok',
  );
  const COMPONENT = {
    skills: 'SkillsPanel',
    memory: 'MemoryPanel',
    schedules: 'SchedulesPanel',
    connectors: 'ConnectorsPanel',
    usage: 'UsagePanel',
  };
  check(
    '五个面板都以内嵌形态挂载（不再各自渲染整页外壳）',
    RETIRED_VIEWS.every((id) => new RegExp(`<${COMPONENT[id]}\\s*\\n\\s*embedded`).test(app)),
    RETIRED_VIEWS.filter((id) => !new RegExp(`<${COMPONENT[id]}\\s*\\n\\s*embedded`).test(app)).join(', ') || 'ok',
  );
  check(
    '「打开设置并定位到某一节」是唯一入口（不再有独立的管理类视图分支）',
    app.includes("const openSettings = (target?: SettingsSection)") &&
      !/view === '(skills|memory|schedules|connectors|usage)'/.test(app),
  );

  for (const file of ['SkillsPanel', 'MemoryPanel', 'SchedulesPanel', 'ConnectorsPanel', 'PanelPage']) {
    const src = read('apps', 'desktop', 'src', 'components', `${file}.tsx`);
    check(
      `${file} 支持内嵌形态（embedded + panel-embed）`,
      src.includes('embedded?: boolean') && src.includes('panel-embed'),
    );
  }

  const css = read('apps', 'desktop', 'src', 'styles.css');
  check(
    '设置页两栏与内嵌面板都有样式',
    ['.settings-nav-item', '.settings-content', '.panel-embed'].every((sel) => css.includes(sel)),
  );
  /*
   * 变量名拼错的后果是「颜色静默失效」——浏览器把 var(--typo) 当成未定义，
   * 那一处就不上色，而深色下往往正好是「看起来还行」的那种坏。
   */
  const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))];
  const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const undeclared = used.filter((name) => !declared.has(name));
  check('样式表里用到的每个变量都有定义（拼错的变量名不会报错，只会不上色）', undeclared.length === 0, undeclared.join(', ') || `${used.length} 个变量全部有定义`);
}

async function main() {
  await hostSection();
  wiringSection();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n设置导航测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
