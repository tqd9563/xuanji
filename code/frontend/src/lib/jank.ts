/**
 * 卡顿记录器:把「主线程冻结」连同现场一起记下来,供事后定位。
 *
 * 为什么需要它:「点进会话偶尔严重卡顿」在实验室里复现不出来(2026-09-23,三轮
 * profile 各指向不同原因),而用户用的 Pake 壳是 WebKit,没有 Long Tasks API,
 * Chromium 上的 profile 数据也套不上。与其继续猜,不如在真实使用时抓现场。
 *
 * 探测手段:100ms 一次的定时心跳。定时器到期后迟迟得不到执行 = 主线程被占着;
 * 迟到超过 STALL_MS 就算一次冻结。任何内核都支持,不依赖 longtask/LoAF。
 *
 * 现场包括:当时的视图、最近一次交互(点了哪张卡、走的哪条入口)、冻结开始时还在飞的
 * 请求、刚完成的请求耗时。Chromium 上额外附带 long-animation-frame 的脚本归因。
 * 记录落两处:localStorage 环形缓冲(离线也能看)+ POST 给后端追加到文件(我能读)。
 */

const STALL_MS = 500;
const HEARTBEAT_MS = 100;
const RING_KEY = 'xuanji.jank';
const RING_MAX = 50;

export interface Interaction {
  /** 交互种类,例如 open-session / nav / click */
  kind: string;
  /** 补充信息:sessionId、入口(drawer / attach / resume)等 */
  detail?: Record<string, string | number | boolean | null | undefined>;
  at: number;
}

export interface JankRecord {
  at: string;
  /** 冻结时长(定时器迟到的毫秒数) */
  stallMs: number;
  view: string;
  visibility: string;
  /** 距最近一次交互多少毫秒 */
  sinceInteractionMs: number | null;
  interaction: Interaction | null;
  /** 冻结开始时仍在飞的请求 */
  inflight: string[];
  /** 冻结前 5s 内完成的请求及其耗时 */
  recent: { url: string; ms: number }[];
  /** Chromium: long-animation-frame 的脚本归因(WebKit 没有,为空) */
  scripts: string[];
  ua: string;
  /** true = 密集小卡顿(3s 内迟到总和 ≥1s),stallMs 是该窗口的总和而非单次 */
  dense?: boolean;
}

let lastInteraction: Interaction | null = null;
const inflight = new Map<string, number>();
const recent: { url: string; ms: number; doneAt: number }[] = [];
const loafScripts: { at: number; desc: string }[] = [];

/** 由业务代码在关键交互处调用,给下一条冻结记录提供「你刚才在干什么」 */
export function noteInteraction(kind: string, detail?: Interaction['detail']) {
  lastInteraction = { kind, detail, at: performance.now() };
}

function shortUrl(u: string) {
  return u.replace(/^https?:\/\/[^/]+/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/i, (m) => m.slice(0, 8));
}

/** 记下每个 fetch 的起止,冻结时能看到「谁还在飞、谁刚回来」 */
function hookFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = shortUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.startsWith('/api/client-jank')) return orig(input, init); // 自己的上报不记,免得每条记录都带着上一条
    const key = `${url}#${Math.random().toString(36).slice(2, 6)}`;
    const t0 = performance.now();
    inflight.set(key, t0);
    const done = () => {
      inflight.delete(key);
      recent.push({ url, ms: Math.round(performance.now() - t0), doneAt: performance.now() });
      if (recent.length > 30) recent.splice(0, recent.length - 30);
    };
    return orig(input, init).then(
      (r) => {
        done();
        return r;
      },
      (e) => {
        done();
        throw e;
      },
    );
  };
}

/** Chromium 才有:long-animation-frame 自带脚本归因(函数名 + 源码位置 + 强制布局耗时) */
function hookLoaf() {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { scripts?: { invoker?: string; sourceFunctionName?: string; sourceURL?: string; sourceCharPosition?: number; duration: number; forcedStyleAndLayoutDuration?: number }[] })[]) {
        if (e.duration < 200) continue;
        for (const s of e.scripts ?? []) {
          if (s.duration < 50) continue;
          loafScripts.push({
            at: performance.now(),
            desc: `${Math.round(s.duration)}ms ${s.sourceFunctionName || s.invoker || '?'} @${(s.sourceURL || '').split('/').pop()}:${s.sourceCharPosition ?? ''} 强制布局${Math.round(s.forcedStyleAndLayoutDuration ?? 0)}ms`,
          });
        }
        if (loafScripts.length > 40) loafScripts.splice(0, loafScripts.length - 40);
      }
    });
    po.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit);
  } catch {
    /* 不支持就没有归因,其余照记 */
  }
}

