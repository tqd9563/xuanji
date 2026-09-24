/**
 * 全局终端的前端状态与纯逻辑(DESIGN.md「全局终端」)。
 *
 * - 外观偏好属「本机」:单独存 localStorage `xuanji.term`(不并入 xuanji.prefs——它有自己的
 *   背景图片要进 IndexedDB,与壁纸同一处理方式);行为偏好(默认目录/切视图)属「账户」,在 AccountPrefs.terminal。
 * - 默认「跟随 Ghostty」:主题、字体、透明度都取本机 Ghostty 配置;任一项被改即整体转「自定义」。
 * - 这里只放可单测的纯函数和一个极小的订阅式 store;xterm 实例归组件管。
 */
import { useEffect, useState } from 'react';
import type { GhosttyInfo, SysHotkey, TermInfo, TermSessionInfo, TermTheme } from '@/api/types';
import { idbDelete, idbGet, idbPut, STORE_WALLPAPER } from '@/lib/idb';
import { comboOf, type KeyLike } from '@/lib/keymap';

/* ---------------- 内置主题(16 色逐字照抄 Ghostty.app 自带主题文件) ---------------- */

const t = (name: string, background: string, foreground: string, cursor: string, selection: string, p: string): TermTheme => ({
  name,
  background,
  foreground,
  cursor,
  selection,
  palette: p.split(' '),
});

export const XUANJI_THEME = '璇玑 · 玉';

export const BUILTIN_THEMES: TermTheme[] = [
  t('Catppuccin Frappe', '#303446', '#c6d0f5', '#f2d5cf', '#626880',
    '#51576d #e78284 #a6d189 #e5c890 #8caaee #f4b8e4 #81c8be #a5adce #626880 #e67172 #8ec772 #d9ba73 #7b9ef0 #f2a4db #5abfb5 #b5bfe2'),
  t('Catppuccin Macchiato', '#24273a', '#cad3f5', '#f4dbd6', '#5b6078',
    '#494d64 #ed8796 #a6da95 #eed49f #8aadf4 #f5bde6 #8bd5ca #a5adcb #5b6078 #ec7486 #8ccf7f #e1c682 #78a1f6 #f2a9dd #63cbc0 #b8c0e0'),
  t('Catppuccin Mocha', '#1e1e2e', '#cdd6f4', '#f5e0dc', '#585b70',
    '#45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8 #585b70 #f37799 #89d88b #ebd391 #74a8fc #f2aede #6bd7ca #bac2de'),
  t('Catppuccin Latte', '#eff1f5', '#4c4f69', '#dc8a78', '#acb0be',
    '#5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #de293e #49af3d #eea02d #456eff #fe85d8 #2d9fa8 #bcc0cc'),
  // 璇玑自有:近黑玉调底(与 --bg 同色相),状态色沿用站内语义色的 sRGB 近似
  t(XUANJI_THEME, '#10130e', '#e6e9dc', '#c9da7a', '#3a4133',
    '#2a2f25 #e36d68 #8fcf94 #e3b65a #86b2e6 #bb9de0 #6fcac0 #b9bfae #6d7466 #f07f7a #a2dca6 #efc670 #9cc2ee #caaee9 #84d6cc #e6e9dc'),
];

export const themeByName = (name: string | null | undefined): TermTheme | null =>
  BUILTIN_THEMES.find((x) => x.name === name) ?? null;

/* ---------------- 本机外观偏好 ---------------- */

export type CursorStyle = 'bar' | 'block' | 'underline';

export interface TermLook {
  mode: 'ghostty' | 'custom';
  theme: string;
  fontSize: number;
  opacity: number;
  blur: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** 自定义背景色;null = 跟随主题 */
  bg: string | null;
  /** 是否有背景图(图本体在 IndexedDB) */
  hasImg: boolean;
  imgOpacity: number;
  /** 浮层高度(px),拖拽调整后记住 */
  height: number;
}

export const LOOK_DEFAULTS: TermLook = {
  mode: 'ghostty',
  theme: XUANJI_THEME,
  fontSize: 13,
  opacity: 100,
  blur: 0,
  cursorStyle: 'block',
  cursorBlink: true,
  bg: null,
  hasImg: false,
  imgOpacity: 35,
  height: 340,
};

