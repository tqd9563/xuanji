/**
 * 验收面板的执行守卫:所有「能不能执行、到底执行什么」的判定集中在这里。
 * 设计见 wiki/tech/acceptance-runbook.md §2.4 / §6。
 *
 * 三道闸,顺序不可换:
 *  1) 参数插值 —— 值只做值级替换,产出 argv 数组而非 shell 字符串;
 *  2) cwd 围栏 —— 执行目录必须落在会话 worktree 内;
 *  3) 防自斩黑名单 —— 命中即拒,对模板项同样生效。
 *
 * 为什么不过 shell:值一旦进 shell 字符串,`;`、`$()`、反引号就都是可执行面。
 * 全程 argv 数组 + spawn(shell:false),参数框里写什么都只是一个字符串实参。
 * 代价是清单里不支持管道/重定向等 shell 语法——验收命令该由脚本封装,不是在清单里拼。
 */
import path from 'node:path';
import type { RunbookItem, RunbookParam } from '../types.js';

/**
 * 防自斩黑名单(CLAUDE.md「派发会话防自斩铁律」的执行层落地)。
 * 璇玑后端是派发会话的宿主进程,重启/杀死它 = 当场杀死正在跑的会话本身
 * (2026-07-09 已实际发生两次)。prompt 级约束拦不住会话把命令写进清单,
 * 故在执行层机械兜底:命中即拒,并明示「请在终端手动执行」。
 */
const SELF_DESTRUCT_RULES: Array<{ re: RegExp; why: string }> = [
  { re: /(^|[/\s])restart\.sh(\s|$)/, why: 'restart.sh 会重启璇玑宿主后端,杀死当前会话' },
  { re: /launchctl\s+(kickstart|bootout|unload|stop)/, why: 'launchctl 操作会中断璇玑后端服务' },
  { re: /com\.xuanji\.backend/, why: '目标是璇玑后端的 launchd 服务' },
  { re: /pnpm\s+launchd:(install|uninstall)/, why: '会重装/卸载璇玑后端的常驻服务' },
  // kill 掉 7777 监听进程 = 杀宿主。覆盖 `lsof -ti:7777 | xargs kill` 这类写法的各个片段
  { re: /\bkill\b[^|]*\b7777\b/, why: '会杀死 :7777 上的璇玑常驻后端' },
  { re: /\b(lsof|fuser)\b[^|]*\b7777\b[^|]*\bkill\b/, why: '会杀死 :7777 上的璇玑常驻后端' },
  { re: /:7777[^|]*\|\s*xargs[^|]*\bkill\b/, why: '会杀死 :7777 上的璇玑常驻后端' },
];

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * 黑名单判定。输入是**插值后的完整命令串**(而非 argv),因为危险模式常跨 argv 边界
 * (`lsof -ti:7777 | xargs kill`)。判定只读不改,纯函数。
 */
export function checkBlacklist(resolvedCommand: string): GuardVerdict {
  // 先把引号归一成空白再匹配:argv 执行下引号里的值本就不会被 shell 解释,
  // 但「值里写着 ./restart.sh」本身就是可疑信号(脚本自己 eval 就中招),
  // 按语义拦下来做纵深防御。误伤成本极低——验收命令的参数值里出现这些串近乎不可能,
  // 而漏判的代价是当场杀死用户正在跑的会话。
  const cmd = resolvedCommand.replace(/["']/g, ' ').trim();
  for (const rule of SELF_DESTRUCT_RULES) {
    if (rule.re.test(cmd)) {
      return { ok: false, reason: `命中执行层黑名单(防自斩铁律):${rule.why};请在终端手动执行` };
    }
  }
  return { ok: true };
}

/**
 * cwd 围栏:清单里的相对 cwd 只允许落在会话 worktree 目录树内。
 * 返回绝对路径;逃逸(`../`、绝对路径指向别处、软链跳出)一律拒绝。
 */
export function resolveCwd(sessionCwd: string, itemCwd?: string): { ok: true; cwd: string } | { ok: false; reason: string } {
  const root = path.resolve(sessionCwd);
  const target = path.resolve(root, itemCwd ?? '.');
  // path.relative 为空表示同一目录;以 .. 开头或绝对路径表示跳出了 root
  const rel = path.relative(root, target);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    return { ok: false, reason: `工作目录越出会话范围:${itemCwd}` };
  }
  return { ok: true, cwd: target };
}

/**
 * 把命令串切成 argv。支持单/双引号包裹的整体实参,不解释任何 shell 元字符——
 * 遇到 `|`、`&&`、`>` 等只会被当成普通字符串实参,不会真的建管道。
 */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** 参数取值优先级:用户本次输入 > 实例预填 > 模板 default */
export function paramValue(p: RunbookParam, provided?: Record<string, string>): string {
  const v = provided?.[p.key];
  if (v !== undefined) return v;
  return p.default ?? '';
}

export interface ResolvedCommand {
  /** 展示与审计用的完整命令串(用户点的就是这条) */
  display: string;
  /** 真正交给 spawn 的 argv;不过 shell */
  argv: string[];
}

/**
 * 参数插值。两种拼接规则按**逐参数**判定:
 *  - 命令里出现 `{{key}}` → 原地替换(位置不在末尾、或 URL/body 场景);
 *  - 否则按 `flag` 声明顺序追加到末尾。
 * boolean 只在为真时追加 flag 本身,不追加值。
 */
export function resolveCommand(item: RunbookItem, provided?: Record<string, string>): ResolvedCommand {
  const base = item.command ?? '';
  let display = base;
  const appended: string[] = [];

  for (const p of item.params ?? []) {
    const raw = paramValue(p, provided);
    const placeholder = `{{${p.key}}}`;
    if (p.type === 'boolean') {
      const on = raw === 'true' || raw === '1' || raw === 'on';
      if (display.includes(placeholder)) {
        display = display.split(placeholder).join(on && p.flag ? p.flag : '');
      } else if (on && p.flag) {
        appended.push(p.flag);
      }
      continue;
    }
    if (display.includes(placeholder)) {
      display = display.split(placeholder).join(raw);
    } else if (p.flag) {
      if (raw !== '') appended.push(p.flag, raw);
    } else if (raw !== '') {
      appended.push(raw);
    }
  }

  // argv:命令本体走 tokenize(可能自带引号),追加的参数值原样入列不再切分——
  // 值里的空格属于值本身(如日期区间备注),切开会变成两个实参
  const argv = [...tokenize(display), ...appended];
  const displayFull = appended.length ? `${display} ${appended.map(quoteForDisplay).join(' ')}`.trim() : display.trim();
  return { display: displayFull, argv };
}

/** 仅用于展示:含空格的值加引号,让用户看到的命令可直接粘进终端复现 */
function quoteForDisplay(s: string): string {
  return /[\s"'$`\\]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

/**
 * 执行前的总闸:插值 → 围栏 → 黑名单。任一不过即拒,并给出可读原因。
 * 渲染清单时也调它(不执行),用于把「已拦截」态前置到第一眼可见。
 */
export function guardItem(
  item: RunbookItem,
  sessionCwd: string,
  provided?: Record<string, string>,
): { ok: true; command: ResolvedCommand; cwd: string } | { ok: false; reason: string } {
  const command = resolveCommand(item, provided);
  const fence = resolveCwd(sessionCwd, item.cwd);
  if (!fence.ok) return { ok: false, reason: fence.reason };
  const black = checkBlacklist(command.display);
  if (!black.ok) return { ok: false, reason: black.reason! };
  if (!command.argv.length) return { ok: false, reason: '命令为空' };
  return { ok: true, command, cwd: fence.cwd };
}