function readRing(): JankRecord[] {
  try {
    return JSON.parse(localStorage.getItem(RING_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function persist(rec: JankRecord) {
  try {
    const ring = readRing();
    ring.push(rec);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    localStorage.setItem(RING_KEY, JSON.stringify(ring));
  } catch {
    /* 配额满/隐私模式:不影响主流程 */
  }
  void fetch('/api/client-jank', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rec),
    keepalive: true,
  }).catch(() => {});
}

/** 纯函数:根据心跳迟到量与现场拼一条记录(可测) */
export function buildRecord(
  stallMs: number,
  now: number,
  ctx: {
    view: string;
    visibility: string;
    interaction: Interaction | null;
    inflight: Iterable<string>;
    recent: { url: string; ms: number; doneAt: number }[];
    scripts: { at: number; desc: string }[];
    ua: string;
  },
): JankRecord {
  const stallStart = now - stallMs;
  return {
    at: new Date().toISOString(),
    stallMs: Math.round(stallMs),
    view: ctx.view,
    visibility: ctx.visibility,
    sinceInteractionMs: ctx.interaction ? Math.round(stallStart - ctx.interaction.at) : null,
    interaction: ctx.interaction,
    inflight: [...ctx.inflight].map((k) => k.split('#')[0] ?? k),
    recent: ctx.recent.filter((r) => r.doneAt >= stallStart - 5000).map(({ url, ms }) => ({ url, ms })),
    scripts: ctx.scripts.filter((s) => s.at >= stallStart - 1000).map((s) => s.desc),
    ua: ctx.ua,
  };
}

/**
 * 密集小卡顿(纯函数,可测):最近 DENSE_WINDOW_MS 内心跳迟到量之和 ≥ DENSE_SUM_MS。
 * 单次冻结不到 STALL_MS 的一串任务连起来同样让人觉得「卡」——接回会话时
 * 几十条消息逐条渲染就是这种形态(实测单个都在 100~400ms,记录器却一条不记)。
 * 返回本窗口的迟到总和,达标则由调用方记一条 dense 记录并清空窗口。
 */
export const DENSE_WINDOW_MS = 3000;
export const DENSE_SUM_MS = 1000;
export function denseLateness(samples: { at: number; late: number }[], now: number, windowMs = DENSE_WINDOW_MS): number {
  let sum = 0;
  for (const s of samples) if (s.at >= now - windowMs) sum += s.late;
  return sum;
}

/** 心跳迟到多少算冻结(纯函数,可测):expected 是定时器应到期的时刻 */
export function lateBy(now: number, expected: number): number {
  return Math.max(0, now - expected);
}

let started = false;
export function startJankRecorder() {
  if (started || typeof window === 'undefined') return;
  started = true;
  hookFetch();
  hookLoaf();
  let expected = performance.now() + HEARTBEAT_MS;
  let lateSamples: { at: number; late: number }[] = [];
  const tick = () => {
    const now = performance.now();
    const late = lateBy(now, expected);
    const visible = document.visibilityState === 'visible';
    // 密集小卡顿:一串 100~400ms 的任务连成一片,单次不过门槛也要记
    if (visible && late > 50) {
      lateSamples.push({ at: now, late });
      lateSamples = lateSamples.filter((s) => s.at >= now - DENSE_WINDOW_MS);
      const sum = denseLateness(lateSamples, now);
      if (late < STALL_MS && sum >= DENSE_SUM_MS) {
        lateSamples = [];
        persist({
          ...buildRecord(sum, now, {
            view: location.hash.slice(1) || 'dashboard',
            visibility: document.visibilityState,
            interaction: lastInteraction,
            inflight: inflight.keys(),
            recent,
            scripts: loafScripts,
            ua: navigator.userAgent,
          }),
          dense: true,
        });
      }
    }
    // 页面藏在后台时定时器会被节流,迟到不算冻结
    if (late >= STALL_MS && visible) {
      lateSamples = [];
      persist(
        buildRecord(late, now, {
          view: location.hash.slice(1) || 'dashboard',
          visibility: document.visibilityState,
          interaction: lastInteraction,
          inflight: inflight.keys(),
          recent,
          scripts: loafScripts,
          ua: navigator.userAgent,
        }),
      );
    }
    expected = performance.now() + HEARTBEAT_MS;
    setTimeout(tick, HEARTBEAT_MS);
  };
  setTimeout(tick, HEARTBEAT_MS);
  // 顺手记一下全局点击:交互种类不明时至少知道点了什么
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target as HTMLElement | null;
      const card = el?.closest?.('.scard') as HTMLElement | null;
      if (card) return; // 卡片点击由 Sessions 用 noteInteraction 精确记录(含入口)
      const t = el?.closest?.('button, a, [role=button]') as HTMLElement | null;
      if (t) noteInteraction('click', { text: (t.textContent ?? '').trim().slice(0, 40), cls: t.className.toString().slice(0, 60) });
    },
    true,
  );
  // 调试入口:控制台 __xuanjiJank() 直接看本机记录
  (window as unknown as { __xuanjiJank: () => JankRecord[] }).__xuanjiJank = readRing;
}
