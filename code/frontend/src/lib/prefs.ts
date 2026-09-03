/**
 * 偏好的唯一读写口。分两半,分界依据是「这项设置该不该跟着人走」:
 *
 * - 本机(localStorage `xuanji.prefs`):外观、发送键语义、快捷键覆写。
 *   手机和 Mac 理应各有一套字号与键位,同步过去反而是错的。
 * - 账户(后端 meta 表,经 /api/prefs):派发默认值、通知范围。
 *   换台设备也该保持一致,否则「我在 Mac 上设了默认模型,手机上派发还是老样子」。
 *
 * 壁纸另有历史 key `xuanji.wall`(见 lib/wallpaper.ts),不并入这里:它已有 IndexedDB
 * 图片、迁移会丢用户已调好的参数。两者同属「本机」范畴,设置面板里并排呈现即可。
 *
 * 两半都永不写 ~/.claude(架构铁律 2)。
 */
import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import { KEYMAP_DEFAULTS, normalizeKeymap, type ActionId, type Keymap } from '@/lib/keymap';

const LOCAL_KEY = 'xuanji.prefs';

export type SendKey = 'mod' | 'enter';
export type FontScale = 'sm' | 'md' | 'lg';
export type MotionPref = 'system' | 'on' | 'off';

export interface LocalPrefs {
  /** `mod` = ⌘⏎ 发送 / Enter 换行(现状);`enter` = Enter 发送 / ⇧⏎ 换行 */
  sendKey: SendKey;
  fontScale: FontScale;
  /** 吸顶轮次头 */
  turnHead: boolean;
  /** 减少动效;system = 跟随 prefers-reduced-motion */
  reduceMotion: MotionPref;
  keymap: Keymap;
}

export const DEFAULT_LOCAL: LocalPrefs = {
  sendKey: 'mod',
  fontScale: 'md',
  turnHead: true,
  reduceMotion: 'system',
  keymap: KEYMAP_DEFAULTS,
};

const oneOf = <T extends string>(v: unknown, allow: readonly T[], fb: T): T =>
  typeof v === 'string' && (allow as readonly string[]).includes(v) ? (v as T) : fb;

function normalizeLocal(raw: unknown): LocalPrefs {
  const o = (raw ?? {}) as Partial<LocalPrefs>;
  return {
    sendKey: oneOf(o.sendKey, ['mod', 'enter'] as const, DEFAULT_LOCAL.sendKey),
    fontScale: oneOf(o.fontScale, ['sm', 'md', 'lg'] as const, DEFAULT_LOCAL.fontScale),
    turnHead: typeof o.turnHead === 'boolean' ? o.turnHead : DEFAULT_LOCAL.turnHead,
    reduceMotion: oneOf(o.reduceMotion, ['system', 'on', 'off'] as const, DEFAULT_LOCAL.reduceMotion),
    keymap: normalizeKeymap(o.keymap),
  };
}

export function loadLocal(): LocalPrefs {
  try {
    return normalizeLocal(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}'));
  } catch {
    return DEFAULT_LOCAL;
  }
}

function saveLocal(p: LocalPrefs) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式等写不进去时静默放弃:偏好存不下不该阻断使用 */
  }
}

/* ---------- 单例 + 订阅:多个组件读同一份,改一处全体重渲染 ---------- */

let local: LocalPrefs = typeof localStorage === 'undefined' ? DEFAULT_LOCAL : loadLocal();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const getLocal = (): LocalPrefs => local;

export function patchLocal(p: Partial<LocalPrefs>) {
  local = normalizeLocal({ ...local, ...p });
  saveLocal(local);
  applyLocalToDom(local);
  emit();
}

export function resetLocal() {
  patchLocal(DEFAULT_LOCAL);
}

export function setKey(id: ActionId, combo: string) {
  patchLocal({ keymap: { ...local.keymap, [id]: combo } });
}

export function useLocalPrefs(): LocalPrefs {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return local;
}

/** 读单个键位;组件里 `matchKey(e, useKey('dispatch.model'))` 即可 */
export function useKey(id: ActionId): string {
  return useLocalPrefs().keymap[id];
}

/**
 * 把跟视觉有关的本机偏好落到 <html> 上,由 CSS 接管具体表现。
 * 字号走 root font-size,rem 单位的既有样式全体跟随,不必逐处改。
 */
export function applyLocalToDom(p: LocalPrefs = local) {
  const el = document.documentElement;
  el.dataset.fontScale = p.fontScale;
  el.dataset.motion = p.reduceMotion;
  el.dataset.turnHead = String(p.turnHead);
}

/* ---------- 账户偏好 ---------- */

export type { AccountPrefs } from '@/api/types';
import type { AccountPrefs } from '@/api/types';

export const DEFAULT_ACCOUNT: AccountPrefs = {
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

let account: AccountPrefs = DEFAULT_ACCOUNT;
let accountLoaded = false;
const accSubs = new Set<() => void>();
const accEmit = () => accSubs.forEach((f) => f());

export const getAccount = (): AccountPrefs => account;

/** 首次挂载时拉一次;失败就留在默认值上,派发页照常可用 */
export async function loadAccount(): Promise<AccountPrefs> {
  try {
    const r = await api.prefs();
    account = r.prefs;
    accountLoaded = true;
    accEmit();
  } catch {
    /* 后端不可达时保持默认值 */
  }
  return account;
}

/** 乐观更新:先落本地再发请求,失败则以服务端返回为准回正 */
export async function patchAccount(p: Partial<AccountPrefs>) {
  account = { ...account, ...p, notify: { ...account.notify, ...(p.notify ?? {}) } };
  accEmit();
  try {
    const r = await api.putPrefs(p);
    account = r.prefs;
  } catch {
    /* 保留乐观值,下次 loadAccount 会拉回真相 */
  }
  accEmit();
}

export function useAccountPrefs(): { prefs: AccountPrefs; loaded: boolean } {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    accSubs.add(f);
    if (!accountLoaded) void loadAccount();
    return () => void accSubs.delete(f);
  }, []);
  return { prefs: account, loaded: accountLoaded };
}
