import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePs, parseSize, parseSysctl, parseTop, parseVmStat } from '../src/services/sysmon/parse.js';
import { appOf, displayName, DISPATCH_GROUP, groupProcs, sessionUsage, TERMINAL_GROUP } from '../src/services/sysmon/group.js';
import { cpuLevel, cpuTips, Debouncer, memLevel, memTips } from '../src/services/sysmon/rules.js';
import { collect, memUsedPct } from '../src/services/sysmon/sampler.js';
import { DEFAULT_PREFS, sanitize, writePrefs, readPrefs } from '../src/services/prefs.js';
import type { MonGroup } from '../src/services/sysmon/group.js';

/** 2026-09-23 本机真实采样(ps 已脱敏:只留可执行路径 + 首个非选项参数,家目录换成 /Users/u) */
const FX = path.join(import.meta.dirname, 'fixtures', 'sysmon');
const fx = (f: string) => fs.readFileSync(path.join(FX, f), 'utf8');
const GiB = 1024 ** 3;

describe('sysmon · 解析真实命令输出', () => {
  it('sysctl:压力等级 / 物理内存 / swap / 核心 / 负载', () => {
    const s = parseSysctl(fx('sysctl.txt'));
    expect(s.pressureLevel).toBe(2);
    expect(s.memBytes).toBe(19327352832); // 18G
    expect(s.swapTotal).toBe(14336 * 1024 * 1024);
    expect(s.swapUsed).toBe(Math.round(13156.81 * 1024 * 1024));
    expect([s.ncpu, s.pcores, s.ecores]).toEqual([11, 5, 6]);
    expect(s.load).toEqual([4.2, 5.5, 5.19]);
  });

  it('sysctl:Intel 机没有 perflevel 键时其余照常', () => {
    const s = parseSysctl('hw.ncpu: 8\nvm.loadavg: { 1.00 2.00 3.00 }\n');
    expect(s.ncpu).toBe(8);
    expect(s.pcores).toBeNull();
    expect(s.load).toEqual([1, 2, 3]);
  });

  it('vm_stat:页大小与各类页数', () => {
    const v = parseVmStat(fx('vm_stat.txt'))!;
    expect(v.pageSize).toBe(16384);
    expect(v).toMatchObject({ free: 9103, active: 242355, inactive: 240065, speculative: 1681, wired: 195001, purgeable: 514, compressor: 450843 });
    expect(v.swapins).toBe(62275869);
    expect(v.swapouts).toBe(66787937);
  });

  it('top:取第二个样本(瞬时口径),COMMAND 含空格也能对齐', () => {
    const t = parseTop(fx('top.txt'))!;
    expect(t).toMatchObject({ user: 15.95, sys: 9.53, idle: 74.51, load: [3.94, 5.42, 5.16] });
    expect(t.procs.length).toBeGreaterThan(400);
    const k = t.procs.find((p) => p.pid === 0)!;
    expect(k).toMatchObject({ command: 'kernel_task', cpu: 25.9, mem: 3744 * 1024, cmprs: 0 });
    const chrome = t.procs.find((p) => p.pid === 88299)!;
    expect(chrome).toMatchObject({ ppid: 1215, command: 'Google Chrome He', cpu: 24.9, mem: 268 * 1024 * 1024 });
  });

  it('top:PID 列带「*」标记也能解析', () => {
    const t = parseTop('Processes: 1\nCPU usage: 1.0% user, 2.0% sys, 97.0% idle\nPID PPID COMMAND MEM CMPRS %CPU\n158* 1 WindowServer 1139M+ 492M+ 25.3\n')!;
    expect(t.procs[0]).toMatchObject({ pid: 158, ppid: 1, mem: 1139 * 1024 * 1024, cmprs: 492 * 1024 * 1024 });
  });

  it('top 输出残缺 → null(上层据此报采样失败)', () => {
    expect(parseTop('garbage')).toBeNull();
  });

  it('size 单位', () => {
    expect(parseSize('0B')).toBe(0);
    expect(parseSize('1.5G')).toBe(1.5 * GiB);
    expect(parseSize('12K+')).toBe(12 * 1024);
  });
});

