import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 守卫:IME 预编辑期必须把舞台让给 textarea 自己。
 *
 * 高亮镜像层的前提是 textarea 文字透明;而拼音未上屏时,预编辑文本的底色与下划线由内核
 * 直接画在 textarea 上——镜像层会被整块盖住或与之对不齐,表现成「光标离行末字符一段空白」
 * (2026-09-21 用户实测,Chrome CDP imeSetComposition 复现为一块不含字的色块)。
 * 少了 composition 这对钩子或对应的 .composing 样式,这个缺陷会悄悄回归。
 */
describe('输入框 IME 预编辑态', () => {
  const src = readFileSync(resolve(__dirname, '../src/views/Dispatch.tsx'), 'utf8');
  const css = readFileSync(resolve(__dirname, '../src/styles/index.css'), 'utf8');

  it('textarea 挂了 compositionstart/end 并切换 .composing', () => {
    expect(src).toMatch(/onCompositionStart=\{[^}]*classList\.add\('composing'\)/);
    expect(src).toMatch(/onCompositionEnd=/);
    expect(src).toMatch(/classList\.remove\('composing'\)/);
  });

  it('组合期间镜像让位、textarea 文字染回正常色', () => {
    expect(css).toMatch(/\.ta-wrap\.composing textarea \{ color: var\(--ink\); \}/);
    expect(css).toMatch(/\.ta-wrap\.composing \.ta-mirror \{ visibility: hidden; \}/);
  });
});
