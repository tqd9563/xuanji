/**
 * 壁纸背景:状态模型 + 内置预设 + localStorage 持久化 + DOM 应用。
 * 设计规范来源:wiki/design/prototype.html 壁纸演示(2026-07-14 获批,默认 40/30/0/0)。
 * 只存本机浏览器(localStorage),不写 ~/.claude(架构铁律:只读优先)。
 */
import { useCallback, useEffect, useState } from 'react';

export type WallMode = 'off' | 'wall' | 'glass';

export interface WallState {
  mode: WallMode;
  /** 'preset:<id>' | 'custom'(本地图片 dataURL) | 其它任意 URL */
  src: string;
  /** 壁纸不透明度 % */
  opacity: number;
  /** 壁纸全局模糊 px */
  blur: number;
  /** 玻璃档:面板底色不透明度 % */
  surface: number;
  /** 玻璃档:面板毛玻璃模糊 px */
  frost: number;
  /** 本地图片 dataURL(过大时不持久化,仅本次会话生效) */
  custom: string;
}

/** 用户获批默认值:不透明度 40% / 表面 30% / 模糊 0 / 磨砂 0 */
export const WALL_DEFAULTS: WallState = {
  mode: 'off',
  src: 'preset:xingye',
  opacity: 40,
  blur: 0,
  surface: 30,
  frost: 0,
  custom: '',
};

const STORAGE_KEY = 'xuanji.wall';
/** dataURL 超过此长度不写 localStorage(5MB 配额保护) */
const PERSIST_MAX = 1_500_000;

function wallSvg(body: string): string {
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">${body}</svg>`,
    )
  );
}

