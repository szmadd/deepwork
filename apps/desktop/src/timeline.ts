/**
 * 归约逻辑现在住在契约层（`@deepwork/protocol` 的 `reduce.ts`）。
 *
 * 保留本文件是为了两件事：
 *  1. 界面的 import 路径不必跟着改；
 *  2. 明确留下「这里曾经有一份实现」的痕迹 —— 归约只允许存在一份，
 *     一旦在本层重新长出第二套实现，回放与实时渲染就会悄悄分叉。
 */

export {
  applyEvent,
  buildTimeline,
  EMPTY_TIMELINE,
  runBoundaries,
  sumUsage,
} from '@deepwork/protocol';

export type { TimelineItem } from '@deepwork/protocol';
