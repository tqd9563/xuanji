import { describe, expect, it } from 'vitest';

/**
 * Tailwind v4(`@import "tailwindcss"`)按需生成工具类：它扫描源码里出现的**类名字符串**，
 * 命中自己的工具类名就生成对应规则。所以在 tsx 里裸写一个与 Tailwind 同名的语义类名，
 * 会凭空多出一条工具类规则压在自己的样式上。
 *
 * 2026-09-03 实测：快捷键表的只读行写了 `className="fixed"`，Tailwind 据此生成
 * `.fixed{position:fixed}`，那一行被踢出表格流、与后面的分组标题重叠。
 * 症状（文字重叠）与病因（一个类名）看着毫不相干，所以用测试钉住。
 *
 * 用 vite 的 `import.meta.glob` 取源码，不引 node:fs——前端 tsconfig 不含 node 类型。
 */
const FILES = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

/** Tailwind 里语义足够“像普通类名”、最容易被误用作业务类名的一批 */
const RESERVED = [
  'fixed', 'absolute', 'relative', 'sticky', 'static',
  'block', 'inline', 'flex', 'grid', 'table', 'hidden', 'contents',
  'container', 'group', 'peer',
  'visible', 'invisible', 'collapse',
  'italic', 'underline', 'truncate', 'uppercase', 'lowercase', 'capitalize',
  'border', 'rounded', 'shadow', 'outline', 'ring',
  'transform', 'transition', 'resize',
];

/**
 * 工具类落在「它本来就是这个 display」的元素上时无害。
 * 例如 `<table className="table">`：Tailwind 的 `.table{display:table}` 正是 table 元素的默认值。
 */
const HARMLESS_ON: Record<string, string[]> = {
  table: ['table'],
};

const sources = Object.entries(FILES).filter(([p]) => !p.endsWith('.test.ts'));

describe('类名不与 Tailwind 工具类撞车', () => {
  it('扫到了源码(守卫本身没有空跑)', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it('className 里不出现裸的 Tailwind 保留字', () => {
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const m of src.matchAll(/<(\w+)[^>]*?className="([^"{}]+)"/gs)) {
        const tag = m[1]!;
        for (const cls of m[2]!.trim().split(/\s+/)) {
          if (!RESERVED.includes(cls)) continue;
          if (HARMLESS_ON[cls]?.includes(tag)) continue;
          offenders.push(`${path}: <${tag} class="${cls}">`);
        }
      }
    }
    expect(offenders, `这些类名会被 Tailwind 生成同名工具类，请加项目前缀：\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('cn() 里的字符串字面量同样不撞', () => {
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const m of src.matchAll(/\bcn\(([^)]*)\)/gs)) {
        for (const lit of m[1]!.matchAll(/'([^']+)'/g)) {
          for (const cls of lit[1]!.trim().split(/\s+/)) {
            if (RESERVED.includes(cls)) offenders.push(`${path}: cn('${cls}')`);
          }
        }
      }
    }
    expect(offenders, `这些类名会被 Tailwind 生成同名工具类，请加项目前缀：\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});