/** 星野:观象台夜空。北斗七星微亮,天璇·天玑二星以玉色致意产品本名 */
function presetXingye(): string {
  const rnd = (i: number) => Math.sin(i * 127.1 + 311.7) * 0.5 + 0.5;
  let stars = '';
  for (let i = 0; i < 150; i++) {
    const x = (rnd(i) * 1600).toFixed(0);
    const y = (rnd(i + 500) * 1000).toFixed(0);
    const r = (0.5 + rnd(i + 900) * 1.2).toFixed(1);
    const o = (0.12 + rnd(i + 1300) * 0.45).toFixed(2);
    stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="#cdd8c2" opacity="${o}"/>`;
  }
  /* 北斗:天枢-天璇-天玑-天权 构斗,玉衡-开阳-摇光 为柄 */
  const dipper: [number, number][] = [
    [1108, 318], [1180, 268], [1262, 282], [1330, 338], [1296, 428], [1392, 470], [1472, 404],
  ];
  const line = dipper.map((p) => p.join(',')).join(' ');
  const named = [1, 2]; /* 天璇、天玑 */
  const ds = dipper
    .map(
      ([x, y], i) =>
        `<circle cx="${x}" cy="${y}" r="${named.includes(i) ? 3.2 : 2.2}" fill="${named.includes(i) ? '#b8cf8f' : '#cdd8c2'}" opacity="${named.includes(i) ? 0.95 : 0.7}"/>` +
        (named.includes(i)
          ? `<circle cx="${x}" cy="${y}" r="8" fill="none" stroke="#b8cf8f" stroke-width="0.6" opacity="0.35"/>`
          : ''),
    )
    .join('');
  return wallSvg(
    `<defs><radialGradient id="sky" cx="35%" cy="18%" r="95%">
      <stop offset="0" stop-color="#1a2116"/><stop offset="0.55" stop-color="#11150d"/><stop offset="1" stop-color="#0a0d08"/>
    </radialGradient></defs>
    <rect width="1600" height="1000" fill="url(#sky)"/>
    <ellipse cx="480" cy="180" rx="520" ry="300" fill="#25301c" opacity="0.18"/>
    ${stars}<polyline points="${line}" fill="none" stroke="#8fa878" stroke-width="0.8" opacity="0.28"/>${ds}`,
  );
}

/** 山岚:层叠远山 + 谷间雾 */
function presetShanlan(): string {
  return wallSvg(
    `<defs>
      <linearGradient id="mist" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#161c11" stop-opacity="0"/><stop offset="1" stop-color="#1c2415" stop-opacity="0.5"/>
      </linearGradient>
      <linearGradient id="air" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#171d12"/><stop offset="1" stop-color="#0e120a"/>
      </linearGradient>
    </defs>
    <rect width="1600" height="1000" fill="url(#air)"/>
    <path d="M0 560 L240 380 L430 520 L640 330 L860 540 L1080 400 L1300 560 L1470 460 L1600 540 L1600 1000 L0 1000 Z" fill="#131a0e" opacity="0.9"/>
    <rect y="480" width="1600" height="240" fill="url(#mist)"/>
    <path d="M0 700 L300 540 L560 680 L840 520 L1120 700 L1380 590 L1600 690 L1600 1000 L0 1000 Z" fill="#0f150b"/>
    <path d="M0 840 L360 700 L720 830 L1060 690 L1420 840 L1600 780 L1600 1000 L0 1000 Z" fill="#0b0f08"/>`,
  );
}

export const WALL_PRESETS: { id: string; name: string; url: string }[] = [
  { id: 'xingye', name: '星野', url: presetXingye() },
  { id: 'shanlan', name: '山岚', url: presetShanlan() },
];

export function wallSrcUrl(w: WallState): string {
  if (w.src === 'custom') return w.custom || '';
  if (w.src.startsWith('preset:')) {
    const p = WALL_PRESETS.find((p) => p.id === w.src.slice(7));
    return p ? p.url : WALL_PRESETS[0]!.url;
  }
  return w.src || '';
}

export function wallSrcName(w: WallState): string {
  if (w.src === 'custom') return '本地图片';
  if (w.src.startsWith('preset:')) {
    return (WALL_PRESETS.find((p) => p.id === w.src.slice(7)) ?? WALL_PRESETS[0]!).name;
  }
  return 'URL';
}

function loadWall(): WallState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return WALL_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<WallState>;
    return { ...WALL_DEFAULTS, ...parsed };
  } catch {
    return WALL_DEFAULTS;
  }
}

function saveWall(w: WallState) {
  try {
    const persist = { ...w };
    if (persist.custom && persist.custom.length > PERSIST_MAX) persist.custom = '';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
  } catch {
    /* 配额不足时静默放弃持久化 */
  }
}

/** 本地图片是否会因体积放弃持久化(用于 UI 提示) */
export function isEphemeralCustom(w: WallState): boolean {
  return w.src === 'custom' && w.custom.length > PERSIST_MAX;
}

/**
 * 壁纸状态 hook:读取持久化状态,变更时应用到 <body>(类名 + CSS 变量)并回写 localStorage。
 * 壁纸图层本身由调用方渲染 <div id="wall"> 并以 wallSrcUrl(w) 为背景。
 */
export function useWallpaper(): [WallState, (patch: Partial<WallState>) => void] {
  const [wall, setWall] = useState<WallState>(loadWall);

  useEffect(() => {
    const url = wallSrcUrl(wall);
    const on = wall.mode !== 'off' && !!url;
    const body = document.body;
    body.classList.toggle('wall-on', on);
    body.classList.toggle('wall-glass', on && wall.mode === 'glass');
    body.style.setProperty('--wall-opacity', String(wall.opacity / 100));
    body.style.setProperty('--wall-blur', `${wall.blur}px`);
    body.style.setProperty('--wall-surface', `${wall.surface}%`);
    body.style.setProperty('--wall-frost', `${wall.frost}px`);
    saveWall(wall);
  }, [wall]);

  const patch = useCallback((p: Partial<WallState>) => setWall((w) => ({ ...w, ...p })), []);
  return [wall, patch];
}
