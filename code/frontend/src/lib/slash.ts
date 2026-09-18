/**
 * 斜杠命令联想:把「输入框里的一段文本」映射成「候选列表 / 命中的命令词」的纯函数。
 *
 * 两类命令合成一份候选:
 *  - Commands: 璇玑自己拦截的命令(/clear /rename …),不发给 CLI,行为定义在 Dispatch.tsx;
 *  - Skills:   本会话 SDK 报告的技能,原样发给 CLI 由它展开(实测 `/watch` 会加载插件技能、
 *              未知命令 CLI 本地回 "Unknown command" 不烧模型轮次)。
 * 同名以璇玑内置为准(如 /wrapup 走自家收口提示词,不走 CLI 的技能)。
 */

/** 后端 commands 事件 / GET /slash-commands 交出的原始条目(与 backend services/slash-commands.ts 同形) */
export type SlashCmdInfo = {
  name: string;
  desc: string;
  arg: string;
  /** SDK 报告的别名(如 watch:watch 的 'watch');补全优先用它,比自己推断短名可靠 */
  aliases?: string[];
  /** 历史使用次数(后端统计),排序用;没用过为 0 */
  uses?: number;
};

export type SlashCmd = {
  /** 命令名,不含前导斜杠;插件技能是 `plugin:skill` 形式 */
  name: string;
  /** 一句话说明,列表右侧显示 */
  desc: string;
  /** 参数提示(如 `<video-url-or-path> [question]`),无参数为空串 */
  arg: string;
  kind: 'builtin' | 'skill';
  aliases?: string[];
  /** 历史使用次数,排序用 */
  uses?: number;
};

/**
 * 输入框文本里正在联想的查询词。仅当整段文本形如「/xxx」(以斜杠开头、尚未出现任何空白)
 * 时返回 xxx,否则 null —— 敲下第一个空格即视为「命令已选定、正在写参数」,面板收起。
 */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** 命令名的短名:插件技能 `plugin:skill` 取冒号后一段,其余原样 */
export function shortName(name: string): string {
  const i = name.lastIndexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/**
 * 补全时真正写进输入框的名字。优先用 SDK 自己报告的别名(`watch:watch` 带 `aliases:['watch']`),
 * 这是 CLI 的权威说法,比从名字里推断短名可靠;有多个别名取最短的,与终端手感一致。
 * 没有别名就用全名 —— 宁可补得长一点,也不补出一个 CLI 不认识的名字。
 */
export function completionName(cmd: Pick<SlashCmd, 'name' | 'aliases'>): string {
  const alias = (cmd.aliases ?? []).filter((a) => a).sort((a, b) => a.length - b.length)[0];
  return alias ?? cmd.name;
}

/**
 * 过滤 + 排序。两级判据:
 *  ① 命中层级 —— 全名前缀 > 短名前缀 > 子串。敲 `/ba` 时 `/baize` 一定排在 `/x:baize` 前面,
 *     不让一个高频的子串命中盖过前缀命中(那会让人「明明打对了却要往下翻」)。
 *  ② 同层按使用频率降序,再按字母。空查询(只敲了 `/`)时只剩这一级 —— 常用的浮在最上面。
 *
 * 不做子序列匹配 —— 命令名是用户敲得出的短标识,子序列只会把无关项拉进来(与 fuzzy.ts
 * 面向路径/中文会话名的宽松口径不同,那里搜不到的代价更大)。
 */
export function filterCmds(q: string, list: readonly SlashCmd[]): SlashCmd[] {
  const tier = (c: SlashCmd): number => {
    if (!q) return 0;
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (shortName(n).startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    return -1;
  };
  return list
    .map((c) => ({ c, t: tier(c) }))
    .filter((x) => x.t >= 0)
    .sort((a, b) => a.t - b.t || (b.c.uses ?? 0) - (a.c.uses ?? 0) || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
}

/**
 * 把「已完整命中某个命令」的文本切成命令词与其余部分,供输入框镜像层给命令词单独上色;
 * 未命中返回 null。命中要求命令名后是结尾或空白 —— `/baizex` 不算命中 `/baize`。
 */
export function splitCommand(text: string, names: ReadonlySet<string>): { cmd: string; rest: string } | null {
  const m = /^\/(\S+)([\s\S]*)$/.exec(text);
  if (!m) return null;
  const [, name, rest] = m as unknown as [string, string, string];
  if (!names.has(name)) return null;
  if (rest !== '' && !/^\s/.test(rest)) return null;
  return { cmd: `/${name}`, rest };
}

/** 名称在查询词上的连续命中切分,用于候选行把已输入的前缀加粗(CLI 同款,不画下划线) */
export function nameParts(name: string, q: string): { before: string; hit: string; after: string } {
  if (!q) return { before: name, hit: '', after: '' };
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return { before: name, hit: '', after: '' };
  return { before: name.slice(0, i), hit: name.slice(i, i + q.length), after: name.slice(i + q.length) };
}
