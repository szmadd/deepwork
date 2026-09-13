'use strict';

/**
 * 用系统里真实的办公软件打开一个文档，并截屏留证。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * M2-I 的验收判据是「写出来的文件**必须能被真实 Office / WPS 打开**」——
 * 这是验收动作，不是选项。结构断言（zip 部件齐全、XML 良构）能证明包是好的，
 * 但证明不了「Office 认它」：格式符合性里有一堆只存在于实现里的隐含要求
 * （缺一个 fill、关系类型少一段路径就报「文件已损坏」）。唯一的判据是打开它。
 *
 * ── 为什么用 Electron 而不是 PowerShell 截屏 ────────────────────
 * 项目里已经有 Electron（壳层本体），它的 desktopCapturer 不需要任何原生模块；
 * 而 PowerShell 的 GDI 截屏要动态编译 C#，在这个环境里既慢又容易被安全策略拦。
 * 不创建 BrowserWindow 是关键：没有窗口，屏幕上是干净的 WPS，
 * Electron 自己不会挡住证据。
 *
 * 用法：
 *   electron tools/open-with-office.js <文档路径> <输出 png> [等待秒数]
 *
 * 找不到 WPS / Office 时**明确报错并退出 1**，绝不产出「打开了空白桌面」的截图 ——
 * 一张看起来正常的图会把「没验证」伪装成「验证过了」。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { app, desktopCapturer, screen } = require('electron');

const args = process.argv.slice(2);
const target = args[0];
const out = args[1];
const waitSeconds = Number(args[2] || 14);

if (!target || !out) {
  console.error('用法：electron tools/open-with-office.js <文档路径> <输出 png> [等待秒数]');
  process.exit(2);
}

/** 按扩展名挑打开它的那个程序：Word / Excel / PPT 是三个不同的可执行文件 */
function openerFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') return 'et.exe';
  if (ext === '.pptx' || ext === '.ppt') return 'wpp.exe';
  return 'wps.exe';
}

/**
 * 找 WPS 的安装位置。
 *
 * WPS 是**按版本号分目录**安装的（.../WPS Office/<版本>/office6/wps.exe），
 * 所以不能硬编码一个版本；取版本号最大的那个（字符串比较对 12.1.0.28043 > 12.1.0.26375 成立）。
 */
function findWps(exe) {
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Kingsoft', 'WPS Office'),
    'C:\\Program Files\\WPS Office',
    'C:\\Program Files (x86)\\WPS Office',
  ].filter((root) => root && fs.existsSync(root));

  const found = [];
  for (const root of roots) {
    for (const version of fs.readdirSync(root)) {
      const candidate = path.join(root, version, 'office6', exe);
      if (fs.existsSync(candidate)) found.push({ candidate, version });
    }
  }
  found.sort((a, b) => a.version.localeCompare(b.version, 'en', { numeric: true }));
  return found.length ? found[found.length - 1].candidate : null;
}

/**
 * 截图。
 *
 * 抓**标题里含该文档名的窗口**，而不是抓整屏。原因是实测踩到的：
 * 整屏截图拿到的是「此刻最靠前的窗口」，而启动外部程序时前台并不受我们控制
 * （第一次跑 docx 恰好是 WPS 在最前，第二次跑 xlsx 截到的却是另一个应用的窗口）。
 * 那种失败的形态特别坏：截图成功、日志全绿，只有图上是别人家的界面 ——
 * 一张「看起来正常」的图会把「没验证」伪装成「验证过了」。
 *
 * 找不到匹配窗口时按 3 秒一次重试若干轮（WPS 冷启动可能要十几秒），
 * 全部失败才退到整屏，并在日志里说明退化了。
 */
async function captureDocumentWindow(baseName, out) {
  const display = screen.getPrimaryDisplay();
  const size = { width: display.size.width, height: display.size.height };
  const wanted = baseName.toLowerCase();

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const windows = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size });
    const match = windows.find((source) => source.name.toLowerCase().includes(wanted));

    if (match) {
      // 只截**这一个窗口**，不截整屏。
      // 试过「文档窗口在最前时改截整屏」，理由是信息量更大（带任务栏、更像真实桌面），
      // 实测反而更差：WPS 的窗口不一定最大化，整屏图里它只占中间一小块，
      // 周围全是无关应用的界面 —— 噪声多了，作为证据反而更难读。
      // 而且那条路要依赖「Electron 按 z 序返回窗口源」这个没写进文档的假设。
      fs.writeFileSync(out, match.thumbnail.toPNG());
      return { mode: 'window', detail: match.name };
    }

    console.log(
      `[office] 第 ${attempt} 轮没找到标题含「${baseName}」的窗口；可见窗口：` +
        windows.map((item) => item.name).slice(0, 6).join(' / '),
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  if (!screens.length) throw new Error('desktopCapturer 没有返回任何屏幕源');
  fs.writeFileSync(out, screens[0].thumbnail.toPNG());
  return { mode: 'screen', detail: `${display.size.width}×${display.size.height}（未找到文档窗口，已退化）` };
}

async function main() {
  if (!fs.existsSync(target)) throw new Error(`文档不存在：${target}`);

  const exe = findWps(openerFor(target));
  if (!exe) throw new Error(`没找到能打开 ${path.basename(target)} 的 WPS/Office，无法完成「真实软件打开」这条验收`);

  console.log(`[office] 使用 ${exe}`);
  const child = spawn(exe, [target], { stdio: 'ignore', windowsHide: false });
  console.log(`[office] 已启动 pid=${child.pid}，等待 ${waitSeconds}s 让它把文档渲染出来`);

  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

  const baseName = path.basename(target);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const shot = await captureDocumentWindow(baseName, out);
  const size = fs.statSync(out).size;
  console.log(
    `[office] 已截图 ${out}（${size} B，来源=${shot.mode}${shot.mode === 'window' ? ` · 窗口「${shot.detail}」` : ` · ${shot.detail}`}）`,
  );

  // 收尾：整棵进程树都杀掉。WPS 会拉起一堆子进程（渲染 / 输入法 / 云同步），
  // 只杀主进程会留下一堆后台残留，下次跑的时候互相干扰
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  console.log('[office] 已收净 WPS 进程树');
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(`[office] ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  });
