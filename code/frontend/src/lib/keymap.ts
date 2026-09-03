/**
 * 全站键位表:所有快捷键的唯一定义处。
 *
 * 在此之前键位硬编码在十二个组件各自的 keydown 里,既没法给用户看一张完整的表,
 * 也没法查冲突——同一个组合被两处认领,只会表现为「其中一个莫名其妙不灵」。
 *
 * 表示法用小写 token 串:`mod+shift+o`、`alt+arrowup`、`ctrl+x`。
 * `mod` 在 Mac 上是 ⌘、其余平台是 Ctrl(与 VS Code / Chrome 的惯例一致);
 * 修饰键顺序固定 mod → ctrl → alt → shift,便于把组合当字符串直接比对与查重。
 */

export type ActionId =
  | 'global.newSession'
  | 'global.todoCapture'
  | 'global.settings'
  | 'global.prevView'
  | 'global.nextView'
  | 'dispatch.model'
  | 'dispatch.workdir'
  | 'dispatch.turnOutline'
  | 'dispatch.prevTurn'
  | 'dispatch.nextTurn'
  | 'dispatch.inlineCode'
  | 'dispatch.codeBlock'
  | 'sessions.find'
  | 'sessions.close';

export interface KeyAction {
  id: ActionId;
  /** 分组标题,设置里按此分节 */
  group: '全局' | '派发' | '会话看板';
  label: string;
  hint?: string;
}

/** 展示顺序即设置面板里的行序 */
export const KEY_ACTIONS: KeyAction[] = [
  { id: 'global.newSession', group: '全局', label: '新会话' },
  { id: 'global.todoCapture', group: '全局', label: '速记待办' },
  { id: 'global.settings', group: '全局', label: '打开设置' },
  { id: 'global.prevView', group: '全局', label: '上一个视图' },
  { id: 'global.nextView', group: '全局', label: '下一个视图' },
  { id: 'dispatch.model', group: '派发', label: '切换模型' },
  { id: 'dispatch.workdir', group: '派发', label: '工作目录' },
  { id: 'dispatch.turnOutline', group: '派发', label: '轮次目录' },
  { id: 'dispatch.prevTurn', group: '派发', label: '上一轮' },
  { id: 'dispatch.nextTurn', group: '派发', label: '下一轮' },
  { id: 'dispatch.inlineCode', group: '派发', label: '行内代码' },
  { id: 'dispatch.codeBlock', group: '派发', label: '代码块' },
  { id: 'sessions.find', group: '会话看板', label: '会话内查找' },
  { id: 'sessions.close', group: '会话看板', label: '关闭选中会话' },
];

export const KEYMAP_DEFAULTS: Record<ActionId, string> = {
  'global.newSession': 'mod+n',
  'global.todoCapture': 'mod+j',
  'global.settings': 'mod+,',
  'global.prevView': 'mod+alt+arrowleft',
  'global.nextView': 'mod+alt+arrowright',
  'dispatch.model': 'mod+m',
  'dispatch.workdir': 'mod+d',
  'dispatch.turnOutline': 'mod+shift+o',
  'dispatch.prevTurn': 'alt+arrowup',
  'dispatch.nextTurn': 'alt+arrowdown',
  'dispatch.inlineCode': 'mod+e',
  'dispatch.codeBlock': 'mod+shift+e',
  'sessions.find': 'mod+f',
  'sessions.close': 'ctrl+x',
};

/**
 * 不可改的键位:它们不是「某个动作的快捷方式」,而是控件本身的语义。
 * 改掉 Esc 就没有退出弹层的通用出口,改掉方向键就没法在列表里移动——
 * 在设置里以只读行呈现,让用户知道它们存在且不必找改键入口。
 */
