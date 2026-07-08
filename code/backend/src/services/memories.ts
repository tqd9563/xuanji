import path from 'node:path';
import { config } from '../config.js';
import { scanMemories, scanProjectDirs } from '../adapters/claude-dir.js';
import type { Memory } from '../types.js';
import type { Storage } from '../storage/db.js';

let cached: { at: number; memories: Memory[] } | null = null;
const CACHE_MS = 30_000;

export async function listMemories(storage?: Storage): Promise<Memory[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.memories;
  const dirs = await scanProjectDirs(config.claudeDir);
  const map = new Map<string, string>();
  for (const d of dirs) {
    if (config.projectNoisePatterns.some((re) => re.test(d.path))) continue;
    if (d.memoryCount > 0) map.set(d.encodedDir, d.path);
  }
  const memories = await scanMemories(config.claudeDir, map);
  memories.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  cached = { at: Date.now(), memories };
  // 索引重建(可重建缓存,铁律 2)
  storage?.rebuildMemoryIndex(memories);
  return memories;
}

export async function searchMemories(storage: Storage, q: string): Promise<Memory[]> {
  const all = await listMemories(storage);
  const files = storage.searchMemories(q);
  if (files.length === 0) {
    // FTS 未命中时退化为朴素包含匹配(短查询/符号查询兜底)
    const needle = q.toLowerCase();
    return all.filter(
      (m) =>
        m.name.toLowerCase().includes(needle) ||
        m.description.toLowerCase().includes(needle) ||
        m.body.toLowerCase().includes(needle),
    );
  }
  const rank = new Map(files.map((f, i) => [path.normalize(f), i]));
  return all
    .filter((m) => rank.has(path.normalize(m.file)))
    .sort((a, b) => rank.get(path.normalize(a.file))! - rank.get(path.normalize(b.file))!);
}

export function invalidateMemoryCache() {
  cached = null;
}
