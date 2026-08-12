import { describe, expect, it } from 'vitest';
import { buildMatcher, countLabel, escapeRegExp, matchRanges } from './find';

describe('escapeRegExp', () => {
  it('把元字符转成字面量', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c');
    expect(new RegExp(escapeRegExp('restart.sh')).test('restart.sh')).toBe(true);
    expect(new RegExp(escapeRegExp('restart.sh')).test('restartXsh')).toBe(false);
  });
});

describe('buildMatcher', () => {
  it('默认按字面量匹配,不区分大小写', () => {
    const rx = buildMatcher('Restart', { caseSensitive: false, regex: false })!;
    expect(matchRanges('restart.sh 与 RESTART', rx)).toHaveLength(2);
  });

  it('区分大小写时只命中同形', () => {
    const rx = buildMatcher('Restart', { caseSensitive: true, regex: false })!;
    expect(matchRanges('restart 与 Restart', rx)).toEqual([{ start: 10, end: 17 }]);
  });

  it('正则模式下元字符生效', () => {
    const rx = buildMatcher('worklog|归因', { caseSensitive: false, regex: true })!;
    expect(matchRanges('归因结论写进 worklog', rx)).toHaveLength(2);
  });

  it('空查询与非法正则都返回 null(调用方据此区分空态与报错)', () => {
    expect(buildMatcher('', { caseSensitive: false, regex: false })).toBeNull();
    expect(buildMatcher('(', { caseSensitive: false, regex: true })).toBeNull();
    // 非正则模式下 '(' 是普通字符,不该被当成非法
    expect(buildMatcher('(', { caseSensitive: false, regex: false })).not.toBeNull();
  });
});

describe('matchRanges', () => {
  it('给出全部命中的区间', () => {
    const rx = buildMatcher('ab', { caseSensitive: false, regex: false })!;
    expect(matchRanges('abcab', rx)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  it('可空匹配的正则不会死循环', () => {
    const rx = buildMatcher('a*', { caseSensitive: false, regex: true })!;
    expect(matchRanges('bab', rx)).toEqual([{ start: 1, end: 2 }]);
  });

  it('同一个匹配器重复使用时从头开始(lastIndex 被重置)', () => {
    const rx = buildMatcher('a', { caseSensitive: false, regex: false })!;
    expect(matchRanges('aa', rx)).toHaveLength(2);
    expect(matchRanges('aa', rx)).toHaveLength(2);
  });

  it('中文按字符计数,区间可直接用于 Range', () => {
    const rx = buildMatcher('归因', { caseSensitive: false, regex: false })!;
    expect(matchRanges('收入异动归因', rx)).toEqual([{ start: 4, end: 6 }]);
  });
});

describe('countLabel', () => {
  it('三种状态分开:正则非法 / 无结果 / 第几条', () => {
    expect(countLabel(0, 0, true)).toBe('正则无效');
    expect(countLabel(0, 0, false)).toBe('无结果');
    expect(countLabel(17, 2, false)).toBe('3/17');
  });
});
