/** 经验页的纯逻辑:筛选计数、命中片段、引用关系、正文渲染插件。与视图分开便于单测。 */
import type { Memory } from '@/api/types';

export type TypeFilter = 'all' | Exclude<Memory['type'], 'unknown'>;
export const TYPE_FILTERS: TypeFilter[] = ['all', 'user', 'feedback', 'project', 'reference', 'cross-project'];
export const EDIT_TYPES: Memory['type'][] = ['user', 'feedback', 'project', 'reference'];

export interface Facet {
  name: string;
  path: string;
  total: number;
}

/** 项目列表:按条数降序、同数按名字——筛选条、分组顺序、「其余」下拉都用这一份顺序 */
export function projectFacets(all: Memory[]): Facet[] {
  const map = new Map<string, Facet>();
  for (const m of all) {
    const f = map.get(m.project);
    if (f) f.total++;
    else map.set(m.project, { name: m.project, path: m.projectPath, total: 1 });
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

export function countByProject(list: Memory[]): Map<string, number> {
  const c = new Map<string, number>();
  for (const m of list) c.set(m.project, (c.get(m.project) ?? 0) + 1);
  return c;
}

/** 把列表按项目顺序排好(稳定排序:组内保持传入顺序,即搜索相关度或名字序) */
export function orderByFacets(list: Memory[], facets: Facet[]): Memory[] {
  const rank = new Map(facets.map((f, i) => [f.name, i]));
  return list
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (rank.get(a.m.project) ?? 1e9) - (rank.get(b.m.project) ?? 1e9) || a.i - b.i)
    .map((x) => x.m);
}

/** 朴素包含匹配(回收站视图用;经验列表的搜索走后端 FTS5) */
export function matchesQuery(m: Memory, q: string): boolean {
  const n = q.trim().toLowerCase();
  return !n || [m.name, m.description, m.body].some((s) => s.toLowerCase().includes(n));
}

export interface Seg {
  text: string;
  hit: boolean;
}
/** 把文本按命中切段(大小写不敏感),供行内高亮渲染 */
export function hitSegments(text: string, q: string): Seg[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return text ? [{ text, hit: false }] : [];
  const low = text.toLowerCase();
  const out: Seg[] = [];
  let i = 0;
  for (let j = low.indexOf(needle, i); j !== -1; j = low.indexOf(needle, i)) {
    if (j > i) out.push({ text: text.slice(i, j), hit: false });
    out.push({ text: text.slice(j, j + needle.length), hit: true });
    i = j + needle.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}

/** 列表行的第二行:命中只在正文里时换成正文片段,否则看不出「为什么搜到它」 */
export function descSnippet(m: Memory, q: string): { text: string; fromBody: boolean } {
  const n = q.trim().toLowerCase();
  if (!n || m.name.toLowerCase().includes(n) || m.description.toLowerCase().includes(n)) {
    return { text: m.description, fromBody: false };
  }
  const k = m.body.toLowerCase().indexOf(n);
  if (k === -1) return { text: m.description, fromBody: false };
  const from = Math.max(0, k - 28);
  return { text: (from ? '…' : '') + m.body.slice(from, k + 90).replace(/\s+/g, ' '), fromBody: true };
}

/** 引用了 m 的其它经验(共享经验在多个项目各有一份,按名字去重) */
export function inboundRefs(all: Memory[], m: Memory): Memory[] {
  const seen = new Map<string, Memory>();
  for (const x of all) if (x.name !== m.name && x.links.includes(m.name) && !seen.has(x.name)) seen.set(x.name, x);
  return [...seen.values()];
}

/** 展示用的短路径:家目录写成 ~,项目 slug 省成 … */
export function shortFile(file: string): string {
  return file.replace(/^\/Users\/[^/]+/, '~').replace(/(\/projects\/)[^/]+(\/memory\/)/, '$1…$2');
}

// ---------- 正文渲染 ----------

const CJK = /[⺀-鿿　-〿＀-￯]/;
const BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~)/;
const RULE = /^\s*([-=*_])\1{2,}\s*$/;

/**
 * 段内单换行的处理。经验正文有两种写法混在一起,标准 markdown 两种都渲染不好:
 * - 标签行:「**Why:** …」紧接「**How to apply:** …」,作者要的是两行 → 下一行以 `**` 开头时保留为硬换行;
 * - 手工折行:一句话在源文件里按 80 列折成几行 → 接回一行;任一侧是中日韩字符时不加空格
 *   (浏览器会把换行渲染成一个空格,中文句子中间就多出一个空隙)。
 * 代码块、标题、列表项起始、表格、引用、分隔线原样不动。
 */
export function normalizeMemoryBody(body: string): string {
  const out: string[] = [];
  let fence = false;
  let joinable = false; // 上一行是否是可以往后接的普通文本行
  for (const line of body.replace(/\r/g, '').split('\n')) {
    const isFence = /^\s*(```|~~~)/.test(line);
    if (isFence || fence) {
      if (isFence) fence = !fence;
      out.push(line);
      joinable = false;
      continue;
    }
    const blank = !line.trim();
    const block = BLOCK_START.test(line) || RULE.test(line);
    if (!blank && !block && joinable) {
      const prev = out[out.length - 1]!;
      const next = line.trimStart();
      if (next.startsWith('**')) out[out.length - 1] = `${prev.trimEnd()}  \n${next}`;
      else out[out.length - 1] = prev.trimEnd() + (CJK.test(prev.trimEnd().slice(-1)) || CJK.test(next[0]!) ? '' : ' ') + next;
    } else out.push(line);
    // 标题、表格行、分隔线之后的行不往上接;列表项与引用可以接(markdown 的 lazy continuation)
    joinable = !blank && !/^\s*(#{1,6}\s|\|)/.test(line) && !RULE.test(line);
  }
  return out.join('\n');
}

// ---------- 正文渲染:rehype 插件 ----------

interface HNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}
const el = (tagName: string, properties: Record<string, unknown>, children: HNode[]): HNode => ({ type: 'element', tagName, properties, children });
const txt = (value: string): HNode => ({ type: 'text', value });

function marks(value: string, q: string): HNode[] {
  return hitSegments(value, q).map((s) => (s.hit ? el('mark', { className: ['xjm-hit'] }, [txt(s.text)]) : txt(s.text)));
}
function splitBy(value: string, rx: RegExp, wrap: (m: RegExpExecArray) => HNode, rest: (s: string) => HNode[]): HNode[] {
  const out: HNode[] = [];
  let i = 0;
  for (let m = rx.exec(value); m; m = rx.exec(value)) {
    if (m.index > i) out.push(...rest(value.slice(i, m.index)));
    out.push(wrap(m));
    i = m.index + m[0].length;
  }
  if (i < value.length) out.push(...rest(value.slice(i)));
  return out;
}

/**
 * 一段正文文本 → 节点序列。三件事,由外到内:
 * 1. 补加粗:CommonMark 不认「紧贴中文标点的 `**`」(如 `。**「结论」。**Why`),这种写法在经验里很常见,
 *    解析后原样残留在文本节点里,这里按成对的 `**` 补成 strong;
 * 2. `[[名字]]` → 可点的关联链接;
 * 3. 搜索命中 → mark。
 * 代码里(inCode)只做第 3 件:代码内容不能被改写。
 */
export function memoryTextNodes(value: string, q: string, inCode = false): HNode[] {
  if (inCode) return marks(value, q);
  const links = (s: string) =>
    splitBy(
      s,
      /\[\[([^\]\n]+)\]\]/g,
      (m) => el('button', { type: 'button', className: ['wikilink'], 'data-link': m[1] }, marks(m[0], q)),
      (r) => marks(r, q),
    );
  return splitBy(value, /\*\*([^*\n]+?)\*\*/g, (m) => el('strong', {}, links(m[1]!)), links);
}

/** rehype 插件:对整棵树的文本节点应用 memoryTextNodes。q 变了要换新的插件实例(react-markdown 按引用判断) */
export function rehypeMemory(q: string) {
  return () => (tree: HNode) => {
    const walk = (node: HNode, inCode: boolean) => {
      if (!node.children) return;
      const code = inCode || node.tagName === 'code' || node.tagName === 'pre';
      node.children = node.children.flatMap((c) => {
        if (c.type === 'text' && c.value) return memoryTextNodes(c.value, q, code);
        // 已经是链接 / 按钮的不再套 [[ ]],但仍下钻做高亮
        walk(c, code);
        return [c];
      });
    };
    walk(tree, false);
  };
}
