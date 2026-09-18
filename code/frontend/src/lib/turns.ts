/**
 * 轮次索引 —— 派发页「往回翻某一轮」的共用数据层。
 *
 * 一轮 = 一条用户输入,以及它之后到下一条用户输入之间的全部产出。吸顶轮次头与
 * 轮次目录(⌘⇧O)都只是这份索引的两种呈现,故排序、编号、摘要口径一律收在这里:
 * 目录里显示的第 7 轮,与吸顶头显示的 #7、⌥↑ 数到的第 7 个,必须是同一轮。
 *
 * 「未装载」轮次:续接会话只把尾部 CHAT_SEED_LIMIT 条历史渲染进 DOM,更早的轮次
 * 仍在已取回的回放事件里但没有节点。它们照样进索引(编号才连续、才搜得到),
 * 只是 loaded=false,被选中时先回填再跳。
 */

import { matchScore } from './fuzzy';

/** 一轮的索引项;ord 是全局序号(0 基),含尚未装载的更早轮次 */
export interface Turn {
  ord: number;
  /** 用户输入全文,搜索用 */
  text: string;
  /** 单行摘要,展示用 */
  summary: string;
  ts?: number;
  /** false = 超出 seed 上限、尚未渲染进 DOM,跳转前需先回填 */
  loaded: boolean;
}

/**
 * 会话转录里挂着 kind=user、但并非「你问的一轮」的元条目。
 *
 * Claude Code 把斜杠命令的信封、命令回显、注意事项、后台任务通知与中断标记一并写进
 * 用户消息流。它们照样渲染在对话里(那是转录的事实),但作为目录条目是纯噪音——
 * 没人会想「跳回我切模型那一下」。5 个真实会话 532 条用户事件里,这类占 37%
 * (2026-09-02 实测:caveat 58 / command-name 58 / stdout 58 / task-notification 14 / 中断 9),
 * 不滤掉的话真正的提问会被挤出目录可视区。
 *
 * 用具名白名单而非「以 < 开头就丢」:用户粘一段 HTML 或 XML 当提问是完全正常的,
 * 宁可漏滤一种没见过的元条目,也不能吞掉一轮真的提问。
 */
const META_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'task-notification',
  'system-reminder',
];
const META_RE = new RegExp(`^<(${META_TAGS.join('|')})[\\s>]`);

/** 这条用户消息是否算「一轮」(能被目录列出、被 ⌥↑↓ 数到) */
export function isRealTurn(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (META_RE.test(t)) return false;
  if (/^\[Request interrupted by user/.test(t)) return false;
  return true;
}

/** 用户输入 → 单行摘要:取首个非空行并压掉连续空白。
 *  多行任务描述在目录里只能占一行,首行几乎总是那句「要做什么」;
 *  截断交给 CSS 省略号,这里不按字数切——中英混排按字数切会切出半个词。 */
export function turnSummary(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

/** 拼出全局轮次索引:earlier(尚未装载,按时间升序)在前,loaded(已在 DOM 里)在后。
 *  元条目在这里就被滤掉,故 ord 是「真轮次」的连续编号 —— 渲染侧必须用同一个
 *  isRealTurn 判定给消息挂 data-turn,两边口径分家就会跳错行。 */
export function buildTurns(
  earlier: { text: string; ts?: number }[],
  loaded: { text: string; ts?: number }[],
): Turn[] {
  return [...earlier.map((x) => ({ ...x, loaded: false })), ...loaded.map((x) => ({ ...x, loaded: true }))]
    .filter((x) => isRealTurn(x.text))
    .map((x, ord) => ({ ord, text: x.text, summary: turnSummary(x.text), ts: x.ts, loaded: x.loaded }));
}

/**
 * 按滚动位置定位「当前轮」:最后一条起点已进入阅读区顶部的用户消息。
 *
 * 两个阈值不是同一个,分开传:
 * - activeOffset:判「算不算当前轮」。必须 ≥ 跳转时给落点留的顶部余量,否则刚跳到的那一轮
 *   因为停在余量之下而不被算作当前轮,⌥↑ 会从它的上一轮起步、一按跳两轮(实测踩到)。
 * - bandH:判 gone —— 提问整条已被吸顶带盖住,此时才需要顶条替它站岗;
 *   提问本身还看得见时再吸一条同样内容的顶条,是纯粹的重复。
 *
 * boxes 须按 ord 升序传入(DOM 顺序天然如此)。
 */
export function currentTurn(
  boxes: { ord: number; top: number; bottom: number }[],
  scrollTop: number,
  activeOffset: number,
  bandH: number,
): { ord: number; gone: boolean } | null {
  let found: { ord: number; top: number; bottom: number } | null = null;
  for (const b of boxes) {
    if (b.top <= scrollTop + activeOffset) found = b;
    else break;
  }
  if (!found) return null;
  return { ord: found.ord, gone: found.bottom < scrollTop + bandH };
}

/** 相邻轮:dir=-1 上一轮,dir=1 下一轮;到头即停(不回绕,与看板方向键同口径)。
 *  cur 为 null(还没滚到任何一轮)时,↑ 落在最后一轮、↓ 落在第一轮。 */
export function stepTurn(cur: number | null, dir: -1 | 1, total: number): number | null {
  if (total === 0) return null;
  if (cur === null) return dir === -1 ? total - 1 : 0;
  const next = cur + dir;
  return next < 0 || next >= total ? null : next;
}

/** 目录搜索排序:复用 /wd 的分层打分(短名=摘要首行,长值=输入全文),
 *  故「命中落在第三行、界面只显示首行」的轮次仍能被搜到,只是排在首行命中之后。
 *  空查询原样返回,保持时间顺序 —— 目录首先是一份按时间排的清单,不是搜索结果页。 */
export function rankTurns(turns: Turn[], query: string): Turn[] {
  const q = query.trim();
  if (!q) return turns;
  return turns
    .map((t) => ({ t, s: matchScore(q, t.summary, t.text) }))
    .filter((x): x is { t: Turn; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.t.ord - b.t.ord)
    .map((x) => x.t);
}
