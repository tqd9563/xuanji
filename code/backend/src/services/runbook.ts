/**
 * 验收面板服务:清单解析/实例化 + 执行引擎 + 收尾。
 * 设计见 wiki/tech/acceptance-runbook.md。
 *
 * 与 DispatchSession 同构的一套「模块级注册表 + subscribe/emit」:
 * 长驻 service 进程活在进程内存里,前端可随时接回看日志。
 *
 * 进程模型:一律 detached spawn 成独立进程组,kill 时杀整组(-pid)。
 * dev server 这类命令会拉起子进程(vite/uvicorn),只 kill 父进程会留下孤儿占着端口——
 * 这正是本功能要解决的问题本身,不能自己再制造一遍(2026-08-27 排查 baize_web
 * 僵尸 vite 时的实证:worktree 都删了,进程还占着 48164)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRunbookFile, stampRunbookSession } from '../adapters/runbook-file.js';
import { guardItem } from './runbook-guard.js';
import type { Storage } from '../storage/db.js';
import type {
  AcceptanceRunbook,
  ResolvedRunbook,
  RunbookItem,
  RunbookRun,
  RunbookRunStatus,
  RunbookTemplate,
} from '../types.js';

/** 面板推给前端的事件(经 /ws/dispatch 通道,判别键 ev 与 DispatchEvent 同族) */
export type RunbookEvent =
  | { ev: 'rb-state'; sessionId: string; itemId: string; status: RunbookRunStatus; runId: number; exitCode?: number | null }
  | { ev: 'rb-log'; sessionId: string; itemId: string; chunk: string }
  | { ev: 'rb-error'; sessionId: string; itemId?: string; message: string };

interface LiveProc {
  sessionId: string;
  itemId: string;
  /** 项类型:收尾时要区分「该等它跑完的 cleanup」与「该被杀掉的 service」 */
  type: RunbookItem['type'];
  runId: number;
  pid: number;
  /** 日志环形缓冲:接回时回放最近若干行,不重放整个历史 */
  buffer: string[];
  status: RunbookRunStatus;
  logPath: string;
  /** 进程结束时 resolve;收尾流程据此等待 cleanup 真正跑完再动手杀 service */
  done: Promise<void>;
  markDone: () => void;
}

const LOG_TAIL_LINES = 400;

const procs = new Map<string, LiveProc>();          // key: sessionId::itemId
const listeners = new Map<string, Set<(e: RunbookEvent) => void>>(); // key: sessionId

const key = (sessionId: string, itemId: string) => `${sessionId}::${itemId}`;

/** 订阅某会话的面板事件;返回退订函数(与 DispatchSession.subscribe 同形) */
export function subscribeRunbook(sessionId: string, fn: (e: RunbookEvent) => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(sessionId);
  };
}

function emit(e: RunbookEvent) {
  for (const fn of listeners.get(e.sessionId) ?? []) {
    try {
      fn(e);
    } catch {
      /* 单个订阅者出错不影响其它连接 */
    }
  }
}

// ---------- 清单解析与实例化 ----------

/**
 * 模板 + 实例 → 最终清单。
 * 顺序:模板项(去掉 omitItems)在前、extraItems 在后——模板是稳定骨架,
 * 本次特有项追加在末尾,面板从上到下就是「先起环境、再做本次的事、最后收尾」。
 * cleanup 项统一沉到最底,不论它在模板里的位置。
 */
export function instantiate(
  runbook: AcceptanceRunbook,
  template: RunbookTemplate | null,
): RunbookItem[] {
  const omit = new Set(runbook.omitItems ?? []);
  const fromTpl = (template?.items ?? [])
    .filter((i) => !omit.has(i.id))
    .map((i) => ({ ...i, origin: 'template' as const }));
  const extra = (runbook.extraItems ?? []).map((i) => ({ ...i, origin: 'session' as const }));
  const all = [...fromTpl, ...extra];
  const cleanups = all.filter((i) => i.type === 'cleanup');
  const rest = all.filter((i) => i.type !== 'cleanup');
  return [...rest, ...cleanups];
}

/**
 * 清单归属判定:这份清单是不是「本次会话的交付物」。
 *
 * 面板出现的时机由此决定。清单是一次交付的产物,不是项目常驻配置——同一目录下的
 * 后续会话不该继承上一次交付的清单(实测:项目里躺着一份旧清单,新会话刚问完版本号
 * 就弹出验收面板)。两级判定:
 *  1) 清单显式写了 sessionId → 只认它,别的会话一律不渲染(硬绑定,盖章后永久生效);
 *  2) 没写 → 只有「写于本会话开始之后」才算本次交付,认领并盖章;早于会话开始的
 *     一律视为上一次交付的残留。
 * 非 web 派发的会话拿不到起始时刻,只接受已盖章的清单(宁可不出面板,不错出面板)。
 */
