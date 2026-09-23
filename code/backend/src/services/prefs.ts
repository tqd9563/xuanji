/**
 * 账户级偏好:跨设备共享的那一半设置(派发默认值、通知范围)。
 *
 * 与「本机偏好」的分界见 DESIGN.md「设置」组件——外观/快捷键这类跟着设备走的存前端
 * localStorage,不进这里;凡是换台机器也该保持一致的,才落这张表。
 *
 * 存储用 meta 表单键 JSON,不为偏好单开表:偏好是一个整体读写的小对象,拆列会让
 * 每加一项都要迁移一次 schema。~/.claude 永远不写(架构铁律 2)。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Storage } from '../storage/db.js';

const META_KEY = 'prefs';

export interface NotifyPrefs {
  /** 璇玑派发的会话 */
  dispatched: boolean;
  /** 定时任务 */
  scheduled: boolean;
  /** 终端里的交互会话:默认关,你在终端前不需要网页再提醒一次 */
  terminal: boolean;
  /** 需要审批 / blocked */
  blocked: boolean;
  /** 回合结束 */
  turnEnd: boolean;
  /** 出错退出 */
  error: boolean;
}

/**
 * 系统监控(状态栏内存/CPU 指示):采样行为在后端,故这组设置走账户偏好。
 * 卡片上显示哪些数字是纯展示偏好,留在前端本机偏好里。
 */
export interface MonitorPrefs {
  mem: boolean;
  cpu: boolean;
  /** 采样间隔(秒) */
  interval: 5 | 10 | 30 | 60;
  /** 连续 N 次超阈值才变色 */
  debounce: 1 | 2 | 3;
  /** 没有任何页面在看时暂停采样 */
  pauseIdle: boolean;
  /** CPU 整体占用(用户+系统)黄 / 红阈值,百分比 */
  cpuWarn: number;
  cpuCrit: number;
}

export interface AccountPrefs {
  /** 新会话默认模型;空串 = 沿用上次用过的 */
  model: string;
  /** 默认思考深度;空串 = 自动(按模型取默认) */
  effort: string;
  /** 默认权限模式 */
  perm: string;
  /** 默认工作目录;空串 = 最近一次派发的目录 */
  cwd: string;
  /**
   * 「快速提问」目录:新会话在没有显式选目录时落在这里,不绑任何仓库。
   * 空串 = 关闭该默认,新会话回到「沿用候选列表首项」的旧行为。
   * 它不是第二个默认目录,而是 cwd 的兜底:cwd 有值时以 cwd 为准。
   */
  quickAskCwd: string;
  /** 新会话默认转后台 */
  bg: boolean;
  /** /wrapup 的固定触发语 */
  wrapupPrompt: string;
  notify: NotifyPrefs;
  monitor: MonitorPrefs;
}

/** 与前端 Dispatch 的既有默认值保持一致:权限免审批、模型与目录沿用上次 */
export const DEFAULT_PREFS: AccountPrefs = {
  model: '',
  effort: '',
  perm: 'bypassPermissions',
  cwd: '',
  quickAskCwd: join(homedir(), 'scratch'),
  bg: false,
  wrapupPrompt:
    '执行 wrapup skill,把本会话刚完成的任务沉淀成一张收口卡;任务边界你先识别再向我确认,不要直接落盘。',
  notify: {
    dispatched: true,
    scheduled: true,
    terminal: false,
    blocked: true,
    turnEnd: true,
    error: true,
  },
  monitor: { mem: true, cpu: true, interval: 10, debounce: 2, pauseIdle: true, cpuWarn: 60, cpuCrit: 85 },
};

const INTERVALS = [5, 10, 30, 60] as const;
const DEBOUNCES = [1, 2, 3] as const;

function pick<T extends number>(v: unknown, allow: readonly T[], fb: T): T {
  return allow.includes(v as T) ? (v as T) : fb;
}
function pct(v: unknown, lo: number, hi: number, fb: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fb;
}

