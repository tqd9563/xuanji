/**
 * 斜杠命令目录:把 SDK 报告的命令列表整理成「派发输入框联想面板能用的候选」。
 *
 * 数据只来自 Agent SDK 的 `query.supportedCommands()`(结构完整:名称/描述/参数提示),
 * 不去翻 ~/.claude/skills 磁盘目录 —— 会话里真正能用的是 CLI 认的那份,两者会因
 * settingSources / 插件 / 子目录动态发现而不一致,以 CLI 为准才不会补出一个用不了的命令。
 */

/** 面板候选项(与前端 lib/slash.ts 的 SlashCmd 同形) */
export type SlashCmdInfo = {
  name: string;
  desc: string;
  arg: string;
  /** SDK 报告的别名(如 watch:watch 的 'watch'),补全优先用最短的那个 */
  aliases?: string[];
  /** 历史使用次数,联想面板据此排序;没用过为 0 */
  uses?: number;
};

/**
 * 不进联想面板的 CLI 命令。三类:
 *  ① 内部/服务端投递专用,用户手敲无意义;② 已移除或改名的历史入口;
 *  ③ UX 绑死在本地终端(SDK 的 init 另有 terminal_slash_commands 字段报告这类,
 *     但实测只有 color/doctor/reload-plugins 三条,盖不住下面这些,故显式补齐)。
 * 只做减法且宁可少减:漏掉一条的代价是面板里多一行,误删一条的代价是用户找不到能用的命令。
 */
import { applyUsage, countSlashUsage, type UsageCounts } from './slash-usage.js';
import type { Storage } from '../storage/db.js';

const HIDDEN = new Set([
  '__remote-workflow',
  'workflow-launch-exec',
  'auto-mode-setup',
  'agents',
  'extra-usage',
  'import',
  'heapdump',
  'statusline',
  'design-consent',
  'design-revoke',
]);

/** SDK SlashCommand 的最小形状(只取用得上的字段,免得跟着 SDK 类型演进走) */
type RawCommand = { name?: unknown; description?: unknown; argumentHint?: unknown; aliases?: unknown };

/**
 * 整理:剔除隐藏项与本会话报告的终端专属项,压平成候选并按名称排序。
 * 描述压成单行 —— 技能描述常带换行与大段触发词,面板里只显示一行。
 */
export function buildSlashCatalog(raw: readonly RawCommand[], terminalOnly: readonly string[] = []): SlashCmdInfo[] {
  const term = new Set(terminalOnly);
  const out: SlashCmdInfo[] = [];
  for (const c of raw) {
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name || HIDDEN.has(name) || term.has(name)) continue;
    const aliases = Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === 'string' && !!a) : [];
    out.push({
      name,
      desc: typeof c.description === 'string' ? c.description.replace(/\s+/g, ' ').trim() : '',
      arg: typeof c.argumentHint === 'string' ? c.argumentHint.trim() : '',
      ...(aliases.length ? { aliases } : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * 使用频率缓存。统计要扫全机会话 jsonl,代价不小,而频率是慢变量 ——
 * 同一进程里每 10 分钟重算一次足够,期间新建的会话直接复用上一次的排序。
 */
let usageCache: { at: number; counts: UsageCounts } | null = null;
const USAGE_TTL_MS = 10 * 60 * 1000;
/** 正在跑的那次刷新:并发调用共享,绝不同时起两次全机扫描 */
let usageRefreshing: Promise<void> | null = null;

/**
 * 璇玑自己拦截的命令名(前端 Dispatch.tsx 的 BUILTIN_CMDS)。这里只用于两件事:
 *  ① 统计时把它们认成命令,否则派发库里的 `/btw 问题` 会被当成文件路径滤掉;
 *  ② 频率随事件一起下发,让前端给自己那份写死的内置表也贴上次数。
 * 多一个少一个只影响排序,不影响功能,所以不做跨包的一致性守卫。
 */
const XUANJI_BUILTIN = ['btw', 'clear', 'effort', 'model', 'rename', 'resume', 'wd', 'wrapup'];

/** 给一批目录条目贴上使用次数,并交出完整频率表(前端的内置命令表也要按它排序);
 *  统计失败时退化成全 0(面板按字母序,不影响可用性) */
export async function withUsage(
  storage: Storage,
  cmds: SlashCmdInfo[],
): Promise<{ cmds: SlashCmdInfo[]; uses: UsageCounts }> {
  const now = Date.now();
  const stale = !usageCache || now - usageCache.at >= USAGE_TTL_MS;
  if (stale && !usageRefreshing) {
    const known = new Set([...cmds.map((c) => c.name), ...XUANJI_BUILTIN]);
    usageRefreshing = countSlashUsage(storage, known)
      .catch(() => ({}) as UsageCounts)
      .then((counts) => {
        usageCache = { at: Date.now(), counts };
      })
      .finally(() => {
        usageRefreshing = null;
      });
  }
  // 有旧值就先用旧值、后台刷新(stale-while-revalidate):频率只影响联想排序,晚 10 分钟无所谓,
  // 但让打开会话的请求去等一次全机扫描不行。只有进程里还从没算过时才等这一次。
  if (!usageCache && usageRefreshing) await usageRefreshing;
  const counts = usageCache?.counts ?? {};
  return { cmds: applyUsage(cmds, counts), uses: counts };
}

/**
 * 最近一次从某个会话拿到的目录。新会话在 SDK 建立前没有自己的列表,派发页开着就要能弹面板,
 * 故留一份进程内兜底 —— 技能列表跨会话基本不变,拿旧的比什么都不给强;真列表一到就整份替换。
 * 不做 TTL:过期与否由「本会话是否已报告」决定,时间在这里没有意义。
 */
let lastCatalog: SlashCmdInfo[] = [];

export function rememberSlashCatalog(cmds: SlashCmdInfo[]): void {
  if (cmds.length) lastCatalog = cmds;
}

/** 兜底目录;`fresh` 为 false 表示这是别的会话留下的缓存,调用方可据此提示 */
export function cachedSlashCatalog(): { cmds: SlashCmdInfo[]; fresh: boolean } {
  return { cmds: lastCatalog, fresh: false };
}