function runbookOwner(
  storage: Storage,
  sessionId: string,
  runbook: AcceptanceRunbook,
  mtimeMs: number | undefined,
): { ok: true; claim: boolean } | { ok: false; reason: string } {
  if (runbook.sessionId) {
    return runbook.sessionId === sessionId
      ? { ok: true, claim: false }
      : { ok: false, reason: `清单归属会话 ${runbook.sessionId},不属于本会话` };
  }
  const startedAt = storage.dispatchStartedAt(sessionId);
  if (startedAt === null) return { ok: false, reason: '清单未标注归属会话,而本会话不是 web 派发会话' };
  if (mtimeMs === undefined) return { ok: false, reason: '读不到清单修改时间,无法判定归属' };
  if (mtimeMs < startedAt) {
    return { ok: false, reason: '清单写于本会话开始之前,视为上一次交付的残留' };
  }
  return { ok: true, claim: true };
}

/**
 * 读出某会话的完整面板数据。返回 null = 没有清单(或清单不属于本会话),面板不渲染。
 * 每项在这里就跑一遍 guard:黑名单命中的项带着 blockedReason 下发,
 * 前端渲染成「已拦截」而不是等用户点了才报错(§6.2)。
 */
export function resolveRunbook(storage: Storage, sessionId: string, cwd: string): ResolvedRunbook | null {
  const { runbook, warning, mtimeMs } = readRunbookFile(cwd);
  if (!runbook) {
    if (warning) console.warn(`[runbook] ${sessionId}: ${warning}`);
    return null;
  }
  const owner = runbookOwner(storage, sessionId, runbook, mtimeMs);
  if (!owner.ok) {
    console.warn(`[runbook] ${sessionId}: ${owner.reason}`);
    return null;
  }
  // 认领即盖章:此后这份清单硬绑在本会话上,不再依赖时间比较
  if (owner.claim) stampRunbookSession(cwd, sessionId);
  const template = runbook.templateRef ? storage.getRunbookTemplate(runbook.templateRef.id) : null;
  const items = instantiate(runbook, template).map((item) => {
    const provided = runbook.paramValues?.[item.id];
    // 参数默认值:实例预填覆盖模板 default,让前端表单直接显示本次的值
    const withDefaults = provided
      ? { ...item, params: item.params?.map((p) => ({ ...p, default: provided[p.key] ?? p.default })) }
      : item;
    if (item.type === 'request' || item.type === 'link') return withDefaults;
    const g = guardItem(withDefaults, cwd, provided);
    return g.ok ? withDefaults : { ...withDefaults, blockedReason: g.reason };
  });

  const runs: Record<string, RunbookRun> = {};
  for (const r of storage.latestRunbookRuns(sessionId)) runs[r.itemId] = r;

  return {
    sessionId,
    cwd,
    templateName: template?.name,
    templateVersion: template?.version,
    notes: runbook.notes,
    items,
    runs,
  };
}

// ---------- 执行 ----------

function logDir(): string {
  const dir = path.join(os.tmpdir(), 'xuanji-runbook');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 端口就绪探测:能连上即算起来了 */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1000);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

