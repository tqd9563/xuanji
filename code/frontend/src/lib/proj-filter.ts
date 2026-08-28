/**
 * 会话看板的项目维度过滤:纯逻辑,与渲染分离。
 *
 * 设计取向(见 wiki/design/prototype-project-lens.html):过滤是「聚焦」不是「导航」——
 * 状态四列的结构一动不动,非命中的卡淡出而非移除,列长仍如实反映**全局**积压量。
 * 因此这里只回答两个问题:有哪些项目可选(facets),以及某张卡是否命中(matches);
 * 「怎么表现不命中」交给 CSS,「键盘怎么跳过」交给 Sessions 的 visibleOf。
 */
import type { AgentSession, SessionState } from '@/api/types';
import { isUnread, projOrder } from '@/lib/utils';

export interface ProjFacet {
  name: string;
  /** 该项目在看板上的会话总数(四列合计) */
  total: number;
  /** 其中待验收(未读)的张数——chip 上的琥珀角标 */
  unread: number;
}

/**
 * 看板数据 → 项目清单(带计数)。
 *
 * 排序用后端调色板序号(项目首次出现顺序,存在 SQLite 里,与分类色同源且跨端一致),
 * 未进调色板的退化到字典序垫底。刻意**不**按会话数或待验收数排序:chip 是高频点击的
 * 控件,位置必须稳定,否则每次轮询后手指都要重新找一遍。
 */
export function projectFacets(columns: Record<SessionState, AgentSession[]>): ProjFacet[] {
  const acc = new Map<string, ProjFacet>();
  for (const list of Object.values(columns)) {
    for (const s of list) {
      const f = acc.get(s.project) ?? { name: s.project, total: 0, unread: 0 };
      f.total += 1;
      if (isUnread(s)) f.unread += 1;
      acc.set(s.project, f);
    }
  }
  return [...acc.values()].sort((a, b) => {
    const [oa, ob] = [projOrder(a.name), projOrder(b.name)];
    // 相减会让两个都没进调色板的项目得出 Infinity - Infinity = NaN,字典序兜底就此失效
    // (排序结果变成不确定的原始顺序)。这里显式比较,只有真的同序号才走名字。
    if (oa !== ob) return oa < ob ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 空集 = 不过滤(「全部」态);否则按项目名命中 */
export function matches(s: AgentSession, active: ReadonlySet<string>): boolean {
  return active.size === 0 || active.has(s.project);
}

/** 键盘导航可达的卡:过滤中的暗卡不可点(pointer-events: none),键盘也不该选中它 */
export function narrow(items: AgentSession[], active: ReadonlySet<string>): AgentSession[] {
  return active.size === 0 ? items : items.filter((s) => matches(s, active));
}

/**
 * 过滤集合的增删:点已选的 chip = 取消选中。
 * 返回新集合(不改入参),便于直接喂给 setState。
 */
export function toggle(active: ReadonlySet<string>, name: string): Set<string> {
  const next = new Set(active);
  if (!next.delete(name)) next.add(name);
  return next;
}

/**
 * 看板数据变化后校准键盘选中位:当前列已无命中卡时落到第一个有命中卡的列,
 * 行号夹到该列长度内。全盘无命中卡则返回 null(交由调用方清空选中)。
 * 让「切换过滤后选中的卡凭空消失」这件事在一处收敛,而不是散在各个 setState 里。
 */
export function recalibrate(
  pos: { c: number; r: number } | null,
  countsByCol: number[],
): { c: number; r: number } | null {
  if (!pos) return null;
  let c = pos.c;
  if ((countsByCol[c] ?? 0) === 0) c = countsByCol.findIndex((n) => n > 0);
  if (c === -1 || c === undefined) return null;
  const n = countsByCol[c] ?? 0;
  if (n === 0) return null;
  return { c, r: Math.min(pos.r, n - 1) };
}
