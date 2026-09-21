import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/**
 * 回放按需渲染踩过的坑,用扫源码的方式钉住——这两处没有 jsdom 测不了运行时,
 * 但它们一旦被改回去,症状(滚到底不再追加 / ⌘F 搜不到没滚到的内容)都很隐蔽。
 */
describe('按需挂载的两个易回归点', () => {
  it('哨兵与懒解析的 IntersectionObserver 必须指定 root(滚动容器)', () => {
    // 默认 root 是视口,祖先滚动容器的裁剪照样生效,而 rootMargin 只放大 root 矩形:
    // 抽屉里的哨兵会被容器裁掉,表现为滚到底也不追加下一片(2026-09-21 实测)
    for (const f of ['lib/replay-mount.ts', 'components/shared.tsx']) {
      const src = read(f);
      const observers = src.split('new IntersectionObserver').slice(1);
      expect(observers.length, `${f} 应当有 IntersectionObserver`).toBeGreaterThan(0);
      for (const o of observers) {
        const opts = o.slice(0, o.indexOf('io.observe') >= 0 ? o.indexOf('io.observe') : 600);
        expect(opts, `${f} 的 IntersectionObserver 缺少 root`).toContain('root:');
      }
    }
  });

  it('⌘F 打开查找条时必须把未挂载的事件补齐', () => {
    const src = read('views/Sessions.tsx');
    // 查找靠扫 DOM,没挂出来的事件搜不到
    expect(src).toMatch(/find\.open[\s\S]{0,80}mountAll\(\)/);
    // 列表末尾要有哨兵,否则没有东西驱动追加
    expect(src).toContain('mountSentinelRef');
  });
});
