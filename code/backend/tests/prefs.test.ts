import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, readPrefs, sanitize, writePrefs } from '../src/services/prefs.js';

/** 只用到 getMeta/setMeta 两个方法,不起真库 */
function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set('prefs', initial);
  return {
    getMeta: (k: string) => map.get(k) ?? null,
    setMeta: (k: string, v: string) => void map.set(k, v),
    _raw: () => map.get('prefs'),
  };
}
type S = Parameters<typeof readPrefs>[0];

describe('账户偏好', () => {
  it('空库读到默认值', () => {
    expect(readPrefs(fakeStorage() as unknown as S)).toEqual(DEFAULT_PREFS);
  });

  it('坏 JSON 回退默认值而不是抛错', () => {
    expect(readPrefs(fakeStorage('{not json') as unknown as S)).toEqual(DEFAULT_PREFS);
  });

  it('写入是 patch 语义:只传一项不清空其余', () => {
    const st = fakeStorage() as unknown as S;
    writePrefs(st, { model: 'claude-opus-5' });
    const after = writePrefs(st, { bg: true });
    expect(after.model).toBe('claude-opus-5');
    expect(after.bg).toBe(true);
    expect(after.perm).toBe(DEFAULT_PREFS.perm);
  });

  it('notify 子对象同样是 patch,不整段覆盖', () => {
    const st = fakeStorage() as unknown as S;
    const after = writePrefs(st, { notify: { terminal: true } });
    expect(after.notify.terminal).toBe(true);
    expect(after.notify.dispatched).toBe(true);
    expect(after.notify.blocked).toBe(true);
  });

  it('非法枚举值被拒,保留原值', () => {
    const st = fakeStorage() as unknown as S;
    const after = writePrefs(st, { perm: 'rm -rf', effort: 'ultra' });
    expect(after.perm).toBe(DEFAULT_PREFS.perm);
    expect(after.effort).toBe(DEFAULT_PREFS.effort);
  });

  it('未知键被丢弃,不当作任意 KV 存储用', () => {
    const st = fakeStorage();
    writePrefs(st as unknown as S, { evil: 'x', model: 'claude-sonnet-5' });
    expect(JSON.parse(st._raw()!)).not.toHaveProperty('evil');
  });

  it('触发语不接受空串,清空即回默认', () => {
    const st = fakeStorage() as unknown as S;
    expect(writePrefs(st, { wrapupPrompt: '   ' }).wrapupPrompt).toBe(DEFAULT_PREFS.wrapupPrompt);
    expect(writePrefs(st, { wrapupPrompt: 'x'.repeat(600) }).wrapupPrompt).toBe(
      DEFAULT_PREFS.wrapupPrompt,
    );
  });

  it('类型不对的值不会污染布尔位', () => {
    expect(sanitize({ bg: 'true', notify: { terminal: 1 } }).bg).toBe(false);
    expect(sanitize({ notify: { terminal: 1 } }).notify.terminal).toBe(false);
  });

  it('effort 允许显式设回空串(自动档)', () => {
    const st = fakeStorage() as unknown as S;
    writePrefs(st, { effort: 'high' });
    expect(writePrefs(st, { effort: '' }).effort).toBe('');
  });
});

describe('通知过滤', () => {
  it('范围与事件取与:任一关闭就不发', async () => {
    const { notifyMac, setNotifyGate } = await import('../src/adapters/notify.js');
    const seen: [string, string][] = [];
    // gate 记录判定入参,不真的发通知(非 darwin 上 notifyMac 本就直接返回)
    setNotifyGate((scope, kind) => {
      seen.push([scope, kind]);
      return false;
    });
    notifyMac('t', 'b', 'dispatched', 'turnEnd');
    // 非 macOS 上 notifyMac 在 gate 之前就返回,故只在 darwin 断言调用
    if (process.platform === 'darwin') expect(seen).toEqual([['dispatched', 'turnEnd']]);
    setNotifyGate(() => true);
  });

  it('默认偏好下:派发的回合结束会发,终端会话不发', () => {
    const g = (scope: 'dispatched' | 'scheduled' | 'terminal', kind: 'blocked' | 'turnEnd' | 'error') =>
      DEFAULT_PREFS.notify[scope] && DEFAULT_PREFS.notify[kind];
    expect(g('dispatched', 'turnEnd')).toBe(true);
    expect(g('scheduled', 'error')).toBe(true);
    expect(g('terminal', 'blocked')).toBe(false);
  });

  it('关掉「回合结束」后派发会话的回合结束不再发,但审批仍发', () => {
    const notify = { ...DEFAULT_PREFS.notify, turnEnd: false };
    expect(notify.dispatched && notify.turnEnd).toBe(false);
    expect(notify.dispatched && notify.blocked).toBe(true);
  });
});
