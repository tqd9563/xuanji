import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReplay } from '../src/adapters/claude-dir.js';

describe('parseReplay 跳过 CLI 内部记账行', () => {
  it('cost-state / atis-latch 不产生 raw 事件,其它未知类型仍兜底', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xj-'));
    const f = join(dir, 's.jsonl');
    writeFileSync(f, [
      { type: 'cost-state', sessionId: 's', totalCostUSD: 1 },
      { type: 'atis-latch', atis: '', sessionId: 's' },
      { type: 'brand-new-type', sessionId: 's' },
    ].map((o) => JSON.stringify(o)).join('\n'));
    const { events } = await parseReplay(f, 's');
    const raws = events.filter((e) => e.kind === 'raw').map((e) => (e as { type: string }).type);
    expect(raws).toEqual(['brand-new-type']);
  });
});
