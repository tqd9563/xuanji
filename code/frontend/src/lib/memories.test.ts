import { describe, expect, it } from 'vitest';
import type { Memory } from '@/api/types';
import { countByProject, descSnippet, hitSegments, inboundRefs, memoryTextNodes, normalizeMemoryBody, orderByFacets, projectFacets, shortFile } from './memories';

const mem = (p: Partial<Memory>): Memory => ({
  name: 'n', description: '', type: 'feedback', project: 'p', projectPath: '/x/p', file: `/f/${p.project ?? 'p'}/${p.name ?? 'n'}.md`,
  body: '', links: [], rev: 'r', truncated: false, sharedWith: null, indexHook: null, ...p,
});

describe('项目筛选', () => {
  const all = [mem({ name: 'a', project: 'small' }), mem({ name: 'b', project: 'big' }), mem({ name: 'c', project: 'big' }), mem({ name: 'd', project: 'alpha' })];
  it('按条数降序,同数按名字', () => {
    expect(projectFacets(all).map((f) => `${f.name}:${f.total}`)).toEqual(['big:2', 'alpha:1', 'small:1']);
  });
  it('列表按项目顺序重排,组内保持传入顺序(搜索相关度不被打乱)', () => {
    const ranked = [all[2]!, all[0]!, all[1]!];
    expect(orderByFacets(ranked, projectFacets(all)).map((m) => m.name)).toEqual(['c', 'b', 'a']);
  });
  it('计数随传入列表变化(搜索后是命中数)', () => {
    expect(Object.fromEntries(countByProject([all[1]!, all[0]!]))).toEqual({ big: 1, small: 1 });
  });
});

describe('命中高亮', () => {
  it('大小写不敏感,保留原文大小写,连续命中都切出来', () => {
    expect(hitSegments('WKWebView 与 wkwebview', 'wkweb')).toEqual([
      { text: 'WKWeb', hit: true }, { text: 'View 与 ', hit: false }, { text: 'wkweb', hit: true }, { text: 'view', hit: false },
    ]);
  });
  it('空查询整段不命中;空文本返回空数组', () => {
    expect(hitSegments('abc', ' ')).toEqual([{ text: 'abc', hit: false }]);
    expect(hitSegments('', 'a')).toEqual([]);
  });
  it('命中在名称或描述里:第二行仍是描述', () => {
    expect(descSnippet(mem({ description: '角标不熄灭', body: '正文也有角标' }), '角标')).toEqual({ text: '角标不熄灭', fromBody: false });
  });
  it('命中只在正文里:第二行换成正文片段并压平换行', () => {
    const r = descSnippet(mem({ description: '无关', body: `${'前'.repeat(40)}\n目标词\n后文` }), '目标词');
    expect(r.fromBody).toBe(true);
    expect(r.text.startsWith('…')).toBe(true);
    expect(r.text).toContain('目标词 后文');
  });
});

describe('引用关系', () => {
  it('列出引用了它的经验,同名(共享经验的多份挂载)只算一次,不含自己', () => {
    const t = mem({ name: 'target' });
    const all = [t, mem({ name: 'x', links: ['target'], project: 'a' }), mem({ name: 'x', links: ['target'], project: 'b' }), mem({ name: 'y', links: ['other'] }), mem({ name: 'target', links: ['target'], project: 'b' })];
    expect(inboundRefs(all, t).map((m) => m.name)).toEqual(['x']);
  });
});

describe('正文文本节点', () => {
  const flat = (ns: ReturnType<typeof memoryTextNodes>): string =>
    ns.map((n) => (n.type === 'text' ? n.value : `<${n.tagName}>${flat(n.children ?? [])}</${n.tagName}>`)).join('');
  it('补上 CommonMark 不认的「紧贴中文标点的加粗」', () => {
    expect(flat(memoryTextNodes('结论。**「先查入口」再查判定。**Why:略', ''))).toBe('结论。<strong>「先查入口」再查判定。</strong>Why:略');
  });
  it('[[名字]] 变成带 data-link 的按钮,加粗里的也认', () => {
    const ns = memoryTextNodes('见 [[a-b]] 与 **[[c]]**', '');
    expect(flat(ns)).toBe('见 <button>[[a-b]]</button> 与 <strong><button>[[c]]</button></strong>');
    expect(ns[1]!.properties).toMatchObject({ 'data-link': 'a-b' });
  });
  it('搜索命中包成 mark,链接文字里的也高亮', () => {
    expect(flat(memoryTextNodes('角标 [[角标-x]]', '角标'))).toBe('<mark>角标</mark> <button>[[<mark>角标</mark>-x]]</button>');
  });
  it('代码里只做高亮:不补加粗、不造链接', () => {
    expect(flat(memoryTextNodes('**x** [[y]] x', 'x', true))).toBe('**<mark>x</mark>** [[y]] <mark>x</mark>');
  });
});

describe('段内换行', () => {
  it('标签行保留为两行;手工折行接回一行,中文之间不加空格、英文之间加空格', () => {
    expect(normalizeMemoryBody('**Why:** 原因在这\n里折了行\n**How to apply:** 先查\nthe entry\npoint')).toBe(
      '**Why:** 原因在这里折了行  \n**How to apply:** 先查the entry point',
    );
  });
  it('空行分段、列表、标题、表格、代码块原样不动', () => {
    const src = '# 标题\n正文一\n\n- 项一\n- 项二\n  续行\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nline1\nline2\n```\n尾巴';
    expect(normalizeMemoryBody(src)).toBe('# 标题\n正文一\n\n- 项一\n- 项二续行\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nline1\nline2\n```\n尾巴');
  });
});

describe('短路径', () => {
  it('家目录写成 ~,项目 slug 省略', () => {
    expect(shortFile('/Users/me/.claude/projects/-Users-me-xuanji/memory/a-b.md')).toBe('~/.claude/projects/…/memory/a-b.md');
  });
});
