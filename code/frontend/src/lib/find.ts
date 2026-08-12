/** 会话内查找(⌘F)的纯逻辑:构造匹配器 + 在一段文本里求所有命中区间。
 *  DOM 相关的收集/绘制在 components/FindBar.tsx,这里只留可单测的部分。 */

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
}

/** 把用户输入当字面量时需要转义的正则元字符 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 构造全局匹配器。正则模式下用户输入写坏时返回 null(调用方据此把输入框转红,不弹错)。 */
export function buildMatcher(query: string, opts: FindOptions): RegExp | null {
  if (!query) return null;
  const source = opts.regex ? query : escapeRegExp(query);
  const flags = opts.caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

export interface MatchRange {
  start: number;
  end: number;
}

/** 求 text 中的全部命中区间。
 *  空匹配(如 `a*`、`^`)会让 lastIndex 原地不动,必须手动推进,否则死循环。 */
export function matchRanges(text: string, rx: RegExp): MatchRange[] {
  const out: MatchRange[] = [];
  rx.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    if (m[0] === '') {
      rx.lastIndex += 1;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 命中计数的展示文案。总数为 0 与正则非法是两种不同的空态,文案要分开。 */
export function countLabel(total: number, index: number, invalid: boolean): string {
  if (invalid) return '正则无效';
  if (total === 0) return '无结果';
  return `${index + 1}/${total}`;
}
