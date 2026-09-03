/**
 * 账户级偏好:跨设备共享的那一半设置(派发默认值、通知范围)。
 *
 * 与「本机偏好」的分界见 DESIGN.md「设置」组件——外观/快捷键这类跟着设备走的存前端
 * localStorage,不进这里;凡是换台机器也该保持一致的,才落这张表。
 *
 * 存储用 meta 表单键 JSON,不为偏好单开表:偏好是一个整体读写的小对象,拆列会让
 * 每加一项都要迁移一次 schema。~/.claude 永远不写(架构铁律 2)。
 */
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

export interface AccountPrefs {
  /** 新会话默认模型;空串 = 沿用上次用过的 */
  model: string;
  /** 默认思考深度;空串 = 自动(按模型取默认) */
  effort: string;
  /** 默认权限模式 */
  perm: string;
  /** 默认工作目录;空串 = 最近一次派发的目录 */
  cwd: string;
  /** 新会话默认转后台 */
  bg: boolean;
  /** /wrapup 的固定触发语 */
  wrapupPrompt: string;
  notify: NotifyPrefs;
}

/** 与前端 Dispatch 的既有默认值保持一致:权限免审批、模型与目录沿用上次 */
export const DEFAULT_PREFS: AccountPrefs = {
  model: '',
  effort: '',
  perm: 'bypassPermissions',
  cwd: '',
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
};

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
  const merged = { ...cur, ...p, notify: { ...cur.notify, ...(p.notify ?? {}) } };
  const next = sanitize(merged, cur);
  storage.setMeta(META_KEY, JSON.stringify(next));
  return next;
}
