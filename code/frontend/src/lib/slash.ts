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
export type SlashCmdInfo = { name: string; desc: string; arg: string };

export type SlashCmd = {
  /** 命令名,不含前导斜杠;插件技能是 `plugin:skill` 形式 */
  name: string;
  /** 一句话说明,列表右侧显示 */
  desc: string;
  /** 参数提示(如 `<video-url-or-path> [question]`),无参数为空串 */
  arg: string;
  kind: 'builtin' | 'skill';
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
 * 补全时真正写进输入框的名字:短名在全表里唯一就用短名(`/watch` 而非 `/watch:watch`,
 * 与用户在终端里的手感一致,实测 CLI 认),短名有歧义则退回全名以免补出一个错命令。
 */
export function completionName(name: string, all: readonly SlashCmd[]): string {
  const s = shortName(name);
  if (s === name) return name;
  const clash = all.filter((c) => shortName(c.name) === s).length;
  return clash > 1 ? name : s;
}

/**
 * 过滤 + 排序。前缀命中优先于短名前缀,短名前缀优先于子串;同层保持原顺序(后端已按名排好)。
 * 不做子序列匹配 —— 命令名是用户敲得出的短标识,子序列只会把无关项拉进来(与 fuzzy.ts
 * 面向路径/中文会话名的宽松口径不同,那里搜不到的代价更大)。
 */
export function filterCmds(q: string, list: readonly SlashCmd[]): SlashCmd[] {
  if (!q) return [...list];
  const rank = (c: SlashCmd): number => {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (shortName(n).startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    return -1;
  };
  return list
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
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
