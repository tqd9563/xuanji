/**
 * 提示词库的纯函数:`/p` 查询词、联想面板行的合成、变量解析、钉选与视图过滤。
 *
 * 抽成纯函数是为了可测:面板里「提示词组排在命令前 / 输入字符后扁平混排 / `/p` 只看提示词」
 * 三套行为共用一份排序口径,写在组件里只能靠端到端点一遍才知道对不对。
 */
import type { Prompt } from '@/api/types';
import { filterCmds, type SlashCmd } from './slash';

/** 璇玑拦截的提示词命令名(与 Dispatch.tsx BUILTIN_CMDS 里那条一致) */
export const PROMPT_CMD = 'p';

/** 空 `/` 时「提示词」组最多露出几条;其余靠 `/p` 或继续输入 */
export const SLASH_PROMPT_TOP = 3;

/**
 * `/p` 模式的查询词:`/p ` → ''(列全部)、`/p de` → 'de';其它文本 → null。
 * 与 slashQuery 的分工:后者敲下第一个空格即收面板,这里恰恰是「空格之后」才生效——
 * `/p` 是唯一一条把参数当查询词的命令。
 */
export function promptQuery(text: string): string | null {
  const m = /^\/p\s+(\S*)$/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** 当前工作目录下可见的提示词:全局的 + 作用域正好是这个目录的 */
export function visiblePrompts(all: readonly Prompt[], cwd: string | null | undefined): Prompt[] {
  return all.filter((p) => !p.cwd || p.cwd === cwd);
}

/** 派发页空输入框那一行 chip:钉选的按使用次数取前 max 条 */
export function pinnedChips(all: readonly Prompt[], cwd: string | null | undefined, max: number): Prompt[] {
  return visiblePrompts(all, cwd)
    .filter((p) => p.pinned)
    .sort((a, b) => b.uses - a.uses || a.trig.localeCompare(b.trig))
    .slice(0, max);
}

export type SlashRow =
  | { kind: 'cmd'; cmd: SlashCmd }
  | { kind: 'prompt'; prompt: Prompt }
  /** 分组标题行,不可选中;只在空 `/` 时出现 */
  | { kind: 'grp'; label: string; note: string; hint?: string };

/** 提示词在查询词上的命中层级:触发词前缀 0 > 触发词/名称子串 2;-1 不命中。与 filterCmds 的层级同一量纲 */
function promptTier(p: Prompt, q: string): number {
  if (!q) return 0;
  if (p.trig.startsWith(q)) return 0;
  if (p.trig.includes(q) || p.name.toLowerCase().includes(q)) return 2;
  return -1;
}

function rankPrompts(list: readonly Prompt[], q: string): Prompt[] {
  return list
    .map((p) => ({ p, t: promptTier(p, q) }))
    .filter((x) => x.t >= 0)
    .sort((a, b) => a.t - b.t || b.p.uses - a.p.uses || a.p.trig.localeCompare(b.p.trig))
    .map((x) => x.p);
}

/**
 * 合成联想面板的行。三种态:
 *  - `/p xxx`(promptQ 非 null):只看提示词,扁平;
 *  - 空 `/`:「提示词」组(按次数取前 N)+「命令」组,各带标题行;没有提示词时退化成今天的扁平命令表;
 *  - `/xx`:命令与提示词按命中层级混排,同层按使用次数 —— 不分组,分组标题在打字时只会挡住候选。
 */
export function buildSlashRows(input: {
  slashQ: string | null;
  promptQ: string | null;
  cmds: readonly SlashCmd[];
  prompts: readonly Prompt[];
}): SlashRow[] {
  const { slashQ, promptQ, cmds, prompts } = input;
  if (promptQ !== null) return rankPrompts(prompts, promptQ).map((prompt) => ({ kind: 'prompt', prompt }));
  if (slashQ === null) return [];
  const cmdRows = filterCmds(slashQ, cmds).map((cmd): SlashRow => ({ kind: 'cmd', cmd }));
  if (slashQ === '') {
    const top = rankPrompts(prompts, '').slice(0, SLASH_PROMPT_TOP);
    if (!top.length) return cmdRows;
    return [
      { kind: 'grp', label: '提示词', note: `${prompts.length} 条`, hint: '/p 只看这组' },
      ...top.map((prompt): SlashRow => ({ kind: 'prompt', prompt })),
      { kind: 'grp', label: '命令', note: `${cmdRows.length} 条` },
      ...cmdRows,
    ];
  }
  // 混排:两边各自已按层级+次数排好,这里按层级合并,同层命令在前(命令是用户更熟的老面孔)
  const promptHits = rankPrompts(prompts, slashQ);
  const tierOf = (r: SlashRow): number => {
    if (r.kind === 'prompt') return promptTier(r.prompt, slashQ);
    if (r.kind === 'cmd') {
      const n = r.cmd.name.toLowerCase();
      return n.startsWith(slashQ) ? 0 : 1;
    }
    return 0;
  };
  const usesOf = (r: SlashRow): number => (r.kind === 'prompt' ? r.prompt.uses : r.kind === 'cmd' ? (r.cmd.uses ?? 0) : 0);
  return [...cmdRows, ...promptHits.map((prompt): SlashRow => ({ kind: 'prompt', prompt }))].sort(
    (a, b) => tierOf(a) - tierOf(b) || usesOf(b) - usesOf(a),
  );
}

/** 面板里可选中的行(去掉分组标题) */
export function selectableRows(rows: readonly SlashRow[]): Exclude<SlashRow, { kind: 'grp' }>[] {
  return rows.filter((r): r is Exclude<SlashRow, { kind: 'grp' }> => r.kind !== 'grp');
}

export interface PromptVars {
  cwd?: string;
  branch?: string;
  date?: string;
  clipboard?: string;
}

/** 今天,YYYY-MM-DD(本地时区) */
export function todayStr(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 解析正文变量,返回要写进输入框的文本与光标落点。
 * {{cursor}} 取第一处为光标位、全部移除;其它变量全部替换,缺值替换成空串(不留下 `{{x}}` 字面量进会话)。
 */
export function resolvePromptBody(body: string, vars: PromptVars): { text: string; caret: number } {
  let text = body
    .replace(/\{\{cwd\}\}/g, vars.cwd ?? '')
    .replace(/\{\{branch\}\}/g, vars.branch ?? '')
    .replace(/\{\{date\}\}/g, vars.date ?? todayStr())
    .replace(/\{\{clipboard\}\}/g, vars.clipboard ?? '');
  const i = text.indexOf('{{cursor}}');
  text = text.replace(/\{\{cursor\}\}/g, '');
  return { text, caret: i < 0 ? text.length : i };
}

/** 正文首行(列表 / 面板里的一行预览) */
export function firstLine(body: string): string {
  return body.split('\n').find((l) => l.trim()) ?? '';
}

export type PromptFilter = 'all' | 'pinned' | 'global' | 'project';

/** 管理页的过滤:标签(全部 / 已钉选 / 全局 / 项目专属)+ 搜索(名称 / 触发词 / 正文) */
export function filterPromptsView(all: readonly Prompt[], f: PromptFilter, q: string): Prompt[] {
  const ql = q.trim().toLowerCase();
  return all.filter((p) => {
    if (f === 'pinned' && !p.pinned) return false;
    if (f === 'global' && p.cwd) return false;
    if (f === 'project' && !p.cwd) return false;
    if (ql && !(p.name.toLowerCase().includes(ql) || p.trig.includes(ql) || p.body.toLowerCase().includes(ql))) return false;
    return true;
  });
}

/**
 * 变更广播:管理页钉选/编辑后,派发页的 chip 与面板靠 60s 轮询取数,
 * 不广播的话在管理页钉完切回派发页,chip 要等最长一分钟才出现。
 */
const PROMPTS_CHANGED = 'xuanji:prompts-changed';
export function notifyPromptsChanged() {
  window.dispatchEvent(new CustomEvent(PROMPTS_CHANGED));
}
export function onPromptsChanged(fn: () => void): () => void {
  window.addEventListener(PROMPTS_CHANGED, fn);
  return () => window.removeEventListener(PROMPTS_CHANGED, fn);
}
