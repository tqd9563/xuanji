import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentSession, SessionState } from '@/api/types';
import { setPalette } from '@/lib/utils';
import { matches, narrow, projectFacets, recalibrate, toggle } from '@/lib/proj-filter';

/** 最小可用的会话桩:只填过滤逻辑读到的字段。
 *  lastOutputAt 取「此刻之后」——isUnread 以首次调用时的 Date.now() 为基线,
 *  产出时间不晚于基线的一律算已读,桩数据不给这个字段则永远测不出未读。 */
function sess(sessionId: string, project: string, state: SessionState, unread = true): AgentSession {
  return {
    id: sessionId.slice(0, 8),
    sessionId,
    name: `会话 ${sessionId}`,
    project,
    cwd: `~/${project}`,
    state,
    kind: 'interactive',
    source: 'web',
    readonly: false,
    startedAt: 1_000,
    lastOutputAt: unread ? Date.now() + 60_000 : 1_000,
  } as AgentSession;
}

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

const emptyCols = (): Record<SessionState, AgentSession[]> => ({
  running: [],
  blocked: [],
  review: [],
  idle: [],
  done: [],
});

beforeEach(() => {
  localStorage.clear();
  setPalette({});
});

describe('projectFacets', () => {
  it('跨四列合计每个项目的会话数', () => {
    const cols = emptyCols();
    cols.running = [sess('a', 'xuanji', 'running'), sess('b', 'baize-web', 'running')];
    cols.review = [sess('c', 'xuanji', 'review')];
    cols.done = [sess('d', 'xuanji', 'done')];

    const facets = projectFacets(cols);
    expect(facets.map((f) => [f.name, f.total])).toEqual(
      expect.arrayContaining([
        ['xuanji', 3],
        ['baize-web', 1],
      ]),
    );
  });

  it('待验收数只算未读的卡(与看板角标同一判定)', () => {
    const cols = emptyCols();
    cols.review = [sess('a', 'xuanji', 'review'), sess('b', 'xuanji', 'review')];
    // 已完成态即便有新产出也不算待验收(isUnread 只对验收中生效)
    cols.done = [sess('c', 'xuanji', 'done')];

    const [xuanji] = projectFacets(cols);
    expect(xuanji!.total).toBe(3);
    expect(xuanji!.unread).toBe(2);
  });

  it('按调色板序号排序,顺序稳定不随会话数变化', () => {
    setPalette({ xuanji: 0, 'baize-web': 1, 'deep-baize': 2 });
    const cols = emptyCols();
    // deep-baize 会话最多,但排序只看调色板序号——chip 位置必须稳定
    cols.running = [sess('a', 'deep-baize', 'running'), sess('b', 'deep-baize', 'running'), sess('c', 'baize-web', 'running')];
    cols.review = [sess('d', 'xuanji', 'review')];

    expect(projectFacets(cols).map((f) => f.name)).toEqual(['xuanji', 'baize-web', 'deep-baize']);
  });

  it('未进调色板的项目垫底并按字典序排列', () => {
    setPalette({ xuanji: 0 });
    const cols = emptyCols();
    cols.running = [sess('a', 'zeta', 'running'), sess('b', 'alpha', 'running'), sess('c', 'xuanji', 'running')];

    expect(projectFacets(cols).map((f) => f.name)).toEqual(['xuanji', 'alpha', 'zeta']);
  });
});

describe('matches / narrow', () => {
  const items = [sess('a', 'xuanji', 'running'), sess('b', 'baize-web', 'running'), sess('c', 'xuanji', 'running')];

  it('空过滤集 = 全部命中(「全部」态)', () => {
    expect(narrow(items, new Set())).toHaveLength(3);
    expect(matches(items[0]!, new Set())).toBe(true);
  });

  it('多选取并集', () => {
    const active = new Set(['xuanji', 'baize-web']);
    expect(narrow(items, active)).toHaveLength(3);
  });

  it('只保留命中项目的会话', () => {
    expect(narrow(items, new Set(['xuanji'])).map((s) => s.sessionId)).toEqual(['a', 'c']);
    expect(matches(items[1]!, new Set(['xuanji']))).toBe(false);
  });
});

describe('toggle', () => {
  it('点未选的加入、点已选的移除,且不改入参', () => {
    const a = new Set(['xuanji']);
    const b = toggle(a, 'baize-web');
    expect([...b].sort()).toEqual(['baize-web', 'xuanji']);
    expect([...a]).toEqual(['xuanji']); // 入参未被改动

    expect([...toggle(b, 'xuanji')]).toEqual(['baize-web']);
  });
});

describe('recalibrate', () => {
  it('当前列仍有可达卡时只夹行号', () => {
    expect(recalibrate({ c: 1, r: 5 }, [3, 2, 0, 4])).toEqual({ c: 1, r: 1 });
    expect(recalibrate({ c: 0, r: 1 }, [3, 2, 0, 4])).toEqual({ c: 0, r: 1 });
  });

  it('当前列被过滤空时落到第一个有卡的列', () => {
    expect(recalibrate({ c: 2, r: 1 }, [0, 0, 0, 4])).toEqual({ c: 3, r: 1 });
    expect(recalibrate({ c: 0, r: 3 }, [0, 2, 0, 0])).toEqual({ c: 1, r: 1 });
  });

  it('全盘无可达卡则清空选中,不指向不存在的卡', () => {
    expect(recalibrate({ c: 1, r: 0 }, [0, 0, 0, 0])).toBeNull();
  });

  it('未选中时保持未选中', () => {
    expect(recalibrate(null, [3, 2, 1, 4])).toBeNull();
  });
});
