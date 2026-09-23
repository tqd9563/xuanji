/**
 * 系统监控采样器:按「设置 › 系统监控」的间隔跑 sysctl / vm_stat / top / ps,
 * 聚合成一份快照推给订阅者(/ws/sysmon)。只读系统信息,不碰 ~/.claude。
 *
 * 生命周期:有订阅者才采(pauseIdle 开时);第一个订阅者到来立即补采一次。
 * pauseIdle 关时进程启动后常驻采样。任一命令失败 → 快照 ok:false + 原因,前端显示「采样失败」。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentProcesses } from '../../adapters/agents-cli.js';
import { liveDispatches } from '../dispatch.js';
import { readPrefs, type MonitorPrefs } from '../prefs.js';
import type { Storage } from '../../storage/db.js';
import { parsePs, parseSysctl, parseTop, parseVmStat, type PsProc } from './parse.js';
import { groupProcs, sessionUsage, type MonGroup, type SessionRoot, type SessionUsage } from './group.js';
import { cpuLevel, cpuTips, Debouncer, memLevel, memTips, type Level, type Tip } from './rules.js';

const execFileP = promisify(execFile);

export interface MemSnap {
  /** 内核原始压力等级 1/2/4 */
  pressure: number;
  /** 防抖后的展示等级 */
  level: Level;
  total: number;
  /** 实际内存占用率(%)=(active + wired + 压缩器占用页)/ hw.memsize,整数 */
  usedPct: number;
  /** 应用占用 = active + wired */
  app: number;
  compressor: number;
  /** 可回收缓存 = inactive + purgeable + speculative */
  cache: number;
  free: number;
  swapUsed: number;
  swapTotal: number;
  swapins: number;
  swapouts: number;
  pageSize: number;
  tips: Tip[];
}

export interface CpuSnap {
  user: number;
  sys: number;
  idle: number;
  /** 用户 + 系统,四舍五入到整数 */
  used: number;
  level: Level;
  load: [number, number, number];
  ncpu: number;
  pcores: number | null;
  ecores: number | null;
  tips: Tip[];
}

export interface SysmonSnapshot {
  ok: boolean;
  /** 本次采样完成时刻 */
  at: number;
  interval: number;
  debounce: number;
  error?: string;
  /** 失败时:上次成功时刻 */
  lastOkAt?: number;
  mem: MemSnap | null;
  cpu: CpuSnap | null;
  /** 排行:按内存或 CPU 靠前的应用(前端按 tab 排序后展示),会话组恒在 */
  groups: MonGroup[];
  /** 全部进程合计,前端用来算「其余 N 个进程」 */
  totals: { procs: number; mem: number; cmprs: number; cpu: number };
  sessions: Record<string, SessionUsage>;
  /** 会话 id → agents CLI 名,排行里给进程行起名 */
  sessionNames: Record<string, string>;
}

type Runner = (cmd: string, args: string[]) => Promise<string>;

/** sysctl 对不存在的键(Intel 机没有 perflevel)返回非零,但其余键照常输出:取 stdout 不报错 */
const defaultRunner: Runner = async (cmd, args) => {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: 8_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (e: any) {
    if (cmd.endsWith('sysctl') && typeof e?.stdout === 'string' && e.stdout) return e.stdout;
    throw e;
  }
};

const LIST_LIMIT = 10;

export interface CollectInput {
  prefs: MonitorPrefs;
  run: Runner;
  sessions: () => Promise<SessionRoot[]>;
  memDeb: Debouncer;
  cpuDeb: Debouncer;
}

/** 状态栏占用率:可回收缓存与真空闲不算「占用」;swap 总量按需扩缩,不参与 */
export function memUsedPct(vm: { active: number; wired: number; compressor: number; pageSize: number }, memBytes: number): number {
  if (!memBytes) return 0;
  return Math.round((((vm.active + vm.wired + vm.compressor) * vm.pageSize) / memBytes) * 100);
}

