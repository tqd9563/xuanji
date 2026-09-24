/**
 * 系统监控 · 判色与建议规则(纯函数,确定性,不调 LLM)。
 * 规则表与原型 wiki/design/prototype-memory-monitor.html 的「弹窗文案怎么来的」逐条对应。
 */
import type { MonGroup } from './group.js';

export type Level = 'ok' | 'warn' | 'crit';

/** 内核压力等级 1/2/4 → 三档 */
export function memLevel(pressure: number): Level {
  return pressure >= 4 ? 'crit' : pressure >= 2 ? 'warn' : 'ok';
}

/** CPU 整体占用 = 用户 + 系统,对照阈值 */
export function cpuLevel(usedPct: number, warn: number, crit: number): Level {
  return usedPct >= crit ? 'crit' : usedPct >= warn ? 'warn' : 'ok';
}

/**
 * 变色防抖:原始等级连续 N 次一致才切换展示等级(升降对称)。
 * 首个样本直接生效——刚打开时没有「上一次」可供防抖,不该先显示一段假的正常。
 */
export class Debouncer {
  private shown: Level | null = null;
  private pending: Level | null = null;
  private streak = 0;

  push(raw: Level, n: number): Level {
    if (this.shown === null || raw === this.shown) {
      this.shown = raw;
      this.pending = null;
      this.streak = 0;
      return this.shown;
    }
    if (raw === this.pending) this.streak++;
    else {
      this.pending = raw;
      this.streak = 1;
    }
    if (this.streak >= Math.max(1, n)) {
      this.shown = raw;
      this.pending = null;
      this.streak = 0;
    }
    return this.shown;
  }

  reset() {
    this.shown = null;
    this.pending = null;
    this.streak = 0;
  }
}

/** 建议文案片段:纯文本 / 行内代码 / 强调;前端逐段渲染,不拼 HTML */
export type TipPart = string | { code: string } | { b: string };

export interface Tip {
  rule: string;
  parts: TipPart[];
  /** 文末给一枚跳转按钮(kernel-swap → 看内存) */
  jump?: 'mem';
}

