/**
 * 路径/短名的模糊匹配打分。最初长在 WdPalette 内部(/wd 切工作目录),
 * 待办速记浮层的项目选择要的是同一套心智,故抽出共用——同一个查询词在两处
 * 必须给出同一个答案,否则用户在 /wd 里练出的手感到了速记框就失灵。
 * 后端 services/todos.ts 的宽松匹配也按这个口径实现(Raycast 手打短名走那条路)。
 */

/** 子序列匹配:query 的字符按序出现在 target 中即命中(入参均已小写) */
export function isSubseq(q: string, t: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** 分层打分(大小写不敏感),不命中返回 null:
 *  100 短名前缀连续命中 > 80 短名中段连续命中 > 60 短名子序列 > 40 路径连续 > 20 路径子序列。
 *  label 与 path 各自独立匹配、不拼接:曾经拼接后做整串子序列,公共路径前缀
 *  /Users/xxx/ 会兜底吸收查询字符("dee" 借 Us"e"rs/lilithgam"e"s 命中一切含 d 的项目)。
 *  path 入参须先剥掉所有候选共有的目录前缀(见 commonDirPrefix),同理防兜底。 */
export function matchScore(query: string, label: string, path: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  const p = path.toLowerCase();
  const idx = l.indexOf(q);
  if (idx === 0) return 100;
  if (idx > 0) return 80;
  if (isSubseq(q, l)) return 60;
  if (p.includes(q)) return 40;
  if (isSubseq(q, p)) return 20;
  return null;
}

/** 所有候选共有的目录前缀(截到最后一个 "/",含斜杠);无 "/" 或单候选时返回 ""。
 *  /model 复用 WdPalette 时选项是模型名(无斜杠),自动退化为不剥前缀。 */
export function commonDirPrefix(paths: string[]): string {
  const first = paths[0];
  if (paths.length < 2 || first === undefined) return '';
  let prefix = first;
  for (const p of paths.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < p.length && prefix[i] === p[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) return '';
  }
  const cut = prefix.lastIndexOf('/');
  return cut >= 0 ? prefix.slice(0, cut + 1) : '';
}

/** 按分排序过滤候选;同分保持原顺序(稳定,保留数据源的 recency) */
export function fuzzyRank(options: string[], query: string, labelOf?: (v: string) => string): string[] {
  const prefix = commonDirPrefix(options);
  return options
    .map((o, i) => {
      const rest = o.startsWith(prefix) ? o.slice(prefix.length) : o;
      const score = matchScore(query, labelOf?.(o) ?? rest, rest);
      return score === null ? null : { o, score, i };
    })
    .filter((x): x is { o: string; score: number; i: number } => x !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.o);
}
