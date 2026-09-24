/**
 * 全局终端:在本机起用户自己的登录 shell(node-pty),经 /ws/terminal 与前端 xterm.js 对接。
 *
 * 与 product-plan「不做 PTY 包装 claude TUI」不冲突:这里是通用 shell,不 attach、不接管任何
 * claude 会话(见 findings.md 2026-09-24 决策)。
 *
 * 会话生命周期跟后端进程走,不跟页面走:刷新页面、切视图、收起浮层都不杀 shell,
 * 重新连上时回放最近输出。只有用户关标签或 shell 自己退出才结束。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { IPty } from 'node-pty';
import { readGhosttyCommandSync, splitCommand } from '../adapters/ghostty.js';

const require = createRequire(import.meta.url);

/** 回放缓冲上限:够装下一屏半的 `git log`,又不至于让每个标签常驻几 MB */
const REPLAY_MAX = 256 * 1024;
export const MAX_SESSIONS = 12;

export interface TermSessionInfo {
  id: string;
  cwd: string;
  createdAt: number;
  /** 前台进程名(shell 自己在前台时就是 shell 名) */
  proc: string;
  /** 前台是否有 shell 之外的程序在跑 */
  busy: boolean;
  exited: boolean;
}

export interface TermClient {
  send(msg: TermServerMsg): void;
}

export type TermServerMsg =
  | { t: 'replay'; d: string }
  | { t: 'out'; d: string }
  | { t: 'status'; proc: string; busy: boolean; cwd: string }
  | { t: 'exit'; code: number };

interface Session {
  info: TermSessionInfo;
  pty: IPty;
  shellName: string;
  buf: string[];
  bufLen: number;
  clients: Set<TermClient>;
}

/* ---------------- 进程环境 ---------------- */

/**
 * node-pty 1.1.0 的 darwin 预编译包里 spawn-helper 没有执行位(经 pnpm 解包后 -rw-r--r--),
 * 结果是每次 spawn 都抛「posix_spawnp failed」。首次 spawn 前自愈,不依赖安装脚本。
 */
let helperChecked = false;
export function ensureSpawnHelper(): void {
  if (helperChecked || process.platform !== 'darwin') return;
  helperChecked = true;
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    for (const dir of [path.join(root, 'prebuilds', `darwin-${process.arch}`), path.join(root, 'build', 'Release')]) {
      const helper = path.join(dir, 'spawn-helper');
      if (!fs.existsSync(helper)) continue;
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, mode | 0o755);
    }
  } catch (e) {
    console.error('[xuanji] terminal: spawn-helper check failed:', e);
  }
}

let armCapable: boolean | null = null;
/** Apple Silicon 上强制 arm64:后端若经 Rosetta 起,子进程会继承 x86_64,Homebrew 的 arm64 工具随之跑不起来 */
function isArmMac(): boolean {
  if (armCapable !== null) return armCapable;
  armCapable = false;
  if (process.platform !== 'darwin') return armCapable;
  try {
    armCapable = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1';
  } catch {
    /* 老 Intel 机器没有这个键 */
  }
  return armCapable;
}

export function userShell(): string {
  const fromEnv = process.env.SHELL;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const s = os.userInfo().shell;
    if (s && fs.existsSync(s)) return s;
  } catch {
    /* 取不到时落到 zsh */
  }
  return '/bin/zsh';
}

/**
 * launchd 托管的后端环境只有 PATH/HOME(见 ~/Library/LaunchAgents/com.xuanji.backend.plist),
 * 登录 shell 会自己补全 PATH,但 TERM / LANG 不补——不设的话中文乱码、颜色与 p10k 图标退化。
 * 反过来,后端若是从 claude 会话里起的(preview.sh),要把 claude 注入的变量剥掉,
 * 否则用户在终端里跑 claude 会误以为自己嵌在另一个 claude 里;pnpm 注入的 npm_* 同理剥掉。
 */
export function shellEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('XUANJI_')) continue;
    // 后端经 pnpm 脚本起时会带一串 npm_* / PNPM_*(含 npm_config_prefix),nvm 见到它直接报不兼容
    if (/^(npm_|PNPM_|pnpm_)/i.test(k) || k === 'INIT_CWD' || k === 'NODE' || k === 'COREPACK_ROOT') continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'xuanji';
  if (!env.LANG || !/UTF-8/i.test(env.LANG)) env.LANG = 'zh_CN.UTF-8';
  env.HOME = env.HOME || os.homedir();
  env.SHELL = userShell();
  try {
    env.USER = env.USER || os.userInfo().username;
  } catch {
    /* 忽略 */
  }
  return env;
}

