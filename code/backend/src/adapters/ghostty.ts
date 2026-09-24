/**
 * 读本机终端环境,给「全局终端」的外观跟随与快捷键冲突检测用。只读,永不写。
 *
 * 两类非公开格式都隔离在这里(架构铁律 1):
 * - Ghostty 配置文件与主题文件(`key = value` 行格式,键可重复)
 * - macOS 系统快捷键表 com.apple.symbolichotkeys(AppleSymbolicHotKeys 字典)
 *
 * 字体不按配置写的名字来,而是问 Ghostty 自己「实际用哪个 face 渲染」:
 * 配置写了未安装的字体时 Ghostty 会静默回退到内置 JetBrains Mono(2026-09-24 本机实测),
 * 照配置抄名字会让璇玑和用户眼睛看到的对不上。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const GHOSTTY_APP = '/Applications/Ghostty.app';
const GHOSTTY_BIN = path.join(GHOSTTY_APP, 'Contents/MacOS/ghostty');
const GHOSTTY_THEMES = path.join(GHOSTTY_APP, 'Contents/Resources/ghostty/themes');

export interface TermTheme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  /** 16 色 ANSI 调色板,下标即 palette 序号 */
  palette: string[];
}

export interface GhosttyInfo {
  version: string | null;
  configPath: string;
  theme: TermTheme | null;
  /** 配置里写的字体名 */
  fontConfigured: string | null;
  /** Ghostty 实际渲染用的字体(读不到时为 null,前端按 fontConfigured 兜底) */
  fontActual: string | null;
  fontSize: number;
  /** 0–100 */
  opacity: number;
  blur: number;
  cursorStyle: 'bar' | 'block' | 'underline';
  cursorBlink: boolean;
  /** Ghostty 注册的全局热键,已归一成璇玑 keymap 的组合串(如 `mod+\``) */
  globalKeys: string[];
  /** Ghostty 的启动命令(`command = ...`);未设置时为 null */
  command: string | null;
}

/* ---------------- 纯解析(可单测) ---------------- */

/** `key = value` 行 → 有序键值对;注释与空行丢弃,值两侧引号去掉,重复键全部保留 */
export function parseKv(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out.push([k, v]);
  }
  return out;
}

const last = (kv: [string, string][], key: string) => {
  for (let i = kv.length - 1; i >= 0; i--) if (kv[i]![0] === key) return kv[i]![1];
  return undefined;
};

/** `palette = N=#hex` 与 background/foreground 等,后写覆盖先写 */
export function applyColors(base: TermTheme, kv: [string, string][]): TermTheme {
  const t: TermTheme = { ...base, palette: [...base.palette] };
  for (const [k, v] of kv) {
    if (k === 'palette') {
      const m = /^(\d{1,2})\s*=\s*(#[0-9a-fA-F]{6})$/.exec(v);
      if (m && Number(m[1]) < 16) t.palette[Number(m[1])] = m[2]!.toLowerCase();
    } else if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      if (k === 'background') t.background = v.toLowerCase();
      else if (k === 'foreground') t.foreground = v.toLowerCase();
      else if (k === 'cursor-color') t.cursor = v.toLowerCase();
      else if (k === 'selection-background') t.selection = v.toLowerCase();
    }
  }
  return t;
}

/** `theme = light:X,dark:Y` 取 dark(璇玑恒为深色);单值直接用 */
export function pickThemeName(v: string | undefined): string | null {
  if (!v) return null;
  if (!v.includes(':')) return v.trim() || null;
  const parts = Object.fromEntries(
    v.split(',').map((p) => {
      const [a, ...b] = p.split(':');
      return [a!.trim(), b.join(':').trim()];
    }),
  );
  return parts.dark || parts.light || null;
}

/** Ghostty 键名 → 璇玑 keymap 串。只认识能在网页里被 KeyboardEvent 表达的那部分 */
const GHOSTTY_KEY: Record<string, string> = {
  grave_accent: '`',
  backquote: '`',
  space: ' ',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  minus: '-',
  equal: '=',
};

