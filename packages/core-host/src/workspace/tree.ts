import fs from 'node:fs';
import path from 'node:path';
import type { FilePreview, WorkspaceNode, WorkspaceTree } from '@deepwork/protocol';
import { looksBinary } from '../diff';

/**
 * 工作区只读视图：文件树与文件预览。
 *
 * 这一层只读，是整个模块最重要的性质：界面上的「看一眼」永远不可能改变磁盘状态。
 * 因此这里没有、也不应该有任何写入口 —— 写操作只有一条路，就是经过 Guard 与审批的写工具。
 *
 * 另一条纪律：**忽略与截断必须如实回报。**
 * node_modules / .git 被跳过不代表不存在；条目数超限也不代表就这么多。
 * 把这些沉默地吞掉，用户会拿一份看起来完整、实则残缺的目录认知去判断「Agent 改动有没有越界」。
 */

/** 展示时跳过的目录名。与 shell 工具一致，避免两处各有一份忽略规则 */
export const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.deepwork'];

/** 单次返回的条目上限，超出即截断并回报 */
const MAX_NODES = 3000;
/** 预览读取上限 */
const MAX_PREVIEW_BYTES = 300_000;

export interface TreeOptions {
  /** 相对工作区根的起始路径，默认 ''（根） */
  base?: string;
  /** 展开深度 */
  depth?: number;
  maxNodes?: number;
}

/** 校验目标在工作区内并向内规范化；越界抛错 */
function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel || '.');
  const relative = path.relative(path.resolve(root), abs);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`路径越出工作区边界: ${rel}`);
  }
  return abs;
}

function toDisplay(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export function buildTree(root: string, options: TreeOptions = {}): WorkspaceTree {
  const depthLimit = Math.max(0, Math.min(options.depth ?? 3, 8));
  const maxNodes = options.maxNodes ?? MAX_NODES;
  const base = options.base ?? '';
  const start = resolveInside(root, base);

  const state = { count: 0, truncated: false };

  const walk = (dir: string, remaining: number): WorkspaceNode[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 权限不足或路径消失：当作空目录，而不是让整个树请求失败
      return [];
    }

    const nodes: WorkspaceNode[] = [];
    // 目录在前、同类按名称排序 —— 顺序稳定，避免每次刷新树都在跳
    const sorted = [...entries].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });

    for (const entry of sorted) {
      if (state.count >= maxNodes) {
        state.truncated = true;
        break;
      }
      if (entry.isDirectory() && IGNORED_DIRS.includes(entry.name)) continue;

      const abs = path.join(dir, entry.name);
      const rel = toDisplay(root, abs);
      state.count += 1;

      if (entry.isDirectory()) {
        const deeper = remaining > 0;
        nodes.push({
          name: entry.name,
          path: rel,
          type: 'dir',
          // 深度用尽时给空数组并标记 deep，界面据此显示「未展开」而不是「空目录」
          children: deeper ? walk(abs, remaining - 1) : [],
          deep: !deeper,
        });
      } else {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          size = 0;
        }
        nodes.push({ name: entry.name, path: rel, type: 'file', size });
      }
    }
    return nodes;
  };

  const nodes = walk(start, depthLimit);

  return {
    root: path.resolve(root),
    base: base || '/',
    nodes,
    ignored: [...IGNORED_DIRS],
    truncated: state.truncated,
    count: state.count,
  };
}

/**
 * 读取文件预览。
 *
 * 「不存在」与「存在但读不出」必须分开表示 —— 都返回空文本的话，
 * 界面会把一份读不到的文件显示成空文件，用户据此判断 Agent 改了什么就会得出相反结论。
 */
export function readPreview(root: string, rel: string): FilePreview {
  const abs = resolveInside(root, rel);
  const display = toDisplay(root, abs) || rel;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { path: display, missing: true, binary: false, size: 0, text: '', truncated: false };
  }

  if (stat.isDirectory()) {
    return {
      path: display,
      missing: false,
      binary: false,
      size: 0,
      text: '（这是一个目录）',
      truncated: false,
    };
  }

  if (stat.size > MAX_PREVIEW_BYTES) {
    return {
      path: display,
      missing: false,
      binary: false,
      size: stat.size,
      text: '',
      truncated: true,
    };
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(abs);
  } catch (error) {
    return {
      path: display,
      missing: false,
      binary: false,
      size: stat.size,
      text: `（读取失败：${error instanceof Error ? error.message : String(error)}）`,
      truncated: false,
    };
  }

  const text = buffer.toString('utf8');
  if (looksBinary(text)) {
    return { path: display, missing: false, binary: true, size: stat.size, text: '', truncated: false };
  }

  return {
    path: display,
    missing: false,
    binary: false,
    size: stat.size,
    // 原样返回，不做行尾规范化：预览的用途正是「看到文件本来的样子」
    text,
    truncated: false,
  };
}