export const FIXED_KEYS: { group: KeyAction['group']; label: string; keys: string; hint?: string }[] =
  [
    {
      group: '派发',
      label: '发送 / 换行',
      keys: 'mod+enter enter',
      hint: '由「派发 › 发送键」决定',
    },
    { group: '派发', label: '输入历史', keys: 'arrowup arrowdown', hint: '仅在输入框为空时' },
    { group: '派发', label: '返回会话看板', keys: 'escape arrowleft' },
    { group: '会话看板', label: '卡片间移动', keys: 'arrowup arrowdown arrowleft arrowright' },
    { group: '全局', label: '切换视图', keys: 'mod+1 … mod+9', hint: '非输入状态也可直接按数字' },
  ];

export type Keymap = Record<ActionId, string>;

/**
 * 只读事件的这六个字段,不收整个 KeyboardEvent:
 * 前端测试跑在 node 环境(无 jsdom),纯结构类型才让键位逻辑可以直接单测。
 */
export type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>;

export const detectMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 事件 → 规范组合串。修饰键顺序固定,故可直接与表里的值做字符串比较 */
export function comboOf(e: KeyLike, isMac = detectMac()): string {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const ctrl = isMac ? e.ctrlKey : false;
  const parts: string[] = [];
  if (mod) parts.push('mod');
  if (ctrl) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const k = e.key;
  /** 修饰键本身不构成组合 */
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(k)) return '';
  /**
   * 用 e.key 而非 e.code:用户按的是「⌘E」这个字面组合,不是「⌘ + 键盘第三行第三个键」。
   * 但 alt 在 Mac 上会把 e.key 变成变音符号(⌥E → "´"),此时退回 e.code 还原字母。
   */
  let name = k.length === 1 ? k.toLowerCase() : k.toLowerCase();
  if (e.altKey && /^[a-z]$/.test(e.code.replace('Key', '').toLowerCase()) && k.length === 1) {
    name = e.code.replace('Key', '').toLowerCase();
  }
  parts.push(name);
  return parts.join('+');
}

export function matchKey(e: KeyLike, combo: string, isMac = detectMac()): boolean {
  return !!combo && comboOf(e, isMac) === combo;
}

const KEY_LABEL: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '⏎',
  escape: 'Esc',
  ' ': 'Space',
  ',': ',',
};

/** 组合串 → 给人看的键帽文本。Mac 出符号,其余平台出单词 */
export function formatCombo(combo: string, mac = detectMac()): string {
  if (!combo) return '';
  return combo
    .split('+')
    .map((p) => {
      if (p === 'mod') return mac ? '⌘' : 'Ctrl';
      if (p === 'ctrl') return mac ? '⌃' : 'Ctrl';
      if (p === 'alt') return mac ? '⌥' : 'Alt';
      if (p === 'shift') return mac ? '⇧' : 'Shift';
      return KEY_LABEL[p] ?? (p.length === 1 ? p.toUpperCase() : p);
    })
    .join(mac ? '' : '+');
}

/** 多个键位并列展示(如「↑ ↓」)时用空格分隔,逐个格式化 */
export const formatKeys = (keys: string, mac = detectMac()) =>
  keys.split(' ').map((k) => formatCombo(k, mac));

/**
 * 冲突查找:同一组合被别的动作占用即返回那个动作。
 * 作用域没有细分——两个动作即便分属不同视图,同一个组合也会让人记不住到底触发哪个,
 * 宁可全局唯一。
 */
export function findConflict(map: Keymap, combo: string, self: ActionId): ActionId | null {
  if (!combo) return null;
  for (const [id, c] of Object.entries(map) as [ActionId, string][]) {
    if (id !== self && c === combo) return id;
  }
  return null;
}

export const actionLabel = (id: ActionId): string =>
  KEY_ACTIONS.find((a) => a.id === id)?.label ?? id;

/** 存量覆写里可能有已删除的 action 或坏值,读取时按默认表逐键过滤 */
export function normalizeKeymap(saved: unknown): Keymap {
  const o = (saved ?? {}) as Record<string, unknown>;
  const out = { ...KEYMAP_DEFAULTS };
  for (const id of Object.keys(KEYMAP_DEFAULTS) as ActionId[]) {
    const v = o[id];
    if (typeof v === 'string' && v.trim()) out[id] = v;
  }
  return out;
}
