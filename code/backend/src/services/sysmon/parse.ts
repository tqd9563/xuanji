/**
 * 系统监控 · 命令输出解析(纯函数,fixture 可测)。
 *
 * 只解析 macOS 自带命令的公开输出格式(sysctl / vm_stat / top / ps),与 ~/.claude 无关,
 * 故不属于 Adapter 层。所有字节量统一为 bytes。
 */

export interface SysctlInfo {
  /** kern.memorystatus_vm_pressure_level:1 正常 / 2 警告 / 4 严重;读不到为 null */
  pressureLevel: number | null;
  memBytes: number | null;
  swapTotal: number | null;
  swapUsed: number | null;
  ncpu: number | null;
  pcores: number | null;
  ecores: number | null;
  load: [number, number, number] | null;
}

const MB = 1024 * 1024;

export function parseSysctl(text: string): SysctlInfo {
  const kv = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const int = (k: string) => {
    const v = kv.get(k);
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const swap = kv.get('vm.swapusage') ?? '';
  const sw = (name: string) => {
    const m = new RegExp(`${name}\\s*=\\s*([\\d.]+)([KMG])`).exec(swap);
    if (!m) return null;
    const mult = m[2] === 'G' ? 1024 * MB : m[2] === 'K' ? 1024 : MB;
    return Math.round(Number(m[1]) * mult);
  };
  const la = /\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/.exec(kv.get('vm.loadavg') ?? '');
  return {
    pressureLevel: int('kern.memorystatus_vm_pressure_level'),
    memBytes: int('hw.memsize'),
    swapTotal: sw('total'),
    swapUsed: sw('used'),
    ncpu: int('hw.ncpu'),
    pcores: int('hw.perflevel0.logicalcpu'),
    ecores: int('hw.perflevel1.logicalcpu'),
    load: la ? [Number(la[1]), Number(la[2]), Number(la[3])] : null,
  };
}

export interface VmStat {
  pageSize: number;
  free: number;
  active: number;
  inactive: number;
  speculative: number;
  wired: number;
  purgeable: number;
  compressor: number;
  swapins: number;
  swapouts: number;
}

/** vm_stat:页数 → 保留页数(由调用方乘 pageSize),另给 pageSize */
export function parseVmStat(text: string): VmStat | null {
  const ps = /page size of (\d+) bytes/.exec(text);
  if (!ps) return null;
  const get = (label: string) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  return {
    pageSize: Number(ps[1]),
    free: get('Pages free'),
    active: get('Pages active'),
    inactive: get('Pages inactive'),
    speculative: get('Pages speculative'),
    wired: get('Pages wired down'),
    purgeable: get('Pages purgeable'),
    compressor: get('Pages occupied by compressor'),
    swapins: get('Swapins'),
    swapouts: get('Swapouts'),
  };
}

export interface TopProc {
  pid: number;
  ppid: number;
  /** top 的 COMMAND 列(截断到 16 字符),仅作 ps 缺失时的兜底名 */
  command: string;
  mem: number;
  cmprs: number;
  /** %CPU,单核 100 */
  cpu: number;
}

export interface TopSample {
  user: number;
  sys: number;
  idle: number;
  load: [number, number, number] | null;
  procs: TopProc[];
}

/** top 的 MEM/CMPRS:`3314M` `425M+` `3744K-` `1.2G` `0B` */
export function parseSize(tok: string): number {
  const m = /^([\d.]+)([BKMGT])?[+-]?$/.exec(tok.trim());
  if (!m) return 0;
  const unit = { B: 1, K: 1024, M: MB, G: 1024 * MB, T: 1024 * 1024 * MB }[m[2] ?? 'B'] ?? 1;
  return Math.round(Number(m[1]) * unit);
}

/**
 * `top -l 2 -s 1 -stats pid,ppid,command,mem,cmprs,cpu`:取**最后一个**样本。
 * 第一个样本的 %CPU 是自开机累计口径,只有第二个样本才是 1 秒窗口的瞬时占用。
 */
export function parseTop(text: string): TopSample | null {
  const blocks = text.split(/^Processes:/m).slice(1);
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  const cpu = /CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/.exec(last);
  if (!cpu) return null;
  const la = /Load Avg:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(last);
  const lines = last.split('\n');
  const head = lines.findIndex((l) => /^PID\s+PPID\s+COMMAND/.test(l));
  const procs: TopProc[] = [];
  if (head >= 0) {
    for (const raw of lines.slice(head + 1)) {
      const t = raw.trim().split(/\s+/);
      if (t.length < 6) continue;
      const pid = parseInt(t[0]!, 10);
      const ppid = parseInt(t[1]!, 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      // COMMAND 可能含空格(「Google Chrome He」):首两列与末三列定位,中间拼回
      const cpuPct = Number(t[t.length - 1]);
      procs.push({
        pid,
        ppid,
        command: t.slice(2, t.length - 3).join(' '),
        mem: parseSize(t[t.length - 3]!),
        cmprs: parseSize(t[t.length - 2]!),
        cpu: Number.isFinite(cpuPct) ? cpuPct : 0,
      });
    }
  }
  return {
    user: Number(cpu[1]),
    sys: Number(cpu[2]),
    idle: Number(cpu[3]),
    load: la ? [Number(la[1]), Number(la[2]), Number(la[3])] : null,
    procs,
  };
}

export interface PsProc {
  pid: number;
  ppid: number;
  /** 可执行文件完整路径(可能含空格) */
  comm: string;
  /** 完整命令行(用于识别语言服务、脚本名) */
  args: string;
}

/** `ps -axo pid=,ppid=,comm=` 与 `ps -axo pid=,args=` 两份输出按 pid 合并 */
export function parsePs(commText: string, argsText: string): Map<number, PsProc> {
  const out = new Map<number, PsProc>();
  for (const line of commText.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    out.set(pid, { pid, ppid: Number(m[2]), comm: m[3]!.trim(), args: m[3]!.trim() });
  }
  for (const line of argsText.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const p = out.get(Number(m[1]));
    if (p) p.args = m[2]!.trim();
  }
  return out;
}
