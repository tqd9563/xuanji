import { beforeEach, describe, expect, it } from 'vitest';
import { isUnread, markSeen } from '../src/lib/utils';

/**
 * 「待验收」角标的作用域(2026-08-05)。
 *
 * 缺陷:角标与列曾用两套互不相干的基线——列按服务端启用基线决定是否进验收中,
 * 角标按浏览器本地已读表决定是否点亮。于是空闲列里的历史存量卡「列说不用管、
 * 角标说你没看过」;被显式挂起的卡更矛盾:你刚说了暂不处理,它还在喊待验收。
 * 现在角标只对验收中生效,催办信号单一来源。
 */
// 本项目前端 vitest 跑纯函数环境(无 jsdom),为 isUnread 依赖的已读表补最小 localStorage 垫片
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const card = (state: string, over: Partial<{ sessionId: string; readonly: boolean; lastOutputAt: number }> = {}) => ({
  sessionId: 'sess-' + state,
  state,
  readonly: false,
  lastOutputAt: Date.now(),
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  // 预置久远的已读基线,否则它会被钉在「此刻」——晚于卡片的 lastOutputAt,一切都算已读
  localStorage.setItem('xuanji-seen-baseline', '1000');
});

describe('isUnread 只作用于验收中', () => {
  it('验收中且没看过 → 亮角标', () => {
    expect(isUnread(card('review'))).toBe(true);
  });

  it('空闲卡不亮:处置过的结果不该再催办(挂起后自相矛盾的那一类)', () => {
    expect(isUnread(card('idle'))).toBe(false);
  });

  it('已完成卡不亮:归档即已验收', () => {
    expect(isUnread(card('done'))).toBe(false);
  });

  it('进行态不亮', () => {
    expect(isUnread(card('running'))).toBe(false);
    expect(isUnread(card('blocked'))).toBe(false);
  });

  it('看过之后熄灭(卡片仍在验收中,由列而非角标承载待处置语义)', () => {
    const s = card('review');
    expect(isUnread(s)).toBe(true);
    markSeen(s.sessionId);
    expect(isUnread(s)).toBe(false);
  });

  it('只读会话与无产出会话一律不亮', () => {
    expect(isUnread(card('review', { readonly: true }))).toBe(false);
    expect(isUnread(card('review', { lastOutputAt: undefined }))).toBe(false);
  });
});
