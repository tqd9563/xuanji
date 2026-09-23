import { describe, expect, it } from 'vitest';
import { chatKey } from './dispatch';

/**
 * 历史前插不能改变已有行的 key:否则 React 把整列聊天行卸掉重建,
 * 每条助手消息的 markdown 全部重新解析(接回/续接时「等好几秒」的一部分)。
 */
describe('聊天行 key 在历史前插后保持稳定', () => {
  it('实时行的 key 不随前插条数变化,历史行落在负数区间', () => {
    const before = [0, 1, 2].map((i) => chatKey(i, 0));
    // 前插 5 条历史后,原来的 3 条实时行下标变成 5..7
    const after = [5, 6, 7].map((i) => chatKey(i, 5));
    expect(after).toEqual(before);
    expect([0, 1, 2, 3, 4].map((i) => chatKey(i, 5))).toEqual([-5, -4, -3, -2, -1]);
  });
});
