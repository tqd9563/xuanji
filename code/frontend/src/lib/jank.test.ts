import { describe, expect, it } from 'vitest';
import { buildRecord, denseLateness, lateBy } from './jank';

describe('卡顿记录器', () => {
  it('心跳迟到量:早到或准时为 0', () => {
    expect(lateBy(1000, 1000)).toBe(0);
    expect(lateBy(990, 1000)).toBe(0);
    expect(lateBy(1700, 1000)).toBe(700);
  });

  it('记录只带冻结开始前 5s 内完成的请求与 1s 内的脚本归因', () => {
    const now = 20000;
    const rec = buildRecord(800, now, {
      view: 'sessions',
      visibility: 'visible',
      interaction: { kind: 'open-session', detail: { entry: 'drawer' }, at: 19000 },
      inflight: ['/api/sessions/7d802ce3/replay#ab12'],
      recent: [
        { url: '/api/prefs', ms: 12, doneAt: 13000 }, // 冻结开始(19200)前 6.2s,丢
        { url: '/api/sessions', ms: 40, doneAt: 15000 },
      ],
      scripts: [
        { at: 17000, desc: 'old' },
        { at: 18500, desc: '300ms render' },
      ],
      ua: 'ua',
    });
    expect(rec.stallMs).toBe(800);
    expect(rec.sinceInteractionMs).toBe(200);
    expect(rec.inflight).toEqual(['/api/sessions/7d802ce3/replay']);
    expect(rec.recent).toEqual([{ url: '/api/sessions', ms: 40 }]);
    expect(rec.scripts).toEqual(['300ms render']);
  });
});

describe('密集小卡顿', () => {
  it('只累计窗口内的迟到量', () => {
    const samples = [
      { at: 1000, late: 400 }, // 窗口外(now-3000=2000)
      { at: 2500, late: 300 },
      { at: 4900, late: 350 },
    ];
    expect(denseLateness(samples, 5000)).toBe(650);
    expect(denseLateness(samples, 5000, 1000)).toBe(350);
  });
});