describe('sysmon · 进程树聚合', () => {
  const top = parseTop(fx('top.txt'))!;
  const ps = parsePs(fx('ps_comm.txt'), fx('ps_args.txt'));

  it('.app 包名归一:Chrome Helper 归 Google Chrome', () => {
    const groups = groupProcs(top.procs, ps, []);
    const chrome = groups.find((g) => g.name === 'Google Chrome')!;
    expect(chrome.kind).toBe('app');
    expect(chrome.procs.some((p) => p.pid === 88299)).toBe(true);
    expect(chrome.procs.length).toBeGreaterThan(3);
  });

  it('launchd 直属系统服务单列,kernel_task 单列', () => {
    const groups = groupProcs(top.procs, ps, []);
    expect(groups.find((g) => g.name === 'WindowServer')?.kind).toBe('system');
    expect(groups.find((g) => g.name === 'kernel_task')?.procs.map((p) => p.pid)).toEqual([0]);
  });

  it('会话子树:派发 / 终端分组,会话合计进程树', () => {
    const sessions = [
      { pid: 74359, sessionId: 'aaa', name: 'xuanji-33', dispatch: true },
      { pid: 84565, sessionId: 'bbb', name: 'xuanji-db', dispatch: false },
    ];
    const groups = groupProcs(top.procs, ps, sessions);
    const d = groups.find((g) => g.name === DISPATCH_GROUP)!;
    const t = groups.find((g) => g.name === TERMINAL_GROUP)!;
    expect(d.kind).toBe('dispatch');
    expect(d.procs.every((p) => p.sessionId === 'aaa')).toBe(true);
    expect(t.procs.some((p) => p.pid === 84565 && p.sessionId === 'bbb')).toBe(true);
    const u = sessionUsage(groups);
    expect(u.aaa!.mem).toBe(d.procs.reduce((s, p) => s + p.mem, 0));
    // 会话进程不再重复出现在其它应用组里
    const all = groups.flatMap((g) => g.procs.map((p) => p.pid));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(top.procs.length);
  });

  it('展示名:解释器补脚本名;appOf 取最外层 .app', () => {
    expect(displayName({ pid: 1, ppid: 1, comm: '/usr/bin/python3', args: '/usr/bin/python3 -u /x/scan_ip.py --fast' }, 'python3')).toBe('python3 scan_ip.py');
    expect(displayName({ pid: 1, ppid: 1, comm: '/bin/zsh', args: "/bin/zsh -c source /x/snap.sh && ls" }, 'zsh')).toBe('zsh');
    expect(appOf({ pid: 2, ppid: 1, comm: '/Applications/Google Chrome.app/Contents/Frameworks/X.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)', args: '' }, 2, '').name).toBe('Google Chrome');
  });
});

describe('sysmon · 判色与防抖', () => {
  it('内核压力等级映射', () => {
    expect([memLevel(1), memLevel(2), memLevel(4)]).toEqual(['ok', 'warn', 'crit']);
  });
  it('CPU 阈值', () => {
    expect(cpuLevel(59.9, 60, 85)).toBe('ok');
    expect(cpuLevel(60, 60, 85)).toBe('warn');
    expect(cpuLevel(85, 60, 85)).toBe('crit');
  });
  it('连续 N 次才切换,首个样本直接生效', () => {
    const d = new Debouncer();
    expect(d.push('ok', 2)).toBe('ok');
    expect(d.push('warn', 2)).toBe('ok');
    expect(d.push('warn', 2)).toBe('warn');
    expect(d.push('ok', 2)).toBe('warn');
    expect(d.push('crit', 2)).toBe('warn'); // 中途换目标,计数重来
    expect(d.push('crit', 2)).toBe('crit');
    expect(d.push('ok', 1)).toBe('ok');
  });
});

