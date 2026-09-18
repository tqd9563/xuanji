import { describe, expect, it } from 'vitest';
import { blocksToText, fenceBody, insertFence, isInFence, parse, wrapInline } from './composer-code';

/** 取某个类名的全部切片文本,便于断言「哪几段被高亮成了什么」 */
const of = (text: string, cls: string) =>
  parse(text)
    .flatMap((b) => b.segs)
    .filter((s) => s.cls === cls)
    .map((s) => s.text);

describe('parse', () => {
  it('切片拼回去逐字等于原文(镜像层不丢字的铁律)', () => {
    const samples = [
      '',
      '普通一句话',
      '把 `resolveRunbook` 收到一处,别在 `render` 里再抄一遍',
      '看这段:\n```ts\nconst a = 1\n```\n跑一下',
      '未闭合:\n```py\ndf.head()',
      '```\n\n```',
      '尾部换行\n',
      '孤立反引号 ` 不成对',
      '```ts title=demo\nx\n```',
    ];
    for (const s of samples) expect(blocksToText(parse(s))).toBe(s);
  });

  it('识别行内代码,连同两侧反引号一起高亮', () => {
    expect(of('把 `a` 与 `b` 合并', 'tk-inline')).toEqual(['`a`', '`b`']);
  });

  it('跨行的反引号不算行内代码', () => {
    expect(of('第一行 `未闭合\n第二行 收尾`', 'tk-inline')).toEqual([]);
  });

  it('围栏内不再识别行内代码', () => {
    expect(of('```\nconst s = `tpl`\n```', 'tk-inline')).toEqual([]);
    expect(of('```\nconst s = `tpl`\n```', 'tk-fence')).toEqual(['const s = `tpl`']);
  });

  it('围栏标记与语言名分开高亮', () => {
    expect(of('```ts\nx\n```', 'tk-mark')).toEqual(['```', '```']);
    expect(of('```ts\nx\n```', 'tk-lang')).toEqual(['ts']);
  });

  it('未闭合围栏吃到文本末尾并标记 closed=false', () => {
    const blocks = parse('看下:\n```py\ndf = 1\ndf.head()');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ type: 'fence', closed: false });
    expect(of('看下:\n```py\ndf = 1\ndf.head()', 'tk-fence')).toEqual(['df = 1', 'df.head()']);
  });

  it('闭合围栏之后的文本回到普通块', () => {
    const blocks = parse('```\nx\n```\n收尾说明');
    expect(blocks.map((b) => b.type)).toEqual(['fence', 'plain']);
    expect(blocks[0]).toMatchObject({ closed: true });
  });
});

describe('fenceBody', () => {
  it('只取正文,丢掉开合围栏与语言名', () => {
    expect(fenceBody(parse('```ts\nconst a = 1\nconst b = 2\n```')[0]!)).toBe('const a = 1\nconst b = 2');
  });
  it('未闭合围栏照样取到已写下的正文', () => {
    expect(fenceBody(parse('```py\ndf.head()')[0]!)).toBe('df.head()');
  });
  it('空代码块取到空串', () => {
    expect(fenceBody(parse('```\n```')[0]!)).toBe('');
  });
});

describe('isInFence', () => {
  const t = '前言\n```ts\nconst a = 1\n```\n后话';
  it('闭合围栏内部为真、围栏外为假', () => {
    expect(isInFence(t, t.indexOf('const'))).toBe(true);
    expect(isInFence(t, 1)).toBe(false);
    expect(isInFence(t, t.length)).toBe(false);
  });
  it('未闭合围栏之后一直为真', () => {
    const u = '看下:\n```py\ndf.head()';
    expect(isInFence(u, u.length)).toBe(true);
  });
});

describe('wrapInline / insertFence', () => {
  it('包裹选区并把选区留在反引号之内', () => {
    const r = wrapInline('把 resolveRunbook 收到一处', 2, 16);
    expect(r.value).toBe('把 `resolveRunbook` 收到一处');
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('resolveRunbook');
  });

  it('空选区插入一对反引号,光标落中间', () => {
    const r = wrapInline('ab', 1, 1);
    expect(r.value).toBe('a``b');
    expect(r.selStart).toBe(2);
    expect(r.selEnd).toBe(2);
  });

  it('行首插入围栏骨架,光标落正文', () => {
    const r = insertFence('', 0, 0);
    expect(r.value).toBe('```\n\n```\n');
    expect(r.selStart).toBe(4);
    expect(isInFence(r.value, r.selStart)).toBe(true);
  });

  it('光标不在行首时先补换行,保证围栏自成一行', () => {
    const r = insertFence('看这段:', 4, 4);
    expect(r.value).toBe('看这段:\n```\n\n```\n');
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('');
  });

  it('带选区时选中内容进围栏正文', () => {
    const r = insertFence('df.head()', 0, 9);
    expect(r.value).toBe('```\ndf.head()\n```\n');
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('df.head()');
  });
});
