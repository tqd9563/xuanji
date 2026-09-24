import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
/**
 * 第二次复发(2026-09-21):`at` 从后端下来是对的,却在前端丢在 React 的更新函数里——
 * 合批 delta 的 flushDelta 把 `pendingAtRef.current ?? Date.now()` 写在 setItems 的更新函数内,
 * 而更新函数是延后执行的:接回回放几百条事件连发,React 攒到一起才跑,那时 ref 已被清空,
 * 98 条 Claude 消息只剩 6 个渲染刻度的时刻。没有 jsdom 测不了这个时序,扫源码钉住:
 * setItems / setTurn 的更新函数体内不得读取「事件到达时刻」类 ref。
 */
describe('时间戳不能在 setState 更新函数里读 ref', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'dispatch.ts'), 'utf8');
  const block = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

  it('flushDelta:先取 at 再 setItems,更新函数内不读 pendingAtRef / Date.now()', () => {
    const fn = block('const flushDelta = useCallback', '}, []);');
    const call = fn.lastIndexOf('setItems(');
    expect(fn.indexOf('pendingAtRef.current ?? Date.now()')).toBeGreaterThan(-1);
    expect(fn.indexOf('pendingAtRef.current ?? Date.now()')).toBeLessThan(call);
    expect(fn.slice(call)).not.toContain('pendingAtRef');
    expect(fn.slice(call)).not.toContain('Date.now()');
  });

  it('status→working:先取起点再 setTurn,更新函数内不读 turnStartRef', () => {
    const st = block("case 'status':", "case 'user-echo':");
    for (const seg of st.split('setTurn(').slice(1)) expect(seg.slice(0, 120)).not.toContain('turnStartRef');
  });
});
