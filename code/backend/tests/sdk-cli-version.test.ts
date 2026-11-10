import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sdkCliVersion } from '../src/adapters/agents-cli.js';

describe('sdkCliVersion', () => {
  it('读的是 SDK 包自带 CLI 的 manifest 版本,而不是系统 claude', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(sdkCliVersion()).toBe(`${manifest.version} (Claude Code)`);
  });
});
