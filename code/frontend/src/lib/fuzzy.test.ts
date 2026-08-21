import { describe, expect, it } from 'vitest';
import { hitParts, matchScore } from './fuzzy';

describe('hitParts', () => {
  it('切出连续命中片段', () => {
    expect(hitParts('todo 看板空格键失灵', 'todo')).toEqual({ before: '', hit: 'todo', after: ' 看板空格键失灵' });
    expect(hitParts('修复 todo 横幅', 'TODO')).toEqual({ before: '修复 ', hit: 'todo', after: ' 横幅' });
  });

  it('空 query 或未连续命中时不高亮,原文落在 before', () => {
    expect(hitParts('待办联动', '')).toEqual({ before: '待办联动', hit: '', after: '' });
    expect(hitParts('待办联动', '  ')).toEqual({ before: '待办联动', hit: '', after: '' });
    // 子序列命中(matchScore 认,hitParts 不高亮)
    expect(matchScore('待动', '待办联动', 'x')).toBe(60);
    expect(hitParts('待办联动', '待动')).toEqual({ before: '待办联动', hit: '', after: '' });
  });
});

describe('matchScore:会话名当短名 / sessionId 当路径', () => {
  it('按前缀 > 中段 > 子序列 > id 命中分层', () => {
    const id = 'c3a91f04-77b2-4a1e-9f30-2d5e8a1c0b47';
    expect(matchScore('待办', '待办与派发会话联动', id)).toBe(100);
    expect(matchScore('派发', '待办与派发会话联动', id)).toBe(80);
    expect(matchScore('c3a', '待办与派发会话联动', id)).toBe(40);
    expect(matchScore('zzz', '待办与派发会话联动', id)).toBeNull();
  });
});