/** 单次采样(与定时/订阅解耦,测试直接喂假 runner) */
export async function collect({ prefs, run, sessions, memDeb, cpuDeb }: CollectInput): Promise<SysmonSnapshot> {
  const [sysctlOut, vmOut, topOut, psComm, psArgs, roots] = await Promise.all([
    run('/usr/sbin/sysctl', [
      'kern.memorystatus_vm_pressure_level',
      'hw.memsize',
      'vm.swapusage',
      'hw.ncpu',
      'hw.perflevel0.logicalcpu',
      'hw.perflevel1.logicalcpu',
      'vm.loadavg',
    ]),
    prefs.mem ? run('/usr/bin/vm_stat', []) : Promise.resolve(''),
    run('/usr/bin/top', ['-l', '2', '-s', '1', '-stats', 'pid,ppid,command,mem,cmprs,cpu']),
    run('/bin/ps', ['-axo', 'pid=,ppid=,comm=']),
    run('/bin/ps', ['-axo', 'pid=,args=']),
    sessions().catch(() => [] as SessionRoot[]),
  ]);
  const sc = parseSysctl(sysctlOut);
  const top = parseTop(topOut);
  if (!top) throw new Error('top 输出无法解析');
  const ps = parsePs(psComm, psArgs);
  const groups = groupProcs(top.procs, ps, roots);
  const argsOf = (pid: number) => ps.get(pid)?.args ?? '';

  let mem: MemSnap | null = null;
  if (prefs.mem) {
    const vm = parseVmStat(vmOut);
    if (!vm || sc.pressureLevel === null || sc.memBytes === null) throw new Error('vm_stat / sysctl 输出无法解析');
    const pg = (n: number) => n * vm.pageSize;
    const level = memDeb.push(memLevel(sc.pressureLevel), prefs.debounce);
    const swapUsed = sc.swapUsed ?? 0;
    const swapTotal = sc.swapTotal ?? 0;
    mem = {
      pressure: sc.pressureLevel,
      level,
      total: sc.memBytes,
      usedPct: memUsedPct(vm, sc.memBytes),
      app: pg(vm.active + vm.wired),
      compressor: pg(vm.compressor),
      cache: pg(vm.inactive + vm.purgeable + vm.speculative),
      free: pg(vm.free),
      swapUsed,
      swapTotal,
      swapins: vm.swapins,
      swapouts: vm.swapouts,
      pageSize: vm.pageSize,
      // 压力正常且 swap 用量低:无需处理,不给建议
      tips: level === 'ok' && (swapTotal === 0 || swapUsed / swapTotal < 0.5) ? [] : memTips(groups, argsOf),
    };
  }

  let cpu: CpuSnap | null = null;
  if (prefs.cpu) {
    const used = Math.round(top.user + top.sys);
    const level = cpuDeb.push(cpuLevel(top.user + top.sys, prefs.cpuWarn, prefs.cpuCrit), prefs.debounce);
    cpu = {
      user: top.user,
      sys: top.sys,
      idle: top.idle,
      used,
      level,
      load: sc.load ?? top.load ?? [0, 0, 0],
      ncpu: sc.ncpu ?? 1,
      pcores: sc.pcores,
      ecores: sc.ecores,
      tips: cpuTips(groups, {
        memOn: !!mem,
        memLevel: mem?.level ?? 'ok',
        swapins: mem?.swapins ?? 0,
        swapouts: mem?.swapouts ?? 0,
        pageSize: mem?.pageSize ?? 16384,
      }),
    };
  }

  // 列表只下发前列应用(内存按压缩+换出、CPU 按 %CPU 各取前 N)与全部会话组,其余计入「其余进程」
  const keep = new Set<MonGroup>(groups.filter((g) => g.kind === 'dispatch' || g.kind === 'terminal'));
  // 内存 tab 按总占用排序;压缩+换出前列也保留(建议规则按它选对象,弹窗里要能找到)
  if (mem) [...groups].sort((a, b) => b.mem - a.mem).slice(0, LIST_LIMIT).forEach((g) => keep.add(g));
  if (mem) [...groups].sort((a, b) => b.cmprs - a.cmprs).slice(0, 3).forEach((g) => keep.add(g));
  if (cpu) [...groups].sort((a, b) => b.cpu - a.cpu).slice(0, LIST_LIMIT).forEach((g) => keep.add(g));
  const listed = [...keep].map((g) => ({ ...g, procs: [...g.procs].sort((x, y) => y.mem - x.mem || y.cpu - x.cpu) }));

  return {
    ok: true,
    at: Date.now(),
    interval: prefs.interval,
    debounce: prefs.debounce,
    mem,
    cpu,
    groups: listed,
    totals: {
      procs: top.procs.length,
      mem: top.procs.reduce((s, p) => s + p.mem, 0),
      cmprs: top.procs.reduce((s, p) => s + p.cmprs, 0),
      cpu: Math.round(top.procs.reduce((s, p) => s + p.cpu, 0) * 10) / 10,
    },
    sessions: sessionUsage(groups),
    sessionNames: Object.fromEntries(roots.map((r) => [r.sessionId, r.name])),
  };
}

