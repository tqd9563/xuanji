import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReplay } from '../src/adapters/claude-dir.js';

describe('parseReplay 跳过 CLI 内部记账行', () => {
  it('cost-state / atis-latch / api-request* / session-owner / tools-used 不产生 raw 事件,其它未知类型仍兜底', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xj-'));
    const f = join(dir, 's.jsonl');
    writeFileSync(f, [
      { type: 'cost-state', sessionId: 's', totalCostUSD: 1 },
      { type: 'atis-latch', atis: '', sessionId: 's' },
      { type: 'api-request', sessionId: 's', id: 'r1', params: '{}' },
      { type: 'api-request-blob', sessionId: 's', hash: 'h', message: '{}' },
      { type: 'api-request-shape', sessionId: 's', shapeHash: 'h', shape: '{}' },
      { type: 'session-owner', sessionId: 's', accountUuid: 'a' },
      { type: 'tools-used', sessionId: 's', tools: '[]' },
      { type: 'brand-new-type', sessionId: 's' },
    ].map((o) => JSON.stringify(o)).join('\n'));
    const { events } = await parseReplay(f, 's');
    const raws = events.filter((e) => e.kind === 'raw').map((e) => (e as { type: string }).type);
    expect(raws).toEqual(['brand-new-type']);
  });
});