const LOOK_KEY = 'xuanji.term';
const IMG_KEY = 'terminal-bg';

const inRange = (v: unknown, lo: number, hi: number, fb: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : fb;

export function normalizeLook(raw: unknown): TermLook {
  const o = (raw ?? {}) as Partial<TermLook>;
  return {
    mode: o.mode === 'custom' ? 'custom' : 'ghostty',
    // 不限于内置表:用户 Ghostty 的主题可能不在里面,解析不到时由 resolveLook 回退
    theme: typeof o.theme === 'string' && o.theme.trim() && o.theme.length <= 80 ? o.theme : LOOK_DEFAULTS.theme,
    fontSize: inRange(o.fontSize, 11, 20, LOOK_DEFAULTS.fontSize),
    opacity: inRange(o.opacity, 30, 100, LOOK_DEFAULTS.opacity),
    blur: inRange(o.blur, 0, 40, LOOK_DEFAULTS.blur),
    cursorStyle: o.cursorStyle === 'bar' || o.cursorStyle === 'underline' || o.cursorStyle === 'block' ? o.cursorStyle : LOOK_DEFAULTS.cursorStyle,
    cursorBlink: typeof o.cursorBlink === 'boolean' ? o.cursorBlink : LOOK_DEFAULTS.cursorBlink,
    bg: typeof o.bg === 'string' && /^#[0-9a-f]{6}$/i.test(o.bg) ? o.bg.toLowerCase() : null,
    hasImg: o.hasImg === true,
    imgOpacity: inRange(o.imgOpacity, 5, 100, LOOK_DEFAULTS.imgOpacity),
    height: inRange(o.height, 140, 4000, LOOK_DEFAULTS.height),
  };
}

/** 真正生效的外观:跟随态由 Ghostty 配置决定,自定义态由本机偏好决定 */
export interface ResolvedLook {
  theme: TermTheme;
  fontName: string;
  /** 字体来由,给设置页那行说明用 */
  fontNote: string;
  fontSize: number;
  opacity: number;
  blur: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  background: string;
  imgOpacity: number;
  hasImg: boolean;
}

export function ghosttyLook(g: GhosttyInfo | null): Omit<TermLook, 'mode' | 'bg' | 'hasImg' | 'imgOpacity' | 'height'> & { themeObj: TermTheme } {
  if (!g) {
    const x = themeByName(XUANJI_THEME)!;
    return { theme: x.name, themeObj: x, fontSize: 13, opacity: 100, blur: 0, cursorStyle: 'block', cursorBlink: true };
  }
  const themeObj = g.theme ?? themeByName(XUANJI_THEME)!;
  return {
    theme: themeObj.name,
    themeObj,
    fontSize: Math.min(20, Math.max(11, g.fontSize)),
    opacity: Math.max(30, g.opacity),
    blur: Math.min(40, g.blur),
    cursorStyle: g.cursorStyle,
    cursorBlink: g.cursorBlink,
  };
}

export function fontNoteOf(g: GhosttyInfo | null): { name: string; note: string } {
  if (!g) return { name: 'JetBrains Mono', note: '未找到 Ghostty 配置,用璇玑内置的 JetBrains Mono' };
  const conf = g.fontConfigured;
  const actual = g.fontActual;
  if (actual && conf && actual !== conf)
    return { name: actual, note: `Ghostty 配置写的 ${conf} 本机未安装,Ghostty 实际回退到 ${actual};这里照实际渲染的来` };
  if (actual) return { name: actual, note: `与 Ghostty 实际渲染一致` };
  if (conf) return { name: conf, note: `取自 Ghostty 配置 font-family` };
  return { name: 'JetBrains Mono', note: 'Ghostty 未指定字体,用其内置默认 JetBrains Mono' };
}

export function resolveLook(look: TermLook, g: GhosttyInfo | null): ResolvedLook {
  const gl = ghosttyLook(g);
  const font = fontNoteOf(g);
  if (look.mode === 'ghostty') {
    return {
      theme: gl.themeObj,
      fontName: font.name,
      fontNote: font.note,
      fontSize: gl.fontSize,
      opacity: gl.opacity,
      blur: gl.blur,
      cursorStyle: gl.cursorStyle,
      cursorBlink: gl.cursorBlink,
      background: gl.themeObj.background,
      imgOpacity: look.imgOpacity,
      hasImg: false,
    };
  }
  // 自定义态的主题:选中的是 Ghostty 自己的主题名时用 Ghostty 解析出的那份(可能不在内置表里)
  const theme = (g?.theme && look.theme === g.theme.name ? g.theme : null) ?? themeByName(look.theme) ?? gl.themeObj;
  return {
    theme,
    fontName: font.name,
    fontNote: font.note,
    fontSize: look.fontSize,
    opacity: look.opacity,
    blur: look.blur,
    cursorStyle: look.cursorStyle,
    cursorBlink: look.cursorBlink,
    background: look.bg ?? theme.background,
    imgOpacity: look.imgOpacity,
    hasImg: look.hasImg,
  };
}

/**
 * 改任意外观项:跟随态下先把 Ghostty 的当前值落成自定义起点,再叠这一项。
 * 这样用户只改背景色时,主题/字号/透明度不会跳回璇玑默认值。
 */
export function editLook(look: TermLook, g: GhosttyInfo | null, patch: Partial<TermLook>): TermLook {
  let base = look;
  if (look.mode === 'ghostty') {
    const gl = ghosttyLook(g);
    base = {
      ...look,
      mode: 'custom',
      theme: gl.theme,
      fontSize: gl.fontSize,
      opacity: gl.opacity,
      blur: gl.blur,
      cursorStyle: gl.cursorStyle,
      cursorBlink: gl.cursorBlink,
    };
  }
  return { ...base, ...patch, mode: patch.mode ?? 'custom' };
}

/** 字体栈:首选字体 → 打包的 JetBrains Mono → 本机 Nerd Font(补 p10k 图标)→ 系统等宽 */
export const fontStack = (name: string) =>
  [`"${name}"`, '"JetBrains Mono"', '"Hack Nerd Font"', '"Symbols Nerd Font Mono"', 'ui-monospace', 'Menlo', 'monospace'].join(', ');

/** 终端主题 → xterm ITheme。背景交给浮层自己画(透明度/背景图),xterm 画布保持全透明 */
export function toXtermTheme(th: TermTheme) {
  const p = th.palette;
  return {
    background: '#00000000',
    foreground: th.foreground,
    cursor: th.cursor,
    cursorAccent: th.background,
    selectionBackground: th.selection,
    black: p[0], red: p[1], green: p[2], yellow: p[3], blue: p[4], magenta: p[5], cyan: p[6], white: p[7],
    brightBlack: p[8], brightRed: p[9], brightGreen: p[10], brightYellow: p[11],
    brightBlue: p[12], brightMagenta: p[13], brightCyan: p[14], brightWhite: p[15],
  };
}

/* ---------------- 快捷键 ---------------- */

/**
 * 呼出键匹配。⌘` 在搜狗等中文输入法下 e.key 可能不是 "`"(中文标点态),
 * 故以 `\`` 结尾的组合额外按物理键 Backquote 认一次,修饰键仍须完全一致。
 */
export function matchToggleKey(e: KeyLike, combo: string, isMac?: boolean): boolean {
  if (!combo) return false;
  if (comboOf(e, isMac) === combo) return true;
  if (!combo.endsWith('`') || e.code !== 'Backquote') return false;
  const mods = combo.slice(0, -1);
  const fake = comboOf({ ...e, key: '`' }, isMac);
  return fake === `${mods}\``;
}

export interface KeyConflict {
  who: string;
  fix: string;
}

/** 本机上游是否也占着这个组合:Ghostty 全局热键、macOS 系统快捷键(浏览器保留键页面无从探测) */
export function keyConflicts(combo: string, g: GhosttyInfo | null, sys: SysHotkey[]): KeyConflict[] {
  const out: KeyConflict[] = [];
  if (g?.globalKeys.includes(combo))
    out.push({ who: 'Ghostty 全局热键', fix: '去掉 Ghostty 那行 keybind 的 global: 前缀或改键,然后点「重新读取」' });
  for (const h of sys)
    if (h.enabled && h.combo === combo)
      out.push({ who: `macOS「${h.name}」`, fix: '系统设置 › 键盘 › 键盘快捷键 里关掉或改键,然后点「重新读取」' });
  return out;
}

/* ---------------- 新终端目录 ---------------- */

export function contextCwd(mode: 'session' | 'last' | 'home', dispatchCwd: string | null, lastCwd: string | null): string {
  if (mode === 'home') return '~';
  if (mode === 'session' && dispatchCwd) return dispatchCwd;
  return lastCwd || dispatchCwd || '~';
}

export const shortPath = (p: string, home?: string | null) => {
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
  return p.replace(/^\/Users\/[^/]+/, '~');
};

export const baseName = (p: string) => (p === '~' ? '~' : p.split('/').filter(Boolean).pop() || '/');

/* ---------------- 极小的订阅式 store ---------------- */

export interface TermTab extends TermSessionInfo {
  /** 前端才知道的:连接是否已断(后端重启/会话被关) */
  gone?: boolean;
}

export interface TermState {
  open: boolean;
  max: boolean;
  tabs: TermTab[];
  activeId: string | null;
  /** 派发页当前会话的工作目录(不在派发页时为 null) */
  dispatchCwd: string | null;
  lastCwd: string | null;
  look: TermLook;
  imgUrl: string | null;
  /** /api/terminal/info 的结果;null = 还没拉到 */
  info: TermInfo | null;
}

function loadLook(): TermLook {
  try {
    return normalizeLook(JSON.parse(localStorage.getItem(LOOK_KEY) ?? '{}'));
  } catch {
    return LOOK_DEFAULTS;
  }
}

let state: TermState = {
  open: false,
  max: false,
  tabs: [],
  activeId: null,
  dispatchCwd: null,
  lastCwd: null,
  look: typeof localStorage === 'undefined' ? LOOK_DEFAULTS : loadLook(),
  imgUrl: null,
  info: null,
};
const subs = new Set<() => void>();

export const getTerm = () => state;

export function setTerm(p: Partial<TermState> | ((s: TermState) => Partial<TermState>)) {
  state = { ...state, ...(typeof p === 'function' ? p(state) : p) };
  subs.forEach((f) => f());
}

export function setLook(next: TermLook) {
  const look = normalizeLook(next);
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    /* 存不下不阻断使用 */
  }
  setTerm({ look });
}

