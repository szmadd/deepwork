/**
 * @deepwork/protocol —— UI / 壳层 / 内核 三方共享的唯一类型来源。
 *
 * 任何一方需要新增能力，都先改这里，再改实现。禁止在实现里私自扩展事件形状。
 */

export * from './browser';
export * from './chart';
export * from './config';
export * from './diff';
export * from './events';
export * from './memory';
export * from './mcp';
export * from './office';
export * from './reduce';
export * from './rpc';
export * from './schedule';
export * from './security';
export * from './session';
export * from './skills';
export * from './terminal';
export * from './usage';
export * from './workspace';

/** 运行时数据根目录名（位于用户主目录下） */
export const DATA_DIR_NAME = '.deepwork';

export const APP_NAME = '深边AI Work';
export const APP_ID = 'com.deepwork.desktop';
