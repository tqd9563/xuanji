import { describe, expect, it } from 'vitest';
import { prCardText } from '../src/lib/utils';

/** 构造本地时区的时刻,避免用例随运行机器时区飘 */
const at = (h: number, mi: number) => new Date(2026, 7, 11, h, mi).getTime();

describe('prCardText', () => {
  it('编号前缀随平台:GitLab 用 !,GitHub 与认不出的自建实例用 #', () => {
    expect(prCardText({ platform: 'gitlab', number: 8087, updates: 0 }).label).toBe('!8087');
    expect(prCardText({ platform: 'github', number: 38, updates: 0 }).label).toBe('#38');
    expect(prCardText({ platform: 'other', number: 7, updates: 0 }).label).toBe('#7');
  });

  it('只创建过时不出现更新次数,有后续 push/合并事件才追加', () => {
    expect(prCardText({ platform: 'gitlab', number: 1, updates: 0, ts: at(11, 38) }).meta).toBe('已创建 11:38');
    expect(prCardText({ platform: 'gitlab', number: 1, updates: 8, ts: at(11, 38) }).meta).toBe(
      '已创建 11:38 · 更新 8 次',
    );
  });

  it('字段缺失时降级而不是渲染出 undefined', () => {
    expect(prCardText({ platform: 'other', updates: 0 }).label).toBe('链接');
    expect(prCardText({ platform: 'gitlab', number: 1, updates: 2 }).meta).toBe('更新 2 次');
    expect(prCardText({ platform: 'gitlab', number: 1, updates: 0 }).meta).toBe('');
  });
});