describe('sysmon · 建议规则', () => {
  const g = (o: Partial<MonGroup>): MonGroup => ({ key: o.name!, name: '', kind: 'app', mem: 0, cmprs: 0, cpu: 0, procs: [], ...o });
  const ctx = { memOn: true, memLevel: 'warn' as const, swapins: 61357179, swapouts: 65889152, pageSize: 16384 };
  const chrome = g({ name: 'Google Chrome', cpu: 53, procs: [{ pid: 5521, ppid: 1, cmd: 'Google Chrome Helper (Renderer)', mem: 0, cmprs: 0, cpu: 46 }] });
  const kernel = g({ name: 'kernel_task', kind: 'system', cpu: 26.6, procs: [{ pid: 0, ppid: 0, cmd: 'kernel_task', mem: 0, cmprs: 0, cpu: 26.6 }] });

  it('chrome-tab + kernel-swap(带跳内存)', () => {
    const tips = cpuTips([kernel, chrome], ctx);
    expect(tips.map((t) => t.rule)).toEqual(['chrome-tab', 'kernel-swap']);
    expect(tips[1]!.jump).toBe('mem');
    expect(JSON.stringify(tips[1]!.parts)).toContain('开机累计换入 936G / 换出 1005G');
  });
  it('内存正常 → kernel-thermal;内存监控关 → kernel-nomem', () => {
    expect(cpuTips([kernel], { ...ctx, memLevel: 'ok' })[0]!.rule).toBe('kernel-thermal');
    expect(cpuTips([kernel], { ...ctx, memOn: false })[0]!.rule).toBe('kernel-nomem');
  });
  it('低占用不出建议', () => {
    expect(cpuTips([g({ name: 'Lark', cpu: 12 })], ctx)).toEqual([]);
  });
  it('内存:语言服务 / Chrome / 派发会话 / 兜底', () => {
    const vs = g({ name: 'Visual Studio Code', cmprs: 6 * GiB, procs: [{ pid: 9, ppid: 1, cmd: 'Code Helper (Plugin)', mem: 0, cmprs: 3 * GiB, cpu: 0 }] });
    const d = g({ name: DISPATCH_GROUP, kind: 'dispatch', cmprs: 1 * GiB });
    expect(memTips([vs, chrome], (pid) => (pid === 9 ? '/x/Code Helper (Plugin) pylance' : '')).map((t) => t.rule)).toEqual(['vscode-lang-server', 'chrome']);
    expect(memTips([d, g({ name: 'Lark', cmprs: 1 })], () => '').map((t) => t.rule)).toEqual(['xuanji-session', 'fallback']);
    const ab = g({ name: 'agent-browser-darwin-arm64', kind: 'system', cmprs: GiB, procs: [{ pid: 3, ppid: 2, cmd: 'Google Chrome for Testing Helper (Renderer)', mem: 0, cmprs: GiB, cpu: 0 }] });
    expect(memTips([ab], () => '')[0]!.rule).toBe('chrome-for-testing');
  });
});

