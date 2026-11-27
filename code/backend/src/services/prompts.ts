/**
 * 提示词库:校验与规则。数据在自有 SQLite(storage/db.ts promptsTable),~/.claude 不涉及。
 *
 * 规则集中在这里而不是路由里,是为了可测:触发词格式、钉选上限、作用域取值
 * 三条规则任何一条写错,用户的感受都是「保存了但面板里不对」,靠端到端很难定位。
 */
import type { Prompt } from '../types.js';

/** 钉选上限:派发页空输入框那一行 chip 放得下的条数(多了会折行,第二行就没人看了) */
export const PIN_MAX = 4;

/** 触发词:小写字母开头,字母/数字/短横线;`/p <trig>` 要能一口气敲出来 */
export const TRIG_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** 正文里可用的变量,前端插入时解析;这份表只用于校验提示「拼错的变量」 */
export const PROMPT_VARS = ['cursor', 'cwd', 'branch', 'date', 'clipboard'] as const;

export interface PromptInput {
  trig: string;
  name: string;
  body: string;
  cwd: string | null;
  pinned: boolean;
}

/**
 * 把请求体整理成合法输入;不合法返回 { error }。
 * 部分更新时 base 传现有记录,缺省字段沿用旧值;新建时 base 为空,三个必填项都要有。
 */
export function normalizePrompt(
  body: Record<string, unknown>,
  base?: Prompt,
): { ok: PromptInput } | { error: string } {
  const pick = <T>(k: keyof PromptInput, fallback: T): unknown => (body[k] === undefined ? fallback : body[k]);
  const trigRaw = pick('trig', base?.trig ?? '');
  const nameRaw = pick('name', base?.name ?? '');
  const bodyRaw = pick('body', base?.body ?? '');
  const cwdRaw = pick('cwd', base?.cwd ?? null);
  const pinnedRaw = pick('pinned', base?.pinned ?? false);

  if (typeof trigRaw !== 'string' || typeof nameRaw !== 'string' || typeof bodyRaw !== 'string') {
    return { error: 'trig / name / body 需为字符串' };
  }
  const trig = trigRaw.trim().toLowerCase();
  const name = nameRaw.trim();
  const text = bodyRaw.replace(/\r\n/g, '\n');
  if (!TRIG_RE.test(trig)) return { error: '触发词只能是小写字母开头的字母、数字、短横线(≤32 字符)' };
  if (!name) return { error: '名称不能为空' };
  if (name.length > 40) return { error: '名称最长 40 字符' };
  if (!text.trim()) return { error: '正文不能为空' };
  if (text.length > 20_000) return { error: '正文最长 20000 字符' };
  const unknownVar = [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).find((v) => !(PROMPT_VARS as readonly string[]).includes(v));
  if (unknownVar) return { error: `未知变量 {{${unknownVar}}};可用:${PROMPT_VARS.map((v) => `{{${v}}}`).join(' ')}` };
  if (cwdRaw !== null && (typeof cwdRaw !== 'string' || !cwdRaw.startsWith('/'))) {
    return { error: 'cwd 需为绝对路径或 null(全局)' };
  }
  if (typeof pinnedRaw !== 'boolean') return { error: 'pinned 需为布尔值' };
  return { ok: { trig, name, body: text, cwd: cwdRaw === null ? null : cwdRaw.replace(/\/+$/, '') || '/', pinned: pinnedRaw } };
}

/**
 * 钉选是否超限:新钉一条时,已钉选的(不含自己)必须少于上限。
 * 取消钉选 / 不改钉选状态永远放行 —— 上限只拦「再加一条」,不拦「改别的字段」。
 */
export function pinOverLimit(all: readonly Prompt[], next: PromptInput, selfId?: number): boolean {
  if (!next.pinned) return false;
  const others = all.filter((p) => p.pinned && p.id !== selfId).length;
  return others >= PIN_MAX;
}

/** 触发词是否被别的记录占用 */
export function trigTaken(all: readonly Prompt[], trig: string, selfId?: number): Prompt | null {
  return all.find((p) => p.trig === trig && p.id !== selfId) ?? null;
}
