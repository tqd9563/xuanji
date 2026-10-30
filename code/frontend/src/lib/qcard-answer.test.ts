import { describe, expect, it } from 'vitest';
import { composeAnswer, toggleOption } from './dispatch';

describe('提问卡多选', () => {
  it('多选可连续选中多个,再点取消', () => {
    let cur = toggleOption([], '山寨中转站风', true);
    cur = toggleOption(cur, '套模板的 AI SaaS 风', true);
    expect(cur).toEqual(['山寨中转站风', '套模板的 AI SaaS 风']);
    expect(toggleOption(cur, '山寨中转站风', true)).toEqual(['套模板的 AI SaaS 风']);
  });

  it('选项文案含顿号也不会被拆散', () => {
    const cur = toggleOption(toggleOption([], '紫、蓝渐变', true), '大数字', true);
    expect(cur).toEqual(['紫、蓝渐变', '大数字']);
    expect(toggleOption(cur, '紫、蓝渐变', true)).toEqual(['大数字']);
  });

  it('单选替换', () => {
    expect(toggleOption(['A'], 'B', false)).toEqual(['B']);
  });

  it('多选答案 = 选项 + 自定义并列;单选自定义覆盖选项', () => {
    expect(composeAnswer(['A', 'B'], ' 其他 ', true)).toBe('A、B、其他');
    expect(composeAnswer(['A', 'B'], '', true)).toBe('A、B');
    expect(composeAnswer(['A'], '自定义', false)).toBe('自定义');
    expect(composeAnswer([], '', true)).toBe('');
  });
});
