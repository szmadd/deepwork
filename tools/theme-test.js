'use strict';

/**
 * 主题切换（浅 / 深 / 跟随系统）测试 —— 契约解析、配置闸门、样式表变量完整性。
 *
 *   npm run test:theme
 *
 * ── 为什么这一层必须有 ─────────────────────────────────────────────
 * 「深色主题」最容易出现的失败形态是**局部坏掉而不是整体坏掉**：某个提示条
 * 忘了翻面，深色页面上冒出一个浅底深字的色块；某个变量只在浅色块里定义过，
 * 深色下它继承浅色的值，于是某段文字在深色底上变成深色 —— 看不见，但不报错。
 * 这类问题不会在「点一下切换看看」里被发现（没人会逐条去数），只会在某个
 * 特定面板打开时才暴露。所以断言落在**变量集合的完整性**上：
 * :root 里每一个颜色变量都必须在深色块里有对应覆盖，漏一个就是红。
 *
 * ── 契约层那一条为什么不可省 ───────────────────────────────────────
 * 档位 → 方案的解析（resolveTheme）住在契约层，界面与测试共用同一份。
 * 如果它只在渲染层，测试就只能靠读源码文本去猜，而那证明不了运行时的行为。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-theme-'));
process.env.DEEPWORK_HOME = path.join(root, '.deepwork');
const workspace = path.join(root, 'ws');
fs.mkdirSync(workspace, { recursive: true });

const {
  DEFAULT_CONFIG,
  THEME_MODES,
  THEME_MODE_LABEL,
  CONFIG_FIELDS,
  isThemeMode,
  resolveTheme,
} = require('../packages/protocol/dist/config');
const { DeepworkHost } = require('../packages/core-host/dist/host');

const repo = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ══════════════════════════════════════════════════════════
// 1. 契约层：档位与解析
// ══════════════════════════════════════════════════════════
console.log('\n── 主题契约 ──');

check('三个档位齐备且顺序固定（跟随系统在最后）', THEME_MODES.join(',') === 'light,dark,system', THEME_MODES.join(','));
check('每个档位都有中文标签', THEME_MODES.every((mode) => Boolean(THEME_MODE_LABEL[mode])));
check('isThemeMode 只认这三个值', THEME_MODES.every((mode) => isThemeMode(mode)) && !isThemeMode('auto') && !isThemeMode(undefined));
check(
  'resolveTheme：固定档位不看系统偏好',
  resolveTheme('light', true) === 'light' && resolveTheme('dark', false) === 'dark',
);
check(
  'resolveTheme：跟随系统两向都对',
  resolveTheme('system', true) === 'dark' && resolveTheme('system', false) === 'light',
);
check('默认档位是浅色（与切换器接通前的实际渲染一致，避免突然翻面）', DEFAULT_CONFIG.theme === 'light', DEFAULT_CONFIG.theme);
check(
  '设置页字段枚举与档位清单同源',
  CONFIG_FIELDS.theme.values.join(',') === THEME_MODES.join(','),
  CONFIG_FIELDS.theme.values.join(','),
);

// ══════════════════════════════════════════════════════════
// 2. 宿主：配置闸门
// ══════════════════════════════════════════════════════════
async function hostSection() {
  console.log('\n── 宿主配置闸门 ──');
  const host = new DeepworkHost();
  await host.start(workspace);
  try {
    let rejected = '';
    try {
      host.setConfig({ theme: 'solarized' });
    } catch (error) {
      rejected = String(error instanceof Error ? error.message : error);
    }
    check(
      '非法档位被拒绝且报出合法值（不静默落到某个默认）',
      rejected.includes('不是合法值') && rejected.includes('light / dark / system'),
      rejected,
    );

    const saved = host.setConfig({ theme: 'dark' });
    check('合法档位落盘并回读一致', saved.theme === 'dark' && host.getConfig().theme === 'dark');

    const raw = JSON.parse(fs.readFileSync(path.join(process.env.DEEPWORK_HOME, 'config.json'), 'utf8'));
    check('坏值没有被写进 config.json', raw.theme === 'dark', raw.theme);
  } finally {
    await host.stop();
  }
}

// ══════════════════════════════════════════════════════════
// 3. 样式表：深色必须整组覆盖
// ══════════════════════════════════════════════════════════
function styleSection() {
  console.log('\n── 样式表变量完整性 ──');
  const css = fs.readFileSync(path.join(repo, 'apps', 'desktop', 'src', 'styles.css'), 'utf8');

  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
  const darkStart = css.indexOf("html[data-theme='dark'] {");
  check('深色块挂在 html[data-theme]（原生控件读根元素的 color-scheme）', darkStart > 0);
  check('选择器不是 body（挂 body 覆盖不到 select 下拉与滚动条）', !/body\[data-theme/.test(css));
  const darkBlock = css.slice(darkStart, css.indexOf('\n}', darkStart));

  const namesOf = (block) => [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]);
  const rootVars = [...new Set(namesOf(rootBlock))];
  const darkVars = new Set(namesOf(darkBlock));

  // 少数变量是两种主题共用的（几何、字体、终端内的浅色文字）
  const SHARED = ['--radius', '--font', '--mono', '--terminal-text', '--terminal-dim'];
  const missing = rootVars.filter((name) => !darkVars.has(name) && !SHARED.includes(name));
  check(
    '深色块覆盖了 :root 里每一个颜色变量（漏一个 = 深色底上出现继承来的浅色）',
    missing.length === 0,
    missing.join(', ') || `${rootVars.length} 个变量全部覆盖`,
  );
  check('深色块声明 color-scheme: dark（原生控件跟着变）', /color-scheme:\s*dark/.test(darkBlock));
  check(
    '深色块覆盖了终端底色（否则深色下终端看不出边界）',
    darkVars.has('--terminal-bg'),
  );

  // 语义色的「淡底变体」在浅色块里是浅底深字，深色块里必须是深底浅字 ——
  // 用一个可判定的代理：底色变量的两次取值必须不同（一样就说明忘了翻面）
  const valueOf = (block, name) => (block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`)) ?? [])[1]?.trim();
  const flipped = ['--tint-warn-bg', '--tint-danger-bg', '--tint-info-bg', '--tint-add-bg', '--tint-del-bg'].filter(
    (name) => valueOf(rootBlock, name) === valueOf(darkBlock, name),
  );
  check('语义淡底在深色下整组翻面（不是照抄浅色值）', flipped.length === 0, flipped.join(', ') || 'ok');
  check(
    '正文与背景色都翻面（深色下不能是深字配深底）',
    valueOf(rootBlock, '--text') !== valueOf(darkBlock, '--text') &&
      valueOf(rootBlock, '--bg') !== valueOf(darkBlock, '--bg'),
  );
}

// ══════════════════════════════════════════════════════════
// 4. 渲染层接线（读源码文本：Electron 起不来时也能验）
// ══════════════════════════════════════════════════════════
function wiringSection() {
  console.log('\n── 渲染层接线 ──');

  const hookPath = path.join(repo, 'apps', 'desktop', 'src', 'useTheme.ts');
  check('useTheme hook 存在', fs.existsSync(hookPath));
  const hook = fs.readFileSync(hookPath, 'utf8');
  check('hook 用契约层的 resolveTheme（不自己判系统偏好）', hook.includes('resolveTheme(') && hook.includes('@deepwork/protocol'));
  check('写的是 documentElement 的 data-theme', hook.includes('document.documentElement') && hook.includes('dataset.theme'));
  check('订阅 prefers-color-scheme 变化（跟随系统要跟着变）', hook.includes('prefers-color-scheme') && hook.includes("addEventListener('change'"));

  const app = fs.readFileSync(path.join(repo, 'apps', 'desktop', 'src', 'App.tsx'), 'utf8');
  check('App 调用 useTheme 并喂入 config.theme', app.includes('useTheme(agent.config?.theme)'));

  const panel = fs.readFileSync(path.join(repo, 'apps', 'desktop', 'src', 'components', 'SettingsPanel.tsx'), 'utf8');
  check(
    '设置页的三档切片从契约清单渲染（不写死三个按钮）',
    panel.includes('THEME_MODES.map') && panel.includes('THEME_MODE_LABEL[mode]'),
  );

  const css = fs.readFileSync(path.join(repo, 'apps', 'desktop', 'src', 'styles.css'), 'utf8');
  check('切片有样式', css.includes('.theme-chip'));
}

async function main() {
  await hostSection();
  styleSection();
  wiringSection();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n主题切换测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
