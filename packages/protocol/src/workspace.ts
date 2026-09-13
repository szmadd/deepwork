/**
 * 工作区视图模型。
 *
 * 为什么要有它：Agent 修改的是**用户自己的目录**，而此前界面上唯一能看见这个目录的地方
 * 是顶部那行路径。用户要判断「这次改动是不是越界了」，至少得能看见边界里有什么。
 *
 * 两条刻意的约束：
 *  1. **树是视图，不是权限。** 这里列出的内容不等于 Agent 被允许访问的内容；
 *     真正的边界判定在 core-host 的 isInsideWorkspace() 与 Guard 上，UI 不重复实现规则。
 *  2. **忽略名单要如实回报。** `node_modules/`、`.git/` 被跳过不是「不存在」，
 *     把它们沉默地藏掉，用户会得到一份看起来完整、实际残缺的目录认知。
 *     因此 ignored / truncated 是这份契约的一部分，界面必须把「这里不是全量」说出来。
 */

export interface WorkspaceNode {
  /** 末级名称 */
  name: string;
  /** 相对工作区根的路径，统一 / 分隔（根为 ''） */
  path: string;
  type: 'file' | 'dir';
  /** 字节数，目录为空 */
  size?: number;
  /** 子节点（目录才有；未展开或超限时为空数组） */
  children?: WorkspaceNode[];
  /** 因深度上限未继续展开 */
  deep?: boolean;
}

export interface WorkspaceTree {
  /** 工作区绝对路径 */
  root: string;
  /** 相对于 root 的起始路径，'/' 表示根 */
  base: string;
  nodes: WorkspaceNode[];
  /** 被跳过的目录名（如实回报，见文件头说明） */
  ignored: string[];
  /** 因条目数上限被截断 */
  truncated: boolean;
  /** 本次实际返回的条目总数 */
  count: number;
}

export interface FilePreview {
  /** 相对工作区的路径，/ 分隔 */
  path: string;
  /** 文件不存在（区别于「存在但为空」） */
  missing: boolean;
  binary: boolean;
  size: number;
  /** 文本内容；二进制或缺失时为空串 */
  text: string;
  /** 因体积上限被截断 */
  truncated: boolean;
}