export function useTerm(): TermState {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return state;
}

/** 派发页上报当前会话目录;离开派发页时报 null */
export function reportDispatchCwd(cwd: string | null) {
  if (state.dispatchCwd !== cwd) setTerm({ dispatchCwd: cwd });
}

/* ---------------- 背景图(本机 IndexedDB,与壁纸同库同表、不同键) ---------------- */

export async function loadTermImage(): Promise<void> {
  if (!state.look.hasImg) return;
  try {
    const blob = await idbGet<Blob>(STORE_WALLPAPER, IMG_KEY);
    if (blob) setTerm({ imgUrl: URL.createObjectURL(blob) });
    // 图丢了(清过站点数据)就把标记也摘掉,不留一个「有图但显示不出」的状态
    else setLook({ ...state.look, hasImg: false });
  } catch {
    /* 读不到按无图 */
  }
}

export async function saveTermImage(file: Blob): Promise<void> {
  try {
    await idbPut(STORE_WALLPAPER, IMG_KEY, file);
  } catch {
    /* 存不进去时仅本次会话可见 */
  }
  if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
  setTerm({ imgUrl: URL.createObjectURL(file) });
}

export async function clearTermImage(): Promise<void> {
  try {
    await idbDelete(STORE_WALLPAPER, IMG_KEY);
  } catch {
    /* 忽略 */
  }
  if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
  setTerm({ imgUrl: null });
}
