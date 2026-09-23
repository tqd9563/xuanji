/**
 * 系统监控前端状态:/ws/sysmon 订阅 + 弹窗开关/定位 + 卡片数字的判定。
 *
 * 连接即「有人在看」:标签页隐藏时主动断开,后端据此暂停采样(设置 › 无人查看时暂停);
 * 回到前台重连,后端连上即补采一次。两项监控都关时不连。
 */
import { useEffect, useState } from 'react';
import type { MonLevel, SysmonSnapshot } from '@/api/types';
import type { CardMetric } from '@/lib/prefs';

/* ---------- 格式化(与原型同口径:<1000M 显示 M,否则一位小数 G) ---------- */
const MB = 1024 * 1024;
export function fmtMem(bytes: number): string {
  const m = bytes / MB;
  return m < 1000 ? `${Math.round(m)}M` : `${(m / 1024).toFixed(1)}G`;
}
export const fmtG = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
/** %CPU:≥100 取整,否则一位小数 */
export function fmtCpu(v: number): string {
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}%`;
}

/* ---------- 快照订阅 ---------- */
let snap: SysmonSnapshot | null = null;
let ws: WebSocket | null = null;
let wanted = false;
let retry: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function open() {
  if (ws || !wanted || document.hidden) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws/sysmon`);
  ws = sock;
  sock.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'sysmon') {
        snap = msg.snap as SysmonSnapshot;
        emit();
      }
    } catch {
      /* ignore */
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (wanted && !document.hidden && !retry) retry = setTimeout(() => ((retry = null), open()), 3000);
  };
}

function close() {
  if (retry) clearTimeout(retry);
  retry = null;
  const s = ws;
  ws = null;
  s?.close();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => (document.hidden ? close() : open()));
}

/** enabled = 任一监控开着;两者都关时断开并清空 */
export function useSysmon(enabled: boolean): SysmonSnapshot | null {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  useEffect(() => {
    wanted = enabled;
    if (enabled) open();
    else {
      close();
      snap = null;
      emit();
    }
  }, [enabled]);
  return snap;
}

/* ---------- 弹窗:哪个 tab、定位到哪个会话 ---------- */
export type MonTab = 'mem' | 'cpu';
export interface MonUi {
  open: boolean;
  tab: MonTab;
  /** 从卡片数字进来时要高亮的会话;nonce 让同一会话重复点击也能重新定位 */
  focus: { sessionId: string; nonce: number } | null;
}
let ui: MonUi = { open: false, tab: 'mem', focus: null };
const uiSubs = new Set<() => void>();
const setUi = (next: MonUi) => {
  ui = next;
  uiSubs.forEach((f) => f());
};
let nonce = 0;

/** 状态栏指示器:再点同一枚 = 关;弹窗开着时点另一枚 = 切 tab */
export function toggleMonitor(tab: MonTab) {
  setUi(ui.open && ui.tab === tab ? { ...ui, open: false, focus: null } : { open: true, tab, focus: null });
}
export function openMonitor(tab: MonTab, sessionId?: string) {
  setUi({ open: true, tab, focus: sessionId ? { sessionId, nonce: ++nonce } : null });
}
export function setMonitorTab(tab: MonTab) {
  setUi({ ...ui, tab, focus: null });
}
export function closeMonitor() {
  if (ui.open) setUi({ ...ui, open: false, focus: null });
}
export function useMonitorUi(): MonUi {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    uiSubs.add(f);
    return () => void uiSubs.delete(f);
  }, []);
  return ui;
}

/* ---------- 看板把卡片名告诉弹窗(排行里的会话进程行用看板上的名字) ---------- */
let boardNames: Record<string, string> = {};
export function noteSessionNames(names: Record<string, string>) {
  boardNames = names;
}
export function sessionLabel(s: SysmonSnapshot | null, sessionId: string): string {
  return boardNames[sessionId] ?? s?.sessionNames[sessionId] ?? sessionId.slice(0, 8);
}

/* ---------- 卡片数字判定 ---------- */
const GiB = 1024 ** 3;
export type ChipLevel = 'ok' | 'warn' | 'hot';
export function memChipLevel(bytes: number): ChipLevel {
  return bytes >= 3 * GiB ? 'hot' : bytes >= GiB ? 'warn' : 'ok';
}
export function cpuChipLevel(pct: number): ChipLevel {
  return pct >= 300 ? 'hot' : pct >= 80 ? 'warn' : 'ok';
}
/** CPU「偏高」= 占整机 ≥ 黄色阈值,或单会话 ≥ 50%(半个核) */
export function cpuHigh(pct: number, ncpu: number, warn: number): boolean {
  return (pct / (Math.max(1, ncpu) * 100)) * 100 >= warn || pct >= 50;
}
export function showMetric(mode: CardMetric, high: boolean): boolean {
  return mode === 'always' || (mode === 'high' && high);
}

export const LEVEL_PILL: Record<MonLevel, [string, string]> = {
  ok: ['pill-done', '压力正常'],
  warn: ['pill-blk', '压力警告'],
  crit: ['pill-err', '压力严重'],
};