const GB = 1024 ** 3;
export function fmtBytes(n: number): string {
  return n < GB ? `${Math.round(n / 1024 / 1024)}M` : `${(n / GB).toFixed(1)}G`;
}
export function fmtPct(v: number): string {
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}%`;
}

const LANG_SERVER = /pylance|gopls|tsserver|rust-analyzer|pyright|jdtls|clangd/i;

/** 内存建议:取压缩+换出前两名应用,先命中先用 */
export function memTips(groups: MonGroup[], args: (pid: number) => string): Tip[] {
  const top = [...groups].sort((a, b) => b.cmprs - a.cmprs).slice(0, 2);
  return top.map((a): Tip => {
    if (/^(Visual Studio Code|Code|Cursor)/.test(a.name)) {
      const ls = a.procs.filter((p) => LANG_SERVER.test(args(p.pid)));
      if (ls.length) {
        const label = (pid: number) => LANG_SERVER.exec(args(pid))?.[0] ?? 'language server';
        return {
          rule: 'vscode-lang-server',
          parts: [
            `${ls.map((p) => `${label(p.pid)} ${fmtBytes(p.cmprs)}`).join('、')}:在 ${a.name} 运行 `,
            { code: 'Developer: Restart Extension Host' },
            `,可释放约 ${fmtBytes(ls.reduce((s, p) => s + p.cmprs, 0))}。`,
          ],
        };
      }
    }
    if (a.name === 'Google Chrome') {
      const n = a.procs.filter((p) => /Renderer/.test(p.cmd)).length;
      return {
        rule: 'chrome',
        parts: [`Google Chrome ${n} 个渲染进程合计 ${fmtBytes(a.cmprs)}:关闭不用的标签页,或在「设置 → 性能」开启 Memory Saver。`],
      };
    }
    // agent-browser 的自动化浏览器:守护进程由 launchd 直接拉起,根名是 agent-browser-*,子进程是 Chrome for Testing
    if (/Chrome for Testing|agent-browser/.test(a.name) || a.procs.some((p) => /Chrome for Testing/.test(p.cmd))) {
      return {
        rule: 'chrome-for-testing',
        parts: [`agent-browser 的自动化浏览器占 ${fmtBytes(a.cmprs)}:运行 `, { code: 'agent-browser close --all' }, ' 关闭。'],
      };
    }
    if (a.kind === 'dispatch') {
      return { rule: 'xuanji-session', parts: [`${a.name} 占 ${fmtBytes(a.cmprs)}:在下方对应进程行「关闭会话以释放」即可。`] };
    }
    if (a.kind === 'terminal') {
      return { rule: 'terminal-session', parts: [`${a.name} 占 ${fmtBytes(a.cmprs)}:这是终端里开的会话,请在终端结束。`] };
    }
    return { rule: 'fallback', parts: [`退出 ${a.name} 可释放约 ${fmtBytes(a.cmprs)}。`] };
  });
}

export interface CpuTipCtx {
  /** 内存监控是否开启;关闭时 kernel_task 无法区分换页还是温控 */
  memOn: boolean;
  /** 内存展示等级(memOn 时有效) */
  memLevel: Level;
  swapins: number;
  swapouts: number;
  pageSize: number;
}

/** CPU 建议:取 %CPU 前四名应用,至多两条命中 */
export function cpuTips(groups: MonGroup[], ctx: CpuTipCtx): Tip[] {
  const pg = (n: number) => {
    const g = (n * ctx.pageSize) / GB;
    return g >= 1024 ? `${(g / 1024).toFixed(2)}T` : `${Math.round(g)}G`;
  };
  const top = [...groups].sort((a, b) => b.cpu - a.cpu).slice(0, 4);
  const out: Tip[] = [];
  for (const a of top) {
    let tip: Tip | null = null;
    if (a.name === 'Google Chrome') {
      const r = a.procs.filter((p) => /Renderer/.test(p.cmd)).sort((x, y) => y.cpu - x.cpu)[0];
      if (r && r.cpu >= 30) {
        tip = {
          rule: 'chrome-tab',
          parts: [`Chrome 有一个标签页在持续占用(渲染进程 ${r.pid} ${fmtPct(r.cpu)}):在 Chrome「窗口 → 任务管理器」按 CPU 排序,关掉该标签。`],
        };
      }
    } else if (a.name === 'kernel_task' && a.cpu >= 20) {
      if (!ctx.memOn) {
        tip = { rule: 'kernel-nomem', parts: [`kernel_task ${fmtPct(a.cpu)}:常见于内存换页或温控降频;内存监控已关闭,无法区分,可在设置里开启。`] };
      } else if (ctx.memLevel !== 'ok') {
        tip = {
          rule: 'kernel-swap',
          parts: [
            `kernel_task ${fmtPct(a.cpu)}:内存压力${ctx.memLevel === 'crit' ? '严重' : '警告'}且持续换页(开机累计换入 ${pg(ctx.swapins)} / 换出 ${pg(ctx.swapouts)}),`,
            { b: '可能与内存换页有关,先处理内存' },
            '。',
          ],
          jump: 'mem',
        };
      } else {
        tip = { rule: 'kernel-thermal', parts: [`kernel_task ${fmtPct(a.cpu)} 而内存正常:多为温控降频(系统占住 CPU 给芯片降温),检查散热、外接显示器与充电。`] };
      }
    } else if (a.kind === 'dispatch' && a.cpu >= 20) {
      tip = { rule: 'xuanji-session', parts: [`${a.name} 占 ${fmtPct(a.cpu)}:在下方对应进程行「关闭会话以释放」即可。`] };
    } else if (a.kind === 'terminal' && a.cpu >= 50) {
      const p = [...a.procs].sort((x, y) => y.cpu - x.cpu)[0]!;
      tip = { rule: 'terminal-session', parts: [`终端会话的 ${p.cmd} 占 ${fmtPct(a.cpu)}:这是终端里开的会话,请在终端结束。`] };
    } else if (a.cpu >= 50 && (/Chrome for Testing|agent-browser/.test(a.name) || a.procs.some((p) => /Chrome for Testing/.test(p.cmd)))) {
      tip = { rule: 'chrome-for-testing', parts: [`agent-browser 的自动化浏览器占 ${fmtPct(a.cpu)}:运行 `, { code: 'agent-browser close --all' }, ' 关闭。'] };
    } else if (a.cpu >= 50) {
      tip = { rule: 'fallback', parts: [`${a.name} 占 ${fmtPct(a.cpu)}:不在用可退出。`] };
    }
    if (tip) out.push(tip);
    if (out.length === 2) break;
  }
  return out;
}
