'use strict';

/**
 * 设置导航与「管理类收进设置 / 设置自身改成覆盖层」的契约测试。
 *
 *   npm run test:settings
 *
 * ── 这一层为什么必须有 ────────────────────────────────────────────────
 * 2026-09-18 这一轮改了两刀，都动在同一个地方（`AppView`）：
 *   ① 「技能 / 记忆 / 自动化 / 连接器 / 用量」从 rail 的一级入口收进设置，`AppView` 收窄；
 *   ② 设置自己从「占满主区的整页」改成「覆盖层对话框」，`AppView` 再收窄一次。
 * 这类改动的失败形态**全都是静默的**：
 *   · 契约收了、rail 忘了改 → 栏上留着一个点不到任何东西的入口；
 *   · 契约收了、面板忘了改成覆盖层 → rail 上高亮一个主区里不存在的页面；
 *   · `lastView` 折回漏了 → 升级上来的机器主区一片空白，而原因只写在 config.json 里；
 *   · 「设置开着没有」被写进 `lastView` → 下次启动弹一个对话框出来；
 *   · `SETTINGS_GROUPS` 漏掉一节 → 那一节**永远打不开**（设置里没有入口），
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
 * 已经收进设置里的五个旧视图名（第一次收窄）。
 *
 * 刻意在测试里**再写一遍字面量**而不是从契约推导：这一条断言的用途正是
 * 「收窄没有漏掉任何一个」—— 从 APP_VIEWS 推导出来的清单永远等于 APP_VIEWS，
 * 那它就什么都验不了。
 */
const RETIRED_VIEWS = ['skills', 'memory', 'schedules', 'connectors', 'usage'];

/**
 * 第二次收窄：**设置自己**也退出了视图清单（整页 → 覆盖层）。
 *
 * 它刻意不并进 `RETIRED_VIEWS`：那五条的判据是「不再是视图，而成了设置里的一节」，
 * 而设置成了另一种东西 —— 一层盖在工作台上面的界面，既不是视图也不是分节。
 * 混在一起改，下一个人就会把「设置也是设置里的一节」当成事实写进代码。
 */
const SETTINGS_IS_NOT_A_VIEW = 'settings';

// ══════════════════════════════════════════════════════════
// 1. 契约：视图收窄 + 设置分节
// ══════════════════════════════════════════════════════════
console.log('\n── 契约：视图与设置分节 ──');

check(
  '主区视图只剩工作台（五个：设置自己也不再是视图）',
  APP_VIEWS.join(',') === 'chat,files,terminal,browser,trajectory',
  APP_VIEWS.join(','),
);
check(
  '五个管理类页面不再是视图',
  RETIRED_VIEWS.every((id) => !APP_VIEWS.includes(id)),
  RETIRED_VIEWS.filter((id) => APP_VIEWS.includes(id)).join(', ') || 'ok',
);
check(
  '设置不再是视图（它是覆盖层），也不是设置里的一节',
  !APP_VIEWS.includes(SETTINGS_IS_NOT_A_VIEW) &&
    !SETTINGS_SECTIONS.includes(SETTINGS_IS_NOT_A_VIEW) &&
    !APP_VIEW_LABEL[SETTINGS_IS_NOT_A_VIEW],
  `${APP_VIEWS.length} 个视图 / ${SETTINGS_SECTIONS.length} 节`,
);
check(
  '收进设置里的那五个各有对应分节（一个都没漏）',
  RETIRED_VIEWS.every((id) => SETTINGS_SECTIONS.includes(id)),
  RETIRED_VIEWS.filter((id) => !SETTINGS_SECTIONS.includes(id)).join(', ') || 'ok',
);
check(
  'isAppView 只认这五个（旧值必须被拒，不能悄悄放行）',
  APP_VIEWS.every((v) => isAppView(v)) &&
    !isAppView('skills') &&
    !isAppView('settings') &&
    !isAppView(undefined) &&
    !isAppView(7),
);
check(
  '每个视图都有中文标签，且标签表与清单同源',
  APP_VIEWS.every((v) => Boolean(APP_VIEW_LABEL[v])) &&
    Object.keys(APP_VIEW_LABEL).sort().join(',') === [...APP_VIEWS].sort().join(','),
);

