import { describe, expect, it, vi } from 'vitest';
import { getSeenVersion, isUnread, markSeen, subscribeSeen } from '@/lib/utils';

// 纯函数环境(无 jsdom),补 isUnread/markSeen 依赖的已读表垫片
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

const sess = (sessionId: string, lastOutputAt: number) => ({ sessionId, state: 'review', readonly: false, lastOutputAt });

describe('已读表的订阅通道', () => {
  it('markSeen 会推版本号并通知订阅者(消费方靠它当帧重渲染)', () => {
    const seen: number[] = [];
    const off = subscribeSeen(() => seen.push(getSeenVersion()));
    const before = getSeenVersion();
    const t0 = Date.now();
    // 产出晚于基线 = 未读;markSeen 的时刻再往后推一分钟,于是产出早于「你看它的时间」= 已读
    expect(isUnread(sess('s-1', t0 + 1_000))).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 60_000);
    markSeen('s-1');
    expect(isUnread(sess('s-1', t0 + 1_000))).toBe(false);
    vi.restoreAllMocks();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(before + 1);
    off();
    markSeen('s-2');
    expect(seen).toHaveLength(1); // 注销后不再收到
  });
});

/**
 * 「待验收」角标与未读排顶都由 isUnread 现算,而已读表写在 localStorage 里、不经过 React。
 * 渲染里调用 isUnread 的视图若不订阅已读表,markSeen 之后要等下一个 5s 轮询刻度才熄灭角标
 * ——从会话退回看板时肉眼可见「角标滞留约 1s、卡片随后才下沉」(2026-09-20 用户反馈)。
 * 故用扫源码的守卫钉住:凡在视图里用 isUnread,必须同时用 useSeenVersion。
 */
const VIEWS = import.meta.glob('../views/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

describe('isUnread 的消费方都订阅了已读表', () => {
  it.each(Object.entries(VIEWS).filter(([, src]) => /\bisUnread\(/.test(src)))(
    '%s 调用了 useSeenVersion',
    (_file, src) => {
      expect(src).toMatch(/useSeenVersion\(\)/);
    },
  );
});
