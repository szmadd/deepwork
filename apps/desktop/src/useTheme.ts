/**
 * 主题落地：把 `config.theme` 解析成实际方案，写到根元素上。
 *
 * ── 为什么是一个 hook 而不是散在 App 里的 useEffect ──────────────────
 * 「跟随系统」需要订阅 `prefers-color-scheme` 的**变化**（用户在系统里切了，
 * 应用里的档位没变，但渲染要跟着变）。这个订阅有生命周期（挂载时同步一次、
 * 卸载时取消），塞进 App 的某个 effect 里会让 App 同时管两件事。
 *
 * ── 为什么解析不在渲染层 ──────────────────────────────────────────
 * 档位 → 方案的映射（`resolveTheme`）住在契约层。渲染层只负责把结果写成
 * 一个属性、并订阅系统偏好。判断写两份的后果是「设置页写着跟随系统，
 * 某个窗口却永远浅色」，而这类 bug 只在特定系统设置下才出现。
 *
 * ── 为什么属性挂在 documentElement 而不是 body ────────────────────
 * 原生控件（select 下拉、滚动条、日期选择器）读根元素的 `color-scheme`。
 * 只改 body，深色主题下会点开一个白底的下拉列表。
 */

import { useEffect, useState } from 'react';
import { resolveTheme, type ThemeMode } from '@deepwork/protocol';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * 读系统偏好。
 *
 * 没有 matchMedia 的环境（无头测试、未来的 Node 侧预览）一律按浅色：
 * 与其猜一个，不如落到**与默认档位一致**的那一个 —— 这样「读不到系统偏好」
 * 不会表现为「界面莫名变深色」。
 */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

export function useTheme(mode: ThemeMode | undefined): void {
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setPrefersDark(event.matches);
    query.addEventListener('change', onChange);
    // 订阅前先同步一次：只靠 change 事件会漏掉「hook 挂载前系统已经切过」的那种状态，
    // 而那个状态会一直错到用户下次去动系统设置为止。
    setPrefersDark(query.matches);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    // config 未就绪时按浅色渲染（与默认档位一致）：闪一下总比先深后浅好
    const resolved = resolveTheme(mode ?? 'light', prefersDark);
    const root = document.documentElement;
    root.dataset.theme = resolved;
    // color-scheme 同时写在样式里（styles.css 的 dark 块）与这里：
    // 样式里那份管「浏览器支持的控件」，这里这份管「属性刚被移除又设回来的瞬间」
    root.style.colorScheme = resolved;
  }, [mode, prefersDark]);
}
