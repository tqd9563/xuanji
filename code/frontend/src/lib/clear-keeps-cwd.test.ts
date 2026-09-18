import { describe, expect, it } from 'vitest';

/**
 * `/clear` 与 ⌘N 共用 newSession(),但对工作目录的期望相反:
 *  - ⌘N 开的是新任务 → 目录退回默认(快速提问目录);
 *  - /clear 清的是上下文,人还在同一个项目里 → 目录必须原样保留。
 *
 * 加快速提问默认态时,「⌘N 清目录」一度直接写进 newSession(),把 /clear 也带着换了目录。
 * 这类回归在界面上要走一遍「进项目 → 发消息 → /clear → 看状态行」才看得见,故用源码守卫钉住。
 *
 * 用 vite 的 import.meta.glob 取源码,与 classname-collision 守卫同一手法(前端 tsconfig 不含 node 类型)。
 */
const FILES = import.meta.glob('../views/Dispatch.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const src = Object.values(FILES)[0] ?? '';

describe('/clear 不改工作目录', () => {
  it('读到了派发页源码(守卫本身没有空跑)', () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain('newSession');
  });

  it('/clear 分支调用 newSession 时带 keepCwd', () => {
    // 取 /clear 拦截块内的那次调用
    const block = src.match(/\/\^\\\/clear\\b\/\.test\(text\)[\s\S]{0,600}/)?.[0] ?? '';
    expect(block).toContain('newSession(');
    expect(block).toMatch(/newSession\(\{\s*keepCwd:\s*true\s*\}\)/);
  });

  it('newSession 默认(不传参)仍会清掉显式选择的目录', () => {
    const fn = src.match(/const newSession = \(opts\?[\s\S]{0,400}/)?.[0] ?? '';
    expect(fn).toMatch(/if \(!opts\?\.keepCwd\) setCwd\(''\)/);
  });
});