const grouped = SETTINGS_GROUPS.flatMap((g) => g.sections);
check(
  '每一节都出现在分组里（漏掉的那一节在设置里永远打不开）',
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
  '每一节都有名字与一句说明（左导航 title 与内容列标题共用它）',
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
/*
 * 设置一旦进了这个下拉，用户就能选出一个「启动时弹一个设置对话框出来」的状态 ——
 * 那不是他能用的状态（启动后第一件事是关掉它）。而这一条之所以需要断言：
 * 候选是直接从 APP_VIEWS 生成的，看上去不可能出错，但正因为「看上去不可能」，
 * 哪天有人手抄一份候选时也不会有人复核。
 */
check(
  '「启动时打开的视图」里没有设置（覆盖层不该被选成启动状态）',
  !CONFIG_FIELDS.lastView.values.includes(SETTINGS_IS_NOT_A_VIEW),
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
      rejected.includes('不是合法值') && rejected.includes('收进设置'),
      rejected,
    );

    let rejectedSettings = '';
    try {
      host.setConfig({ lastView: 'settings' });
    } catch (error) {
      rejectedSettings = String(error instanceof Error ? error.message : error);
    }
    check(
      '「settings」作为视图同样被拒绝（它现在是覆盖层，不是能落盘的页面）',
      rejectedSettings.includes('不是合法值') && rejectedSettings.includes('覆盖层'),
      rejectedSettings,
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
     * 同一条路上还有第二种旧值：**上一版把设置当成视图**，于是 config.json 里
     * 可能就是 "lastView": "settings"。折回漏了它的表现是「启动后主区一片空白 +
     * 高亮着一个不存在的页面」—— 比 skills 更隐蔽，因为设置本身还在（只是变成了覆盖层）。
     */
    fs.writeFileSync(
      path.join(process.env.DEEPWORK_HOME, 'config.json'),
      JSON.stringify({ lastView: 'settings', settingsSection: 'model' }, null, 2),
    );
    const foldedSettings = host.getConfig();
    check(
      '上一版留下的 lastView「settings」也被折回（它现在是覆盖层，不是页面）',
      foldedSettings.lastView === DEFAULT_CONFIG.lastView,
      foldedSettings.lastView,
    );
    check(
      '折回 lastView 不影响它是旧文件里的另一个键（settingsSection 照旧读出）',
      foldedSettings.settingsSection === 'model',
      foldedSettings.settingsSection,
    );

    /*
     * 两条护栏缺一不可：只折回不拒绝 = 界面自己可以写出坏值；
     * 只拒绝不折回 = 手改过的旧文件让界面停在一个不存在的页面上。
     *
     * 这一段用一份新的坏文件重来一次，是为了让「读没有副作用」这条断言
     * 盯着的确实是磁盘上的字节（上面那两份写盘都被后续步骤覆盖过）。
     */
    fs.writeFileSync(
      path.join(process.env.DEEPWORK_HOME, 'config.json'),
      JSON.stringify({ lastView: 'skills' }, null, 2),
    );
    host.getConfig();
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
    '活动栏的视图清单 = 契约里的工作台视图',
    workViews !== null && workViews.join(',') === APP_VIEWS.join(','),
    workViews ? workViews.join(',') : '没找到 WORK_VIEWS',
  );
  check(
    '活动栏不再有管理类入口',
    RETIRED_VIEWS.every((id) => !new RegExp(`['"]${id}['"]`).test(rail)),
    RETIRED_VIEWS.filter((id) => new RegExp(`['"]${id}['"]`).test(rail)).join(', ') || 'ok',
  );
  /*
   * 设置按钮从 `ICONS` 表里搬出来这件事必须有断言。
   * 表里留一个 `settings: (...)` 不会让任何东西变红（`Record<AppView, …>` 那层
   * 类型约束会被 `as any` 之类随手绕过），而它的后果很具体：
   * 「栏上有几个图标」与「栏上该有几个图标」不再对得上，下一个人照着表加图标时
   * 会以为设置也走 `item()` 那条「换一页」的路径 —— 而它已经是「盖上一层」了。
   */
  check(
    '设置按钮不再借 ICONS / item() 那条「换一页」的路径',
    rail.includes('SETTINGS_ICON') && !/\n\s*settings: \(/.test(rail) && rail.includes('settingsOpen'),
  );

  const nav = read('apps', 'desktop', 'src', 'components', 'SettingsNav.tsx');
  check(
    '左导航从契约渲染（分组与条目名都不写死在 JSX 里）',
    nav.includes('SETTINGS_GROUPS.map') && nav.includes('SETTINGS_SECTION_LABEL[id]') && nav.includes('SETTINGS_SECTION_NOTE[id]'),
  );

  const panel = read('apps', 'desktop', 'src', 'components', 'SettingsPanel.tsx');
  check('设置改用左导航（三页签已退休）', panel.includes('<SettingsNav') && !panel.includes('settings-tabs'));
  /*
   * 断言盯的是**渲染出来的外壳**（`className="page-mask"`），而不是「文件里出现过
   * 这三个字」—— 注释里提到旧外壳是正常的（要说明它为什么不在），
   * 把注释也算成违规的断言只会在下一次有人补充说明时莫名其妙地变红，
   * 而那时改的人会去改注释，而不是去查真正的接线。
   */
  check(
    '设置是覆盖层：用自己的遮罩与对话框，不再借整页外壳（page-mask）',
    panel.includes('settings-mask') &&
      panel.includes('settings-dialog') &&
      !panel.includes('className="page-mask"') &&
      !panel.includes('className="page-head"'),
  );
  check(
    '面板里给两条关闭路径（✕ 与点遮罩），且不再有「返回对话」——它已经不占主区了',
    panel.includes('settings-close') && panel.includes('onMouseDown') && !panel.includes('返回对话'),
  );
  check(
    '五个管理面板由 App 注入（设置不认识它们的 props）',
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
    '「打开设置并定位到某一节」是唯一入口（不再有独立的管理类/设置视图分支）',
    app.includes('const openSettings = (target?: SettingsSection)') &&
      !/view === '(skills|memory|schedules|connectors|usage|settings)'/.test(app),
  );
  /*
   * 三层状态必须分开：设置「开着没有」（临时）、「停在哪一节」（落盘）、
   * 主区「在哪一页」（落盘）。把前两者合并进 lastView 的后果很具体 ——
   * 下次启动弹一个设置对话框出来，而用户的第一动作是关掉它。
   */
  check(
    '「设置开着没有」是临时状态，不写进 lastView（写进去就会开机弹窗）',
    app.includes('const [settingsOpen, setSettingsOpen] = useState(false)') && !app.includes("lastView: 'settings'"),
  );
  check(
    'Esc 能关设置，且监听只在开着时才挂（关着时按 Esc 不该被这里吃掉）',
    app.includes('if (!settingsOpen) return;') &&
      app.includes("event.key === 'Escape'") &&
      app.includes("window.addEventListener('keydown'") &&
      app.includes("window.removeEventListener('keydown'"),
  );
  check(
    '设置挂在审批弹窗之前：同 z-index 时 DOM 靠后的赢，审批必须在最上面',
    app.indexOf('<SettingsPanel') > 0 && app.indexOf('<SettingsPanel') < app.indexOf('<ApprovalDialog'),
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
    '设置两栏、内嵌面板与覆盖层都有样式',
    ['.settings-nav-item', '.settings-content', '.panel-embed', '.settings-mask', '.settings-dialog'].every((sel) =>
      css.includes(sel),
    ),
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
