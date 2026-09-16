import { describe, expect, it } from 'vitest';

/**
 * 联想面板的「Commands」组(Dispatch.tsx 的 BUILTIN_CMDS)必须与实际拦截的斜杠命令一一对应。
 *
 * 这两者天然容易脱节:拦截逻辑写在发送路径里,面板候选写在文件顶部的常量表,
 * 加一条拦截而忘了加候选,用户在面板里就找不到这个命令(它照样能手敲,但联想说它不存在);
 * 反过来多写一条候选,补全出来的命令会被原样发给 CLI,得到一句 "Unknown command"。
 *
 * 判据是源码里「行首斜杠 + 命令名 + 单词边界」这个正则字面量,每条璇玑自有命令都这么写;
 * 扫整个 src 而不只是 Dispatch.tsx —— /btw 的判定就住在 lib/btw.ts。
 */
const FILES = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

const SRC = Object.entries(FILES)
  .filter(([p]) => !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'))
  .map(([, t]) => t)
  .join('\n');

const DISPATCH = Object.entries(FILES).find(([p]) => p.endsWith('views/Dispatch.tsx'))![1];

/** 拦截式的正则字面量,形如 `^\/wrapup\b` */
function interceptedNames(text: string): string[] {
  return [...new Set([...text.matchAll(/\^\\\/([a-z-]+)\\b/g)].map((m) => m[1]!))];
}

/** 顶部常量表里的候选名 */
function declaredNames(text: string): string[] {
  const block = /const BUILTIN_CMDS: SlashCmd\[\] = \[([\s\S]*?)\n\];/.exec(text);
  if (!block) return [];
  return [...block[1]!.matchAll(/name: '([^']+)'/g)].map((m) => m[1]!);
}

describe('内置斜杠命令表与实际拦截一致', () => {
  it('两侧都能从源码里解析出来(正则失效时立刻暴露,而不是双双为空地假绿)', () => {
    expect(interceptedNames(SRC).length).toBeGreaterThan(3);
    expect(declaredNames(DISPATCH).length).toBeGreaterThan(3);
  });

  it('每条被拦截的命令都在面板候选里', () => {
    const declared = new Set(declaredNames(DISPATCH));
    expect(interceptedNames(SRC).filter((n) => !declared.has(n))).toEqual([]);
  });

  it('每条面板候选都真有拦截逻辑,不会补出一个 CLI 不认识的命令', () => {
    const intercepted = new Set(interceptedNames(SRC));
    expect(declaredNames(DISPATCH).filter((n) => !intercepted.has(n))).toEqual([]);
  });
});
