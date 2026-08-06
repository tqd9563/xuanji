import { describe, expect, it } from 'vitest';
import { canWrapup } from '../src/lib/utils';

/**
 * 「⚑ 任务总结」可用性判据的回归测试。
 * 2026-07-31 的缺陷:判据只看 started,后端一重启 attach 失败即清零,
 * 于是「从看板续接一个有 37 条历史的会话」时按钮是灰的、提示还说「会话还没开始」——
 * 而那恰恰是最该收口的状态(任务做完了、后端重启了、回头想补一张卡)。
 */
describe('canWrapup', () => {
  it('活着的会话可收口', () => {
    expect(canWrapup(true, false)).toBe(true);
  });

  it('后端重启后续接进来的会话可收口:上下文在 resume 目标里,不在 started 标志里', () => {
    expect(canWrapup(false, true)).toBe(true);
  });

  it('两者兼备当然可以(attach 成功后又设了续接目标)', () => {
    expect(canWrapup(true, true)).toBe(true);
  });

  it('全新空会话不可收口:没有任何可沉淀的上下文', () => {
    expect(canWrapup(false, false)).toBe(false);
  });
});