describe('sysmon · 单次采样(假 runner 喂真实输出)', () => {
  const runner = async (cmd: string, args: string[]) => {
    if (cmd.endsWith('sysctl')) return fx('sysctl.txt');
    if (cmd.endsWith('vm_stat')) return fx('vm_stat.txt');
    if (cmd.endsWith('top')) return fx('top.txt');
    if (cmd.endsWith('ps')) return args[1]!.includes('comm') ? fx('ps_comm.txt') : fx('ps_args.txt');
    throw new Error(cmd);
  };
  const deb = () => ({ memDeb: new Debouncer(), cpuDeb: new Debouncer() });

  it('四段物理内存 = vm_stat 换算;CPU 用户+系统', async () => {
    const s = await collect({ prefs: DEFAULT_PREFS.monitor, run: runner, sessions: async () => [], ...deb() });
    const pg = 16384;
    expect(s.mem).toMatchObject({
      pressure: 2,
      level: 'warn',
      app: (242355 + 195001) * pg,
      compressor: 450843 * pg,
      cache: (240065 + 514 + 1681) * pg,
      free: 9103 * pg,
    });
    // 占用率 = (active + wired + 压缩器) / hw.memsize:(242355+195001+450843)×16384 / 19327352832 = 75.3%
    expect(s.mem!.usedPct).toBe(75);
    expect(s.mem!.usedPct).toBe(memUsedPct({ active: 242355, wired: 195001, compressor: 450843, pageSize: pg }, 19327352832));
    expect(s.cpu).toMatchObject({ user: 15.95, sys: 9.53, used: 25, level: 'ok', ncpu: 11, pcores: 5, ecores: 6 });
    expect(s.groups.length).toBeGreaterThan(5);
    expect(s.totals.procs).toBeGreaterThan(400);
  });

  it('关闭内存监控:不跑 vm_stat,mem 为空', async () => {
    const calls: string[] = [];
    const s = await collect({
      prefs: { ...DEFAULT_PREFS.monitor, mem: false },
      run: async (c, a) => (calls.push(c), runner(c, a)),
      sessions: async () => [],
      ...deb(),
    });
    expect(s.mem).toBeNull();
    expect(calls.some((c) => c.endsWith('vm_stat'))).toBe(false);
  });

  it('命令失败向上抛(采样器据此出错误态)', async () => {
    await expect(
      collect({ prefs: DEFAULT_PREFS.monitor, run: async () => 'nope', sessions: async () => [], ...deb() }),
    ).rejects.toThrow();
  });
});

describe('sysmon · 设置项校验', () => {
  it('非法间隔/防抖回退;黄 ≥ 红整对拒绝', () => {
    const p = sanitize({ monitor: { interval: 7, debounce: 9, cpuWarn: 90, cpuCrit: 85, mem: false } });
    expect(p.monitor).toMatchObject({ interval: 10, debounce: 2, cpuWarn: 60, cpuCrit: 85, mem: false });
    expect(sanitize({ monitor: { interval: 30, cpuWarn: 70, cpuCrit: 90 } }).monitor).toMatchObject({ interval: 30, cpuWarn: 70, cpuCrit: 90 });
  });
  it('patch 语义:改一项不动其它', () => {
    const meta = new Map<string, string>();
    const storage = { getMeta: (k: string) => meta.get(k) ?? null, setMeta: (k: string, v: string) => void meta.set(k, v) } as any;
    writePrefs(storage, { monitor: { interval: 60 } });
    writePrefs(storage, { monitor: { pauseIdle: false } });
    expect(readPrefs(storage).monitor).toMatchObject({ interval: 60, pauseIdle: false, cpu: true });
  });
});

describe('sysmon · agents CLI 的 interactive 条目(无 id 字段)也能认出会话进程', () => {
  it('按 pid 取会话,跳过无 pid 的后台条目与已退出进程', async () => {
    const { agentProcessesFrom } = await import('../src/adapters/agents-cli.js');
    // 2026-09-23 真实输出形状:interactive 条目有 pid 无 id;background 条目有 id 无 pid
    const raw = [
      { id: 'b916dfc2', cwd: '/x', kind: 'background', startedAt: 1, sessionId: 'b916', name: 'bg', state: 'blocked' },
      { pid: 74359, cwd: '/x', kind: 'interactive', startedAt: 1, sessionId: '31e7', name: 'xuanji-33', status: 'busy' },
      { pid: 99999, cwd: '/x', kind: 'interactive', startedAt: 1, sessionId: 'dead', name: 'gone', status: 'idle' },
    ];
    expect(agentProcessesFrom(raw, (pid) => pid === 74359)).toEqual([{ pid: 74359, sessionId: '31e7', name: 'xuanji-33' }]);
  });
});

describe('sysmon · 内存占用率', () => {
  it('不含可回收缓存与真空闲;memsize 缺失为 0', () => {
    const GiBp = GiB / 16384;
    expect(memUsedPct({ active: 6 * GiBp, wired: 3 * GiBp, compressor: 0, pageSize: 16384 }, 18 * GiB)).toBe(50);
    expect(memUsedPct({ active: 1, wired: 1, compressor: 1, pageSize: 16384 }, 0)).toBe(0);
  });
});