/** `~` 展开 + 存在性校验;目录没了就回家目录,不让一个过期路径把终端开不起来 */
export function resolveCwd(cwd: unknown, home = os.homedir()): string {
  let p = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : home;
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  if (!path.isAbsolute(p)) return home;
  try {
    return fs.statSync(p).isDirectory() ? p : home;
  } catch {
    return home;
  }
}

/* ---------------- 会话管理 ---------------- */

export interface SpawnSpec {
  file: string;
  args: string[];
  /** 实际 shell 的路径:前台进程名等于它的 basename 才算「空闲」(file 可能是 arch 包装) */
  shell: string;
}

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', 'nu', 'elvish', 'xonsh', 'tcsh', 'ksh']);

const archCache = new Map<string, boolean>();
/** 二进制是否含 arm64 切片(universal 的 /bin/zsh 是 x86_64 arm64e;旧 Homebrew 的 /usr/local/bin/zsh 只有 x86_64) */
export function hasArm64Slice(bin: string): boolean {
  if (archCache.has(bin)) return archCache.get(bin)!;
  let ok = false;
  try {
    ok = /\barm64/.test(execFileSync('/usr/bin/lipo', ['-archs', bin], { encoding: 'utf8', timeout: 2000 }));
  } catch {
    /* 不是 Mach-O(脚本)或 lipo 不可用:不强制架构 */
  }
  archCache.set(bin, ok);
  return ok;
}

/**
 * 起 shell 的命令,优先级:
 * 1. Ghostty 的 `command`——用户已经在那里决定过怎么起 shell,跟随它才与 Ghostty 行为一致;
 * 2. 登录 shell + `--login`;Apple Silicon 上且二进制含 arm64 切片时用 `arch -arm64` 包一层,
 *    防止后端经 Rosetta 起时子进程跟着落到 x86_64。二进制只有 x86_64 时不能强制(会 Bad CPU type)。
 */
export function defaultSpawnSpec(ghosttyCommand: string | null = readGhosttyCommandSync()): SpawnSpec {
  if (ghosttyCommand) {
    const argv = splitCommand(ghosttyCommand);
    if (argv.length && fs.existsSync(argv[0]!)) {
      const shell = argv.find((a) => a.startsWith('/') && SHELL_NAMES.has(path.basename(a))) ?? argv[0]!;
      return { file: argv[0]!, args: argv.slice(1), shell };
    }
  }
  const shell = userShell();
  return isArmMac() && hasArm64Slice(shell)
    ? { file: '/usr/bin/arch', args: ['-arm64', shell, '--login'], shell }
    : { file: shell, args: ['--login'], shell };
}

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private statusTimer: NodeJS.Timeout | null = null;

  constructor(private spec: () => SpawnSpec = defaultSpawnSpec) {}

  list(): TermSessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info })).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): TermSessionInfo | null {
    const s = this.sessions.get(id);
    return s ? { ...s.info } : null;
  }

  create(opts: { cwd?: unknown; cols?: unknown; rows?: unknown }): TermSessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`最多同时开 ${MAX_SESSIONS} 个终端`);
    ensureSpawnHelper();
    // 延迟加载:原生模块加载失败只影响终端,不拖垮整个后端
    const pty = require('node-pty') as typeof import('node-pty');
    const cwd = resolveCwd(opts.cwd);
    const cols = clampInt(opts.cols, 20, 500, 100);
    const rows = clampInt(opts.rows, 5, 200, 30);
    const spec = this.spec();
    const p = pty.spawn(spec.file, spec.args, { name: 'xterm-256color', cols, rows, cwd, env: { ...shellEnv(), SHELL: spec.shell } });
    const shellName = path.basename(spec.shell);
    const id = randomUUID();
    const s: Session = {
      info: { id, cwd, createdAt: Date.now(), proc: shellName, busy: false, exited: false },
      pty: p,
      shellName,
      buf: [],
      bufLen: 0,
      clients: new Set(),
    };
    p.onData((d) => {
      s.buf.push(d);
      s.bufLen += d.length;
      while (s.bufLen > REPLAY_MAX && s.buf.length > 1) s.bufLen -= s.buf.shift()!.length;
      for (const c of s.clients) c.send({ t: 'out', d });
    });
    p.onExit(({ exitCode }) => {
      s.info.exited = true;
      for (const c of s.clients) c.send({ t: 'exit', code: exitCode });
      this.sessions.delete(id);
    });
    this.sessions.set(id, s);
    this.ensureStatusLoop();
    return { ...s.info };
  }

  /** 连上即回放缓冲;返回解绑函数 */
  attach(id: string, client: TermClient): (() => void) | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.clients.add(client);
    if (s.bufLen) client.send({ t: 'replay', d: s.buf.join('') });
    client.send({ t: 'status', proc: s.info.proc, busy: s.info.busy, cwd: s.info.cwd });
    return () => void s.clients.delete(client);
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.pty.resize(clampInt(cols, 20, 500, 100), clampInt(rows, 5, 200, 30));
    } catch {
      /* 进程刚退出时 resize 会抛,忽略 */
    }
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      s.pty.kill();
    } catch {
      /* 已退出 */
    }
    this.sessions.delete(id);
    return true;
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  /**
   * 状态轮询(每秒):
   * - 前台进程名:node-pty 在 macOS 上能直接给出;不是 shell 自己 = 有命令在跑,标签与状态栏亮「在跑」。
   * - 当前目录:shell 的 cwd 只有进程自己知道(zsh 默认不发 OSC 7),用 lsof 一次查全部 shell;
   *   标签名与「新终端用上次目录」都靠它,否则 cd 之后标签永远停在创建时的目录。
   */
  private ensureStatusLoop() {
    if (this.statusTimer) return;
    let tick = 0;
    this.statusTimer = setInterval(() => {
      if (!this.sessions.size) {
        clearInterval(this.statusTimer!);
        this.statusTimer = null;
        return;
      }
      const cwds = tick++ % 2 === 0 ? readCwds([...this.sessions.values()].map((x) => x.pty.pid)) : null;
      for (const s of this.sessions.values()) {
        const cwd = cwds?.get(s.pty.pid);
        if (cwd && cwd !== s.info.cwd) {
          s.info.cwd = cwd;
          for (const c of s.clients) c.send({ t: 'status', proc: s.info.proc, busy: s.info.busy, cwd });
        }
        let proc = s.shellName;
        try {
          proc = s.pty.process || s.shellName;
        } catch {
          /* 取不到按空闲 */
        }
        const busy = proc !== s.shellName && proc !== 'arch' && !proc.startsWith('-');
        if (proc === s.info.proc && busy === s.info.busy) continue;
        s.info.proc = proc;
        s.info.busy = busy;
        for (const c of s.clients) c.send({ t: 'status', proc, busy, cwd: s.info.cwd });
      }
    }, 1000);
    this.statusTimer.unref();
  }
}