export function ghosttyComboToKeymap(combo: string): string | null {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);
  const name = GHOSTTY_KEY[key] ?? (/^[a-z0-9]$/.test(key) ? key : null);
  if (!name) return null;
  const out: string[] = [];
  if (mods.has('cmd') || mods.has('super') || mods.has('command')) out.push('mod');
  if (mods.has('ctrl') || mods.has('control')) out.push('ctrl');
  if (mods.has('alt') || mods.has('opt') || mods.has('option')) out.push('alt');
  if (mods.has('shift')) out.push('shift');
  out.push(name);
  return out.join('+');
}

/** 只有 `global:` 前缀的绑定会跨应用截键;普通绑定只在 Ghostty 自己窗口里生效,不构成冲突 */
export function globalKeybinds(kv: [string, string][]): string[] {
  const out: string[] = [];
  for (const [k, v] of kv) {
    if (k !== 'keybind') continue;
    const m = /^((?:[a-z_]+:)*)([^=]+)=/.exec(v.trim());
    if (!m) continue;
    const prefixes = m[1]!.split(':').filter(Boolean);
    if (!prefixes.includes('global')) continue;
    const combo = ghosttyComboToKeymap(m[2]!.trim());
    if (combo) out.push(combo);
  }
  return out;
}

export function parseCursorStyle(v: string | undefined): GhosttyInfo['cursorStyle'] {
  if (v === 'block' || v === 'underline' || v === 'bar') return v;
  if (v === 'block_hollow') return 'block';
  return 'block';
}

/* ---------------- macOS 系统快捷键 ---------------- */

export interface SysHotkey {
  id: number;
  name: string;
  combo: string;
  enabled: boolean;
}

/** 只收录会和网页快捷键撞车、且用户认得出名字的那几项 */
const SYS_HOTKEY_NAMES: Record<number, string> = {
  27: '移动焦点到下一个窗口',
  60: '选择上一个输入法',
  61: '选择输入法菜单中的下一个输入法',
  64: '显示聚焦搜索',
};

/** AppleSymbolicHotKeys 的 parameters = [字符码, 虚拟键码, 修饰位掩码] */
export function symbolicToKeymap(params: unknown): string | null {
  if (!Array.isArray(params) || params.length < 3) return null;
  const [ch, , mask] = params as number[];
  let name: string | null = null;
  if (typeof ch === 'number' && ch >= 33 && ch < 127) name = String.fromCharCode(ch).toLowerCase();
  else if (ch === 32) name = ' ';
  if (!name) return null;
  const m = Number(mask) || 0;
  const out: string[] = [];
  if (m & 0x100000) out.push('mod');
  if (m & 0x40000) out.push('ctrl');
  if (m & 0x80000) out.push('alt');
  if (m & 0x20000) out.push('shift');
  out.push(name);
  return out.join('+');
}

export function parseSymbolicHotkeys(json: unknown): SysHotkey[] {
  const dict = (json ?? {}) as Record<string, { enabled?: boolean; value?: { parameters?: unknown } }>;
  const out: SysHotkey[] = [];
  for (const [idStr, name] of Object.entries(SYS_HOTKEY_NAMES)) {
    const e = dict[idStr];
    if (!e) continue;
    const combo = symbolicToKeymap(e.value?.parameters);
    if (combo) out.push({ id: Number(idStr), name, combo, enabled: e.enabled !== false });
  }
  return out;
}

export async function readSystemHotkeys(): Promise<SysHotkey[]> {
  if (process.platform !== 'darwin') return [];
  const plist = path.join(os.homedir(), 'Library/Preferences/com.apple.symbolichotkeys.plist');
  if (!fs.existsSync(plist)) return [];
  try {
    const { stdout } = await execFileP('/usr/bin/plutil', ['-extract', 'AppleSymbolicHotKeys', 'json', '-o', '-', plist], {
      timeout: 3000,
    });
    return parseSymbolicHotkeys(JSON.parse(stdout));
  } catch {
    return [];
  }
}

/* ---------------- Ghostty ---------------- */

export function ghosttyConfigCandidates(home = os.homedir()): string[] {
  return [
    path.join(home, 'Library/Application Support/com.mitchellh.ghostty/config.ghostty'),
    path.join(home, 'Library/Application Support/com.mitchellh.ghostty/config'),
    path.join(home, '.config/ghostty/config.ghostty'),
    path.join(home, '.config/ghostty/config'),
  ];
}

