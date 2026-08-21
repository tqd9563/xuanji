import { describe, expect, it } from 'vitest';
import { scoreSession } from './ResumePalette';

const ID = 'c85fc7b0-d151-4ada-8da9-19120c8e4f77';

describe('scoreSession', () => {
  it('会话名分层:前缀 > 中段 > 子序列', () => {
    expect(scoreSession('待办', '待办与派发会话联动', ID)).toBe(100);
    expect(scoreSession('派发', '待办与派发会话联动', ID)).toBe(80);
    expect(scoreSession('待动', '待办与派发会话联动', ID)).toBe(60);
  });

  it('id 只认界面露出的前 8 位,或整串前缀(粘贴完整 id)', () => {
    expect(scoreSession('c85fc7', '无关会话名', ID)).toBe(40);
    expect(scoreSession('C85FC7', '无关会话名', ID)).toBe(40); // 大小写不敏感
    expect(scoreSession(ID, '无关会话名', ID)).toBe(40); // 整串粘贴
  });

  it('不匹配 uuid 中后段:那段界面没显示,搜到了也看不出为什么', () => {
    expect(scoreSession('19120c8e', '无关会话名', ID)).toBeNull();
    expect(scoreSession('4ada', '无关会话名', ID)).toBeNull();
  });

  it('不做 uuid 子序列匹配:假阳性极高', () => {
    // c…8…b 在 c85fc7b0 里按序出现,但不是连续片段,不应命中
    expect(scoreSession('c8b', '无关会话名', ID)).toBeNull();
  });

  it('空 query 全通过,完全不匹配返回 null', () => {
    expect(scoreSession('', '任意会话', ID)).toBe(0);
    expect(scoreSession('   ', '任意会话', ID)).toBe(0);
    expect(scoreSession('zzzzqq', '任意会话', ID)).toBeNull();
  });
});
