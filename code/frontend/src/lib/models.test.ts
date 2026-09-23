import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  defaultEffortOf,
  findModel,
  looksLikeModelId,
  modelDetail,
  modelLabel,
  normalizeModelValue,
  toSdkModel,
  type ModelOption,
} from './models';

/**
 * 模型目录的值域约定(lib/models.ts):选项值是目录行的 value(别名),持久化的旧值可能是
 * 升级前的完整 id,得能反查回目录行;目录里没有但长得像完整 id 的当手输值保留 —— 这是
 * 「目录只列 CLI 想展示的几行,200K opus 之类仍可用」的旁路。
 */
const CAT: ModelOption[] = [
  { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5.5 1M' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: '' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: '' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '' },
];

describe('findModel / normalizeModelValue', () => {
  it('按 value、resolvedModel、显示名(不分大小写)都能命中同一行', () => {
    expect(findModel(CAT, 'sonnet')?.value).toBe('sonnet');
    expect(findModel(CAT, 'claude-sonnet-5')?.value).toBe('sonnet');
    expect(findModel(CAT, 'Fable')?.value).toBe('claude-fable-5-1[1m]');
    expect(findModel(CAT, 'claude-fable-5-1')?.value).toBe('claude-fable-5-1[1m]');
  });

  it('升级前存的完整 id 命中新目录行时归一成别名,之后跟着 CLI 升级走', () => {
    expect(normalizeModelValue(CAT, 'claude-sonnet-5')).toBe('sonnet');
    // 同一真实 id 被多行解析到时取第一行(default 排最前 = CLI 的推荐)
    expect(normalizeModelValue(CAT, 'claude-opus-5-5[1m]')).toBe('default');
  });

  it('不在目录但长得像完整 id → 原样保留(手输旁路);其余 → null 让调用方回落默认', () => {
    expect(normalizeModelValue(CAT, 'claude-opus-5[1m]')).toBe('claude-opus-5[1m]');
    expect(normalizeModelValue(CAT, 'claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeModelValue(CAT, 'gpt-5')).toBeNull();
    expect(normalizeModelValue(CAT, '(默认)')).toBeNull();
    expect(normalizeModelValue(CAT, '')).toBeNull();
    expect(normalizeModelValue(CAT, undefined)).toBeNull();
  });

  it('looksLikeModelId 只认 claude- 前缀,可带 [1m]', () => {
    expect(looksLikeModelId('claude-opus-5[1m]')).toBe(true);
    expect(looksLikeModelId('claude-haiku-4-5-20251001')).toBe(true);
    expect(looksLikeModelId('opus')).toBe(false);
    expect(looksLikeModelId('claude-opus-5 x')).toBe(false);
  });
});

describe('展示与下发', () => {
  it('default 行不传 model 给 SDK,其余原样', () => {
    expect(toSdkModel(DEFAULT_MODEL)).toBeUndefined();
    expect(toSdkModel('opus[1m]')).toBe('opus[1m]');
    expect(toSdkModel('claude-opus-5')).toBe('claude-opus-5');
  });

  it('左列显示名、右列真实 id;手输值两列都是它自己', () => {
    expect(modelLabel(CAT, 'opus[1m]')).toBe('Opus (1M context)');
    expect(modelDetail(CAT, 'opus[1m]')).toBe('claude-opus-5-5[1m]');
    expect(modelLabel(CAT, 'claude-opus-5')).toBe('claude-opus-5');
    expect(modelDetail(CAT, 'claude-opus-5')).toBe('claude-opus-5');
  });

  it('「自动」思考档:解析到 opus 的行(含 default 别名与手输 id)→ low,其余不下发', () => {
    expect(defaultEffortOf(CAT, 'default')).toBe('low');
    expect(defaultEffortOf(CAT, 'opus[1m]')).toBe('low');
    expect(defaultEffortOf(CAT, 'claude-opus-5')).toBe('low');
    expect(defaultEffortOf(CAT, 'sonnet')).toBeUndefined();
    expect(defaultEffortOf(CAT, 'claude-fable-5-1[1m]')).toBeUndefined();
  });
});