/** 一次 lsof 查多个进程的 cwd:`-Fpn` 输出按 p<pid> / n<path> 成对出现 */
export function parseLsofCwd(out: string): Map<number, string> {
  const m = new Map<number, string>();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) m.set(pid, line.slice(1));
  }
  return m;
}

function readCwds(pids: number[]): Map<number, string> {
  if (!pids.length || process.platform === 'win32') return new Map();
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], {
      encoding: 'utf8',
      timeout: 1500,
    });
    return parseLsofCwd(out);
  } catch (e) {
    // lsof 在部分 pid 已退出时会非零退出但 stdout 仍有效
    const out = (e as { stdout?: string }).stdout;
    return typeof out === 'string' ? parseLsofCwd(out) : new Map();
  }
}

function clampInt(v: unknown, lo: number, hi: number, fb: number): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fb;
}

/* ---------------- 本机直连守卫 ---------------- */

const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader: string): string {
  // [::1]:7777 / localhost:7777
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0]!.toLowerCase();
}

export type HeaderGetter = (name: string) => string | undefined;

/**
 * 终端等于本机 shell,只给「坐在这台 Mac 前」的请求。四道条件同时满足才放行:
 * 1. TCP 对端是回环地址;
 * 2. Host 是回环名——Tailscale serve 反代进来时 Host 是 *.ts.net,DNS rebinding 也过不了这一关;
 * 3. 不带反代头——Tailscale serve 会加 X-Forwarded-For 与 Tailscale-User-*;
 * 4. 带 Origin 时其主机名也必须是回环名——浏览器允许任意网站跨域开 WebSocket 到
 *    localhost,不查 Origin 等于把 shell 交给用户打开的每一个网页。
 * `requireOrigin` 给 WebSocket 用:浏览器发起的 WS 一定带 Origin,不带的只可能是非浏览器客户端。
 */
export function isLocalRequest(remoteAddr: string | undefined, header: HeaderGetter, requireOrigin = false): boolean {
  if (!remoteAddr || !LOOPBACK_ADDR.has(remoteAddr)) return false;
  const host = header('host');
  if (!host || !LOOPBACK_HOST.has(hostnameOf(host))) return false;
  if (header('x-forwarded-for') || header('x-forwarded-host') || header('forwarded')) return false;
  if (header('tailscale-user-login') || header('tailscale-user-name')) return false;
  const origin = header('origin');
  if (!origin) return !requireOrigin;
  try {
    return LOOPBACK_HOST.has(new URL(origin).hostname.toLowerCase()) || LOOPBACK_HOST.has(`[${new URL(origin).hostname}]`);
  } catch {
    return false;
  }
}
