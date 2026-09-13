'use strict';

/**
 * 浏览器截图的场景预置。
 *
 * 为什么要真跑一遍而不是摆一份 endpoint 文件：面板上的「运行中 / 当前页 / 截图」
 * 三项全部来自宿主对**真实进程**的观察。摆一份假文件只能证明「面板会渲染我塞的数据」，
 * 证明不了「拉起浏览器、导航、截图、收尾」这条链是通的 —— 而那条链才是这一章的内容。
 *
 * 预置结束后会 shutdown（杀掉浏览器进程树并删端点文件），于是场景里的画面
 * 由渲染层自己再点一次「打开」产生 —— 走的是用户真实的操作路径（地址栏输入 → 打开），
 * 而不是脚本替用户摆好状态。
 *
 * 用法： node tools/fixtures/seed-browser.js <页面绝对路径（原生 D:/ 形式）>
 */

const path = require('node:path');
const { BrowserManager } = require('../../packages/core-host/dist/browser/manager');

const pagePath = process.argv[2];
if (!pagePath) {
  console.error('缺少页面路径参数');
  process.exit(1);
}

// 原生 Windows 路径 → file URL。盘符前那一个斜杠是必须的：
// `file:///D:/a/b.html` 其中第三个斜杠属于 URL 语法，缺了它宿主会当成主机名 D。
const url = `file:///${pagePath.replace(/\\/g, '/')}`;

(async () => {
  const manager = new BrowserManager();

  await manager.run('navigate', { url });
  await manager.run('screenshot', { name: 'demo-page.png' });

  // 再走一遍「输入 → 执行」：截图上要看得见这个动作真的改到了页面内容，
  // 否则两张图长得一模一样，等于只有一张
  await manager.run('type', { selector: '#q', text: '深边AI Work' });
  await manager.run('click', { selector: '#go' });
  await manager.run('screenshot', { name: 'demo-typed.png' });

  const state = manager.state();
  await manager.shutdown();
  console.log(`浏览器场景预置完成：pid=${state.pid} 截图=${state.shotCount} 张`);
})().catch((error) => {
  console.error('浏览器场景预置失败：', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
