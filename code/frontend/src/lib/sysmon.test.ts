import { describe, expect, it } from 'vitest';
import { cpuChipLevel, cpuHigh, fmtCpu, fmtMem, memChipLevel, showMetric, sortGroups, sortProcs } from './sysmon';
import type { MonGroup } from '@/api/types';
import { DEFAULT_ACCOUNT, DEFAULT_LOCAL } from './prefs';

const MB = 1024 * 1024;

describe('系统监控 · 格式化(与原型同口径)', () => {
  it('内存:<1000M 显示 M,否则一位小数 G', () => {
    expect(fmtMem(348 * MB)).toBe('348M');
    expect(fmtMem(1348 * MB)).toBe('1.3G');
  });
  it('%CPU:≥100 取整,否则一位小数', () => {
    expect(fmtCpu(46)).toBe('46.0%');
    expect(fmtCpu(133.4)).toBe('133%');
  });
});

describe('系统监控 · 卡片数字判定', () => {
  it('内存 ≥1G 琥珀、≥3G 红', () => {
    expect(memChipLevel(900 * MB)).toBe('ok');
    expect(memChipLevel(1260 * MB)).toBe('warn');
    expect(memChipLevel(3 * 1024 * MB)).toBe('hot');
  });
  it('CPU 偏高 = 占整机 ≥ 黄阈值,或单会话 ≥ 50%', () => {
    expect(cpuHigh(13.2, 11, 60)).toBe(false); // IP 风险批量扫描:默认不显示,不挤标题
    expect(cpuHigh(50, 11, 60)).toBe(true);
    expect(cpuHigh(700, 11, 60)).toBe(true);
    expect(cpuChipLevel(97)).toBe('warn');
    expect(cpuChipLevel(320)).toBe('hot');
  });
  it('显示模式:始终 / 偏高时 / 不显示', () => {
    expect(showMetric('always', false)).toBe(true);
    expect(showMetric('high', false)).toBe(false);
    expect(showMetric('high', true)).toBe(true);
    expect(showMetric('off', true)).toBe(false);
  });
  it('默认值:内存始终、CPU 偏高时;监控默认值与后端一致', () => {
    expect([DEFAULT_LOCAL.cardMem, DEFAULT_LOCAL.cardCpu]).toEqual(['always', 'high']);
    expect(DEFAULT_ACCOUNT.monitor).toEqual({ mem: true, cpu: true, interval: 10, debounce: 2, pauseIdle: true, cpuWarn: 60, cpuCrit: 85 });
  });
});

describe('系统监控 · 排行排序', () => {
  const grp = (name: string, mem: number, cmprs: number, cpu: number, kind: MonGroup['kind'] = 'app'): MonGroup => ({
    key: name, name, kind, mem, cmprs, cpu,
    procs: [
      { pid: 1, ppid: 0, cmd: 'a', mem: mem / 4, cmprs: cmprs, cpu: 0 },
      { pid: 2, ppid: 0, cmd: 'b', mem: (mem * 3) / 4, cmprs: 0, cpu },
    ],
  });
  // 压缩+换出大但总占用小的应用,不再排第一
  const groups = [grp('Chrome', 15 * MB, 14 * MB, 5), grp('VS Code', 9 * MB, 9 * MB, 50), grp('WindowServer', 20 * MB, 1 * MB, 0), grp('claude(终端)', 0, 0, 0, 'terminal')];

  it('内存 tab 按总占用降序(不是压缩+换出);会话组即便为 0 也保留', () => {
    expect(sortGroups(groups, 'mem').map((g) => g.name)).toEqual(['WindowServer', 'Chrome', 'VS Code', 'claude(终端)']);
  });
  it('CPU tab 按 %CPU 降序,0% 的普通应用不列', () => {
    expect(sortGroups(groups, 'cpu').map((g) => g.name)).toEqual(['VS Code', 'Chrome', 'claude(终端)']);
  });
  it('组内进程同口径排序', () => {
    expect(sortProcs(groups[0]!.procs, 'mem').map((p) => p.pid)).toEqual([2, 1]);
    expect(sortProcs([{ mem: 1, cpu: 9 }, { mem: 9, cpu: 1 }], 'cpu')[0]!.cpu).toBe(9);
  });
});