/** 黄 < 红 才接受这一对阈值;非法组合整对回退,不留下「黄 90 红 85」这种判不了色的状态 */
function sanitizeMonitor(input: unknown, base: MonitorPrefs): MonitorPrefs {
  const m = (input ?? {}) as Partial<MonitorPrefs>;
  const warn = pct(m.cpuWarn, 30, 95, base.cpuWarn);
  const crit = pct(m.cpuCrit, 35, 99, base.cpuCrit);
  const ok = warn < crit;
  return {
    mem: bool(m.mem, base.mem),
    cpu: bool(m.cpu, base.cpu),
    interval: pick(m.interval, INTERVALS, base.interval),
    debounce: pick(m.debounce, DEBOUNCES, base.debounce),
    pauseIdle: bool(m.pauseIdle, base.pauseIdle),
    cpuWarn: ok ? warn : base.cpuWarn,
    cpuCrit: ok ? crit : base.cpuCrit,
  };
}

const PERMS = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan']);
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']);
/** 触发语可以改但不能清空或塞进一整篇文章:空串会让 /wrapup 变成空发送 */
const WRAPUP_MAX = 500;

function str(v: unknown, fallback: string, max = 200): string {
  return typeof v === 'string' && v.length <= max ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * 逐字段挑选并校验,不整体信任入参。
 * 未知键直接丢弃——偏好对象会被前端整体回写,不设白名单就等于开了个任意 KV 存储。
 */
export function sanitize(input: unknown, base: AccountPrefs = DEFAULT_PREFS): AccountPrefs {
  const o = (input ?? {}) as Partial<AccountPrefs>;
  const n = (o.notify ?? {}) as Partial<NotifyPrefs>;
  const perm = str(o.perm, base.perm);
  const effort = str(o.effort, base.effort);
  const wrapup = str(o.wrapupPrompt, base.wrapupPrompt, WRAPUP_MAX);
  return {
    model: str(o.model, base.model),
    effort: EFFORTS.has(effort) ? effort : base.effort,
    perm: PERMS.has(perm) ? perm : base.perm,
    /** 路径不在此校验存在性:候选目录随时可能被删,校验会让偏好读取依赖文件系统 */
    cwd: str(o.cwd, base.cwd, 500),
    /** 同 cwd:不校验存在性。目录被删时前端按「候选里没有」处理,不至于让偏好读不出来 */
    quickAskCwd: str(o.quickAskCwd, base.quickAskCwd, 500),
    bg: bool(o.bg, base.bg),
    wrapupPrompt: wrapup.trim() ? wrapup : base.wrapupPrompt,
    notify: {
      dispatched: bool(n.dispatched, base.notify.dispatched),
      scheduled: bool(n.scheduled, base.notify.scheduled),
      terminal: bool(n.terminal, base.notify.terminal),
      blocked: bool(n.blocked, base.notify.blocked),
      turnEnd: bool(n.turnEnd, base.notify.turnEnd),
      error: bool(n.error, base.notify.error),
    },
    monitor: sanitizeMonitor(o.monitor, base.monitor),
  };
}

/** 读:存量 JSON 坏掉时静默回退到默认值,偏好读不出来不该让整个界面挂掉 */
export function readPrefs(storage: Storage): AccountPrefs {
  const raw = storage.getMeta(META_KEY);
  if (!raw) return DEFAULT_PREFS;
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFS;
  }
}

/** 写:patch 语义(在当前值上合并),前端改一项不必回传整个对象 */
export function writePrefs(storage: Storage, patch: unknown): AccountPrefs {
  const cur = readPrefs(storage);
  const p = (patch ?? {}) as Partial<AccountPrefs>;
  const merged = {
    ...cur,
    ...p,
    notify: { ...cur.notify, ...(p.notify ?? {}) },
    monitor: { ...cur.monitor, ...(p.monitor ?? {}) },
  };
  const next = sanitize(merged, cur);
  storage.setMeta(META_KEY, JSON.stringify(next));
  return next;
}