function readThemeFile(name: string, home = os.homedir()): string | null {
  for (const dir of [path.join(home, '.config/ghostty/themes'), GHOSTTY_THEMES]) {
    const p = path.join(dir, name);
    // 主题名来自用户配置,仍防一手目录穿越
    if (path.dirname(p) !== dir) continue;
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* 下一个目录 */
    }
  }
  return null;
}

const EMPTY_THEME: TermTheme = {
  name: '',
  background: '#282c34',
  foreground: '#ffffff',
  cursor: '#ffffff',
  selection: '#44475a',
  palette: Array(16).fill('#888888'),
};

async function ghosttyExec(args: string[]): Promise<string | null> {
  if (!fs.existsSync(GHOSTTY_BIN)) return null;
  try {
    const { stdout } = await execFileP(GHOSTTY_BIN, args, { timeout: 3000 });
    return stdout;
  } catch {
    return null;
  }
}

export async function readGhostty(home = os.homedir()): Promise<GhosttyInfo | null> {
  const configPath = ghosttyConfigCandidates(home).find((p) => fs.existsSync(p));
  if (!configPath) return null;
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  const kv = parseKv(text);
  const themeName = pickThemeName(last(kv, 'theme'));
  let theme: TermTheme | null = null;
  if (themeName) {
    const tf = readThemeFile(themeName, home);
    if (tf) theme = applyColors({ ...EMPTY_THEME, name: themeName }, parseKv(tf));
  }
  // 配置里直接写的颜色覆盖主题
  if (theme) theme = applyColors(theme, kv);

  const [versionOut, faceOut] = await Promise.all([ghosttyExec(['+version']), ghosttyExec(['+show-face', '--cp=65'])]);
  const version = versionOut?.split('\n')[0]?.replace(/^Ghostty\s*/, '').trim() || null;
  const face = faceOut ? /face\s+[“"]([^”"]+)[”"]/.exec(faceOut)?.[1] ?? null : null;

  const fontSize = Number(last(kv, 'font-size'));
  const opacity = Number(last(kv, 'background-opacity'));
  const blurRaw = last(kv, 'background-blur-radius') ?? last(kv, 'background-blur');
  // `background-blur = true` 在 Ghostty 里等价于 20
  const blur = blurRaw === 'true' ? 20 : Number(blurRaw);
  return {
    version,
    configPath,
    theme,
    fontConfigured: last(kv, 'font-family') ?? null,
    fontActual: face,
    fontSize: Number.isFinite(fontSize) && fontSize >= 8 && fontSize <= 40 ? fontSize : 13,
    opacity: Number.isFinite(opacity) && opacity > 0 && opacity <= 1 ? Math.round(opacity * 100) : 100,
    blur: Number.isFinite(blur) && blur >= 0 ? Math.min(Math.round(blur), 60) : 0,
    cursorStyle: parseCursorStyle(last(kv, 'cursor-style')),
    cursorBlink: last(kv, 'cursor-style-blink') !== 'false',
    globalKeys: globalKeybinds(kv),
    command: last(kv, 'command') ?? null,
  };
}

/**
 * 同步读 Ghostty 的 `command`:起 shell 的路径是同步的,且只需这一项,不必走完整 readGhostty。
 * 用户在 Ghostty 里写死启动命令通常有原因(本机实例:登录 shell 是 x86_64 的旧 Homebrew zsh,
 * Ghostty 用 `arch -arm64 /bin/zsh --login` 绕开),跟随它才能和 Ghostty 行为一致。
 */
export function readGhosttyCommandSync(home = os.homedir()): string | null {
  const p = ghosttyConfigCandidates(home).find((x) => fs.existsSync(x));
  if (!p) return null;
  try {
    return last(parseKv(fs.readFileSync(p, 'utf8')), 'command')?.trim() || null;
  } catch {
    return null;
  }
}

/** 按空白切分命令行,支持成对的单/双引号(Ghostty `command` 的写法就这么简单) */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
