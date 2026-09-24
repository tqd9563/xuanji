/**
 * 看板娘:本机偏好 + 缩略图缓存键。
 *
 * 偏好跟着设备走(和壁纸同属「外观/本机」),存 localStorage 不进后端 prefs
 * ——分界见 services/prefs.ts 的注释。
 * 缩略图 Blob 存 IndexedDB:Node 端没有 WebGL,缩略图只能在浏览器里渲染一次再缓存。
 */
import { useCallback, useEffect, useState } from 'react';

import { idbDelete, idbGet, idbKeys, idbPut, STORE_LIVE2D_THUMBS } from './idb.js';

export type Live2dSide = 'left' | 'right';
export type Live2dTalk = 'mute' | 'event' | 'chat';

export interface Live2dState {
  enabled: boolean;
  /** 模型目录名;'' 表示还没选过,由列表第一个顶上 */
  model: string;
  /** 显示高度 px */
  size: number;
  side: Live2dSide;
  talk: Live2dTalk;
}

/**
 * 默认关闭。看板娘是可选装饰,不该在升级后擅自出现在每个人的界面上;
 * 关闭态还能完全跳过 pixi 与模型的加载,默认零成本。
 */
export const LIVE2D_DEFAULTS: Live2dState = {
  enabled: false,
  model: '',
  size: 300,
  side: 'right',
  talk: 'event',
};

export const LIVE2D_SIZES = [200, 300, 400] as const;

const STORAGE_KEY = 'xuanji.live2d';

/** 容错解析:字段缺失/类型不对/取值越界都回落到默认值,坏数据不该让界面白屏 */
export function normalizeLive2d(raw: unknown): Live2dState {
  const d = LIVE2D_DEFAULTS;
  if (!raw || typeof raw !== 'object') return { ...d };
  const o = raw as Record<string, unknown>;
  const size = Number(o.size);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    model: typeof o.model === 'string' ? o.model : d.model,
    size: LIVE2D_SIZES.includes(size as (typeof LIVE2D_SIZES)[number]) ? size : d.size,
    side: o.side === 'left' || o.side === 'right' ? o.side : d.side,
    talk: o.talk === 'mute' || o.talk === 'event' || o.talk === 'chat' ? o.talk : d.talk,
  };
}

export function readLive2d(): Live2dState {
  try {
    return normalizeLive2d(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return { ...LIVE2D_DEFAULTS };
  }
}

function writeLive2d(s: Live2dState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式等写不进去,忽略:内存里仍然生效 */
  }
}

export function useLive2d(): [Live2dState, (patch: Partial<Live2dState>) => void] {
  const [state, setState] = useState<Live2dState>(readLive2d);
  const update = useCallback((patch: Partial<Live2dState>) => {
    setState((prev) => {
      const next = normalizeLive2d({ ...prev, ...patch });
      writeLive2d(next);
      return next;
    });
  }, []);
  useEffect(() => {
    // 多标签页同步:另一个标签改了设置,这边跟上
    const onStorage = (e: StorageEvent): void => {
      if (e.key === STORAGE_KEY) setState(readLive2d());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return [state, update];
}

/* ---------- 缩略图缓存 ---------- */

/**
 * 缓存键带目录指纹:用户换了模型文件,指纹变、键变,自动重渲染。
 * 只用目录名做键会一直显示旧脸。
 */
/**
 * 低于这个字节数几乎肯定是张空白图。渲染侧用它拒绝写入,读取侧用它拒绝命中——
 * 只防写入是不够的:坏图一旦进了缓存,之后每次都命中,用户只能看到黑框,
 * 而且 ⌘⇧R 清的是 HTTP 缓存,根本碰不到 IndexedDB,除非手动清站点数据否则永远出不来。
 */
export const MIN_THUMB_BYTES = 3000;

export function thumbKey(name: string, fingerprint: string): string {
  return `${name}@${fingerprint}`;
}

export async function getThumbUrl(name: string, fingerprint: string): Promise<string | null> {
  try {
    const blob = await idbGet<Blob>(STORE_LIVE2D_THUMBS, thumbKey(name, fingerprint));
    if (!blob) return null;
    if (blob.size < MIN_THUMB_BYTES) {
      // 早先版本可能存进过空白图。当作未命中,让它重渲染并覆盖,不必让用户去清站点数据。
      await idbDelete(STORE_LIVE2D_THUMBS, thumbKey(name, fingerprint)).catch(() => {});
      return null;
    }
    return URL.createObjectURL(blob);
  } catch {
    return null; // IndexedDB 不可用(隐私模式等):退化成每次现渲染
  }
}

export async function putThumb(name: string, fingerprint: string, blob: Blob): Promise<void> {
  try {
    await idbPut(STORE_LIVE2D_THUMBS, thumbKey(name, fingerprint), blob);
  } catch {
    /* 存不下就算了,不影响显示 */
  }
}

/** 找出该删的缓存键:模型没了,或指纹变了(旧键) */
export function staleThumbKeys(existing: string[], models: { name: string; fingerprint: string }[]): string[] {
  const live = new Set(models.map((m) => thumbKey(m.name, m.fingerprint)));
  return existing.filter((k) => !live.has(k));
}

/** 清掉失效缩略图,避免换几次模型后 IndexedDB 里堆一堆再也用不到的图 */
export async function pruneThumbs(models: { name: string; fingerprint: string }[]): Promise<number> {
  try {
    const keys = await idbKeys(STORE_LIVE2D_THUMBS);
    const stale = staleThumbKeys(keys, models);
    for (const k of stale) await idbDelete(STORE_LIVE2D_THUMBS, k);
    return stale.length;
  } catch {
    return 0;
  }
}