/** agents CLI 给出的存活 claude 会话进程 → 会话根;父进程是本后端或在派发表里 = 璇玑派发 */
export async function sessionRoots(): Promise<SessionRoot[]> {
  const [agents, psOut] = await Promise.all([agentProcesses(), defaultRunner('/bin/ps', ['-axo', 'pid=,ppid=,comm='])]);
  const ps: Map<number, PsProc> = parsePs(psOut, '');
  const live = new Set(liveDispatches().map((d) => d.sessionId));
  const out: SessionRoot[] = [];
  for (const s of agents) {
    out.push({
      pid: s.pid,
      sessionId: s.sessionId,
      name: s.name,
      dispatch: live.has(s.sessionId) || ps.get(s.pid)?.ppid === process.pid,
    });
  }
  return out;
}

type Listener = (snap: SysmonSnapshot) => void;

export class SysmonSampler {
  private listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private last: SysmonSnapshot | null = null;
  private lastOkAt: number | undefined;
  private memDeb = new Debouncer();
  private cpuDeb = new Debouncer();

  constructor(
    private storage: Storage,
    private run: Runner = defaultRunner,
    private sessions: () => Promise<SessionRoot[]> = sessionRoots,
  ) {}

  private prefs(): MonitorPrefs {
    return readPrefs(this.storage).monitor;
  }

  latest(): SysmonSnapshot | null {
    return this.last;
  }

  /** pauseIdle 关闭时进程启动即常驻采样 */
  start() {
    this.reschedule(0);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.last) fn(this.last);
    // 连接时立即采一次:别让刚打开的页面干等一个完整间隔
    this.reschedule(0);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 设置变了(间隔、开关):丢掉在途定时,马上按新设置采一次 */
  prefsChanged() {
    this.memDeb.reset();
    this.cpuDeb.reset();
    this.reschedule(0);
  }

  private shouldRun(p: MonitorPrefs) {
    if (!p.mem && !p.cpu) return false;
    return !p.pauseIdle || this.listeners.size > 0;
  }

  private reschedule(delayMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.shouldRun(this.prefs())) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  async sampleOnce(): Promise<SysmonSnapshot> {
    const prefs = this.prefs();
    let snap: SysmonSnapshot;
    try {
      snap = await collect({ prefs, run: this.run, sessions: this.sessions, memDeb: this.memDeb, cpuDeb: this.cpuDeb });
      this.lastOkAt = snap.at;
    } catch (e) {
      snap = {
        ok: false,
        at: Date.now(),
        interval: prefs.interval,
        debounce: prefs.debounce,
        error: e instanceof Error ? e.message : String(e),
        lastOkAt: this.lastOkAt,
        mem: null,
        cpu: null,
        groups: [],
        totals: { procs: 0, mem: 0, cmprs: 0, cpu: 0 },
        sessions: {},
        sessionNames: {},
      };
    }
    this.last = snap;
    for (const fn of this.listeners) fn(snap);
    return snap;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    this.timer = null;
    try {
      await this.sampleOnce();
    } finally {
      this.running = false;
      this.reschedule(this.prefs().interval * 1000);
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
