/**
 * 系统监控 · 进程树聚合:进程 → 应用 / 会话。
 *
 * 规则(确定性):
 * 1. 会话优先:进程若在某个 claude 会话进程(agents CLI 给出 pid)的子树里,归到该会话;
 *    会话是璇玑派发的(父进程是本后端,或 sessionId 在进程内派发表里)归「claude(璇玑派发)」,
 *    其余归「claude(终端)」。
 * 2. 其余进程沿 ppid 上溯到 launchd(pid 1)直属的那一层作为根:根路径里含 `X.app/` 即归应用 X
 *    (取最外层 .app,Chrome Helper 归 Google Chrome);不含 .app 的 launchd 直属系统服务按可执行名单列。
 * 3. kernel_task(pid 0)单列。同名根合并。
 */
import type { PsProc, TopProc } from './parse.js';

export type GroupKind = 'app' | 'system' | 'dispatch' | 'terminal';

export interface MonProc {
  pid: number;
  ppid: number;
  /** 展示名:可执行文件名;解释器进程带上脚本名(python3 scan_ip.py) */
  cmd: string;
  mem: number;
  cmprs: number;
  cpu: number;
  /** 所属 claude 会话 */
  sessionId?: string;
}

export interface MonGroup {
  key: string;
  name: string;
  kind: GroupKind;
  mem: number;
  cmprs: number;
  cpu: number;
  procs: MonProc[];
}

export interface SessionRoot {
  pid: number;
  sessionId: string;
  name: string;
  dispatch: boolean;
}

export const DISPATCH_GROUP = 'claude(璇玑派发)';
export const TERMINAL_GROUP = 'claude(终端)';

const INTERPRETERS = /^(node|python\d*(\.\d+)?|ruby|bun|deno|perl|bash|zsh|sh)$/;

function basename(p: string): string {
  const s = p.replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1) || s;
}

/** 展示名:ps comm 的文件名;解释器进程补第一个非选项参数的文件名 */
export function displayName(ps: PsProc | undefined, topCmd: string): string {
  if (!ps) return topCmd;
  const exe = basename(ps.comm);
  if (INTERPRETERS.test(exe)) {
    // args 的首段就是 comm 本身(可能含空格),截掉它再找脚本
    const rest = ps.args.startsWith(ps.comm) ? ps.args.slice(ps.comm.length) : ps.args.split(/\s+/).slice(1).join(' ');
    // `zsh -c '…'` / `node -e …` 跑的是内联代码,没有脚本名可补
    if (/(^|\s)-[ce](\s|$)/.test(rest)) return exe;
    const script = rest
      .trim()
      .split(/\s+/)
      .find((a) => a && !a.startsWith('-'));
    if (script) return `${exe} ${basename(script)}`;
  }
  return exe;
}

/** 根进程 → 应用名与类别 */
export function appOf(ps: PsProc | undefined, pid: number, topCmd: string): { name: string; kind: GroupKind } {
  if (pid === 0) return { name: 'kernel_task', kind: 'system' };
  const path = ps?.comm ?? '';
  const m = /\/([^/]+)\.app\//.exec(path + '/');
  if (m) return { name: m[1]!, kind: 'app' };
  return { name: ps ? basename(ps.comm) : topCmd, kind: 'system' };
}

export function groupProcs(
  top: TopProc[],
  ps: Map<number, PsProc>,
  sessions: SessionRoot[],
): MonGroup[] {
  const ppidOf = (pid: number) => ps.get(pid)?.ppid ?? top.find((t) => t.pid === pid)?.ppid ?? 1;
  const sessByPid = new Map(sessions.map((s) => [s.pid, s]));
  const groups = new Map<string, MonGroup>();

  for (const t of top) {
    let session: SessionRoot | undefined;
    let root = t.pid;
    // 上溯:先撞到会话根就归会话;否则停在 launchd 直属那一层
    for (let cur = t.pid, guard = 0; guard < 64; guard++) {
      const hit = sessByPid.get(cur);
      if (hit) {
        session = hit;
        break;
      }
      const pp = ppidOf(cur);
      if (cur === 0 || pp <= 1 || pp === cur) {
        root = cur;
        break;
      }
      cur = pp;
    }
    let key: string;
    let name: string;
    let kind: GroupKind;
    if (session) {
      kind = session.dispatch ? 'dispatch' : 'terminal';
      key = name = session.dispatch ? DISPATCH_GROUP : TERMINAL_GROUP;
    } else {
      ({ name, kind } = appOf(ps.get(root), root, t.command));
      key = `${kind}:${name}`;
    }
    let g = groups.get(key);
    if (!g) {
      g = { key, name, kind, mem: 0, cmprs: 0, cpu: 0, procs: [] };
      groups.set(key, g);
    }
    const proc: MonProc = {
      pid: t.pid,
      ppid: t.ppid,
      cmd: t.pid === 0 ? 'kernel_task' : displayName(ps.get(t.pid), t.command),
      mem: t.mem,
      cmprs: t.cmprs,
      cpu: t.cpu,
    };
    if (session) proc.sessionId = session.sessionId;
    g.procs.push(proc);
    g.mem += t.mem;
    g.cmprs += t.cmprs;
    g.cpu += t.cpu;
  }
  for (const g of groups.values()) g.cpu = Math.round(g.cpu * 10) / 10;
  return [...groups.values()];
}

export interface SessionUsage {
  mem: number;
  cmprs: number;
  cpu: number;
  procs: { pid: number; cmd: string; mem: number; cpu: number }[];
}

/** 每个会话的进程树合计(卡片数字的数据源) */
export function sessionUsage(groups: MonGroup[]): Record<string, SessionUsage> {
  const out: Record<string, SessionUsage> = {};
  for (const g of groups) {
    for (const p of g.procs) {
      if (!p.sessionId) continue;
      const u = (out[p.sessionId] ??= { mem: 0, cmprs: 0, cpu: 0, procs: [] });
      u.mem += p.mem;
      u.cmprs += p.cmprs;
      u.cpu = Math.round((u.cpu + p.cpu) * 10) / 10;
      u.procs.push({ pid: p.pid, cmd: p.cmd, mem: p.mem, cpu: p.cpu });
    }
  }
  return out;
}
