/**
 * 派发页工作目录的解析:一处定「用哪个目录」与「是不是快速提问态」。
 *
 * 抽成纯函数不是为了复用(只有派发页用),是为了可测:优先级链有四级、
 * 快速提问态又从结果反推,写在组件里就只能靠端到端点一遍才知道对不对。
 */
export interface CwdResolution {
  /** 候选列表:快速提问目录未必在 ~/.claude/projects 下,需并入并置顶 */
  options: string[];
  /** 本次派发实际使用的目录 */
  effectiveCwd: string;
  /** 快速提问态 = 当前目录就是快速提问目录 */
  isQuickAsk: boolean;
}

export function resolveCwd(input: {
  /** 用户在派发页显式选的目录;空串 = 未选 */
  cwd: string;
  /** 设置里的「默认工作目录」;空串 = 未设 */
  prefCwd: string;
  /** 设置里的「快速提问目录」;空串 = 关闭该默认 */
  quickAskCwd: string;
  /** ~/.claude/projects 扫描出的项目路径 */
  projectPaths: string[];
}): CwdResolution {
  const { cwd, prefCwd, quickAskCwd, projectPaths } = input;
  const options =
    quickAskCwd && !projectPaths.includes(quickAskCwd) ? [quickAskCwd, ...projectPaths] : projectPaths;
  // 默认目录可能已从 ~/.claude/projects 消失,故要校验它仍在候选里
  const validPref = prefCwd && options.includes(prefCwd) ? prefCwd : '';
  const effectiveCwd = cwd || validPref || quickAskCwd || options[0] || '';
  return {
    options,
    effectiveCwd,
    // 只从路径派生,不另存一个模式状态:两处状态会漂移,而「在哪个目录」本就是唯一事实
    isQuickAsk: !!quickAskCwd && effectiveCwd === quickAskCwd,
  };
}