async function probeHttp(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface RunOpts {
  storage: Storage;
  sessionId: string;
  cwd: string;
  item: RunbookItem;
  /** 用户在面板上填的参数值 */
  params?: Record<string, string>;
  /** origin=session 的项必须带 confirmed:true(前端弹过完整命令确认) */
  confirmed?: boolean;
}

export interface RunResult {
  ok: boolean;
  reason?: string;
  runId?: number;
  resolvedCommand?: string;
}

/**
 * 执行一个 service / command / cleanup 项。
 * request 项不走这里(见 runRequest)——它不是子进程,没有进程组与日志文件。
 */
export function runItem(opts: RunOpts): RunResult {
  const { storage, sessionId, cwd, item, params } = opts;

  // 会话生成的项未经用户确认不得执行:前端弹窗是体验,后端校验才是边界
  if (item.origin === 'session' && !opts.confirmed) {
    return { ok: false, reason: '该项由会话生成,首次执行需确认' };
  }

  const g = guardItem(item, cwd, params);
  if (!g.ok) return { ok: false, reason: g.reason };

  const k = key(sessionId, item.id);
  if (procs.has(k)) return { ok: false, reason: '该项正在运行中' };

  const logPath = path.join(logDir(), `${sessionId}-${item.id}-${randomUUID().slice(0, 8)}.log`);
  const runId = storage.createRunbookRun({
    sessionId,
    itemId: item.id,
    resolvedCommand: g.command.display,
    status: 'running',
    pid: null,
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    logPath,
  });

  const [bin, ...args] = g.command.argv;
  // guardItem 已保证 argv 非空,这里的兜底只为让类型收窄
  if (!bin) return { ok: false, reason: '命令为空' };
  let child: ChildProcess;
  try {
    child = spawn(bin, args, {
      cwd: g.cwd,
      env: { ...process.env, ...(item.env ?? {}) },
      // 独立进程组:kill(-pid) 能带走 dev server 拉起的整棵子进程树,不留孤儿
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    storage.updateRunbookRun(runId, { status: 'failed', endedAt: Date.now() });
    emit({ ev: 'rb-error', sessionId, itemId: item.id, message: `启动失败:${msg}` });
    return { ok: false, reason: msg };
  }

  let markDone!: () => void;
  const donePromise = new Promise<void>((res) => {
    markDone = res;
  });
  const live: LiveProc = {
    sessionId,
    itemId: item.id,
    type: item.type,
    runId,
    pid: child.pid ?? -1,
    buffer: [],
    status: 'running',
    logPath,
    done: donePromise,
    markDone,
  };
  procs.set(k, live);
  storage.updateRunbookRun(runId, { pid: child.pid ?? null });
  emit({ ev: 'rb-state', sessionId, itemId: item.id, status: 'running', runId });

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const onChunk = (buf: Buffer) => {
    const chunk = buf.toString();
    logStream.write(chunk);
    live.buffer.push(chunk);
    // 环形缓冲按块数封顶即可,不必精确到行——只是防长跑服务把内存吃满
    if (live.buffer.length > LOG_TAIL_LINES) live.buffer.splice(0, live.buffer.length - LOG_TAIL_LINES);
    emit({ ev: 'rb-log', sessionId, itemId: item.id, chunk });
    if (item.readiness?.kind === 'logPattern' && live.status === 'running') {
      try {
        if (new RegExp(item.readiness.pattern).test(chunk)) markReady(storage, live);
      } catch {
        /* 坏正则不该让执行挂掉 */
      }
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  child.on('error', (e) => {
    finish(storage, live, 'failed', null);
    emit({ ev: 'rb-error', sessionId, itemId: item.id, message: e.message });
  });

  child.on('exit', (code) => {
    logStream.end();
    // service 退出即「已退出」;一次性命令按退出码判成败
    if (item.type === 'service') finish(storage, live, 'exited', code);
    else finish(storage, live, code === 0 ? 'ok' : 'failed', code);
  });

  // service 的就绪探测:port/http 轮询,logPattern 在 onChunk 里就地判定
  if (item.type === 'service' && item.readiness && item.readiness.kind !== 'logPattern') {
    void pollReadiness(storage, live, item);
  }

  // 一次性命令的超时兜底:卡死的命令不该永远占着「执行中」
  if (item.type !== 'service') {
    const ms = (item.timeoutSec ?? 600) * 1000;
    const timer = setTimeout(() => {
      if (procs.get(k) === live) {
        emit({ ev: 'rb-error', sessionId, itemId: item.id, message: `超时 ${ms / 1000}s,已终止` });
        killGroup(live.pid);
      }
    }, ms);
    child.on('exit', () => clearTimeout(timer));
  }

  return { ok: true, runId, resolvedCommand: g.command.display };
}

function markReady(storage: Storage, live: LiveProc) {
  live.status = 'ready';
  storage.updateRunbookRun(live.runId, { status: 'ready' });
  emit({ ev: 'rb-state', sessionId: live.sessionId, itemId: live.itemId, status: 'ready', runId: live.runId });
}

async function pollReadiness(storage: Storage, live: LiveProc, item: RunbookItem) {
  const r = item.readiness;
  if (!r || r.kind === 'logPattern') return;
  const timeoutSec = r.kind === 'http' ? (r.timeoutSec ?? 60) : 60;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    // 进程已经没了就别再探了
    if (live.status !== 'running' || !procs.has(key(live.sessionId, live.itemId))) return;
    const ok = r.kind === 'port' ? await probePort(r.port) : await probeHttp(r.url);
    if (ok) return markReady(storage, live);
    await new Promise((res) => setTimeout(res, 700));
  }
  emit({
    ev: 'rb-error',
    sessionId: live.sessionId,
    itemId: live.itemId,
    message: '就绪探测超时:进程还在跑,但没等到服务响应',
  });
}

function finish(storage: Storage, live: LiveProc, status: RunbookRunStatus, code: number | null) {
  procs.delete(key(live.sessionId, live.itemId));
  live.status = status;
  // 进程退出可能晚于后端关停(或测试结束),此时库已关闭。
  // 一个收尾中的子进程不该把宿主进程带崩,写不进去就算了——运行态本就可从进程表重建。
  try {
    storage.updateRunbookRun(live.runId, { status, exitCode: code, endedAt: Date.now() });
  } catch {
    /* 库已关闭 */
  }
  emit({ ev: 'rb-state', sessionId: live.sessionId, itemId: live.itemId, status, runId: live.runId, exitCode: code });
  live.markDone();
}

/** 杀整个进程组;失败时退回杀单进程 */
function killGroup(pid: number) {
  if (pid <= 0) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经没了 */
    }
  }
}

/** 手动停止一个 service */
export function stopItem(storage: Storage, sessionId: string, itemId: string): RunResult {
  const live = procs.get(key(sessionId, itemId));
  if (!live) return { ok: false, reason: '该项没有在运行' };
  killGroup(live.pid);
  storage.updateRunbookRun(live.runId, { status: 'stopped' });
  return { ok: true, runId: live.runId };
}

/** 接回面板时回放该会话仍在跑的进程的日志尾巴(刷新页面不丢上下文) */
export function replayRunbookLogs(sessionId: string, send: (e: RunbookEvent) => void) {
  for (const live of procs.values()) {
    if (live.sessionId !== sessionId) continue;
    if (live.buffer.length) {
      send({ ev: 'rb-log', sessionId, itemId: live.itemId, chunk: live.buffer.join('') });
    }
    send({ ev: 'rb-state', sessionId, itemId: live.itemId, status: live.status, runId: live.runId });
  }
}

// ---------- request 项 ----------

export interface RequestResult {
  ok: boolean;
  reason?: string;
  status?: number;
  durationMs?: number;
  body?: string;
}

/** 预置 HTTP 请求。不做断言判定——expect 是给人看的验收要点,要自动断言就该进 vitest */
export async function runRequest(item: RunbookItem, confirmed?: boolean): Promise<RequestResult> {
  if (item.origin === 'session' && !confirmed) {
    return { ok: false, reason: '该项由会话生成,首次执行需确认' };
  }
  if (!item.url) return { ok: false, reason: '缺少 url' };
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), (item.timeoutSec ?? 30) * 1000);
    const res = await fetch(item.url, {
      method: item.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(item.headers ?? {}) },
      body: item.method && item.method !== 'GET' ? item.body : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    return { ok: true, status: res.status, durationMs: Date.now() - started, body: text };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- 收尾 ----------

/**
 * 会话被处置(验收通过 → 归档)时的自动收尾:
 *  1) 先跑 auto=onResolve 的 cleanup 项(脚本自己的优雅收尾,如 ./preview.sh --stop);
 *  2) 再兜底 kill 该会话名下仍存活的 service 进程组。
 * 顺序不可换:先 kill 会让 cleanup 脚本清不干净(临时目录/端口锁还在)。
 */
export async function resolveSessionCleanup(
  storage: Storage,
  sessionId: string,
  cwd: string,
  graceMs = 30_000,
): Promise<string[]> {
  const done: string[] = [];
  const rb = resolveRunbook(storage, sessionId, cwd);
  const pending: Array<Promise<void>> = [];
  for (const item of rb?.items ?? []) {
    if (item.type !== 'cleanup' || item.blockedReason) continue;
    const r = runItem({ storage, sessionId, cwd, item, confirmed: true });
    if (!r.ok) continue;
    done.push(item.title);
    const live = procs.get(key(sessionId, item.id));
    if (live) pending.push(live.done);
  }
  // 等 cleanup 真正跑完再动手。不等的话下面的 kill 会连它自己一起杀掉,
  // `./preview.sh --stop` 这类脚本还没来得及清临时数据就没了(实测踩到过)。
  if (pending.length) {
    await Promise.race([
      Promise.all(pending),
      new Promise((res) => setTimeout(res, graceMs)),
    ]);
  }
  // 兜底:只杀 service。cleanup 已经跑过一轮,剩下还活着的才是需要强制回收的环境
  for (const live of [...procs.values()]) {
    if (live.sessionId !== sessionId || live.type !== 'service') continue;
    killGroup(live.pid);
    try {
      storage.updateRunbookRun(live.runId, { status: 'stopped', endedAt: Date.now() });
    } catch {
      /* 库已关闭 */
    }
    done.push(`停止 ${live.itemId}`);
  }
  return done;
}

/** 仪表盘「运行中的验收环境」:跨会话列出内存里活着的 service */
export function liveEnvironments(): Array<{ sessionId: string; itemId: string; pid: number; status: RunbookRunStatus }> {
  return [...procs.values()].map((p) => ({
    sessionId: p.sessionId,
    itemId: p.itemId,
    pid: p.pid,
    status: p.status,
  }));
}

/** 仅测试用:清空进程注册表 */
export function _resetRunbookState() {
  procs.clear();
  listeners.clear();
}
