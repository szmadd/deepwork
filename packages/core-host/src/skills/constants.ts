/**
 * 技能目录布局里的固定名字。
 *
 * 单独成文件是为了避免循环依赖：`store.ts`（安装/清单）与 `fetch.ts`
 * （来源拉取→本地目录）都要知道「技能根下那个文件叫什么」，
 * 而 fetch 若从 store 里取，就会形成 store → fetch → store 的环。
 */

/** 技能清单文件名：每个技能目录根下必须有它 */
export const SKILL_MD = 'SKILL.md';
