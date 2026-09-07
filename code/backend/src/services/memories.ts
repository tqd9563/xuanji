import fsp from 'node:fs/promises';
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

/** 项目绝对路径 → ~/.claude/projects 下的目录名(与 CLI 一致:非字母数字一律转 -,如 /Users/x/a → -Users-x-a) */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function memorySlug(title: string, fallback = 'note'): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

/**
 * 写一条 memory(架构铁律 2 的例外①「经验沉淀模块写 memory md」,2026-07-08 批准):
 * 落 `~/.claude/projects/<slug>/memory/<name>.md` 并在 MEMORY.md 追加一行索引;同名已存在则加序号,绝不覆盖。
 * 返回写下的文件路径。
 */
export async function writeMemory(input: {
  cwd: string;
  name: string;
  description: string;
  type: 'reference' | 'project' | 'feedback' | 'user';
  body: string;
}): Promise<string> {
  const memDir = path.join(config.claudeDir, 'projects', encodeProjectDir(input.cwd), 'memory');
  await fsp.mkdir(memDir, { recursive: true });
  let name = memorySlug(input.name);
  let file = path.join(memDir, `${name}.md`);
  for (let i = 2; await fsp.access(file).then(() => true, () => false); i++) {
    name = `${memorySlug(input.name)}-${i}`;
    file = path.join(memDir, `${name}.md`);
  }
  const desc = input.description.replace(/\s+/g, ' ').trim().slice(0, 200);
  const md = `---\nname: ${name}\ndescription: ${yamlStr(desc)}\nmetadata:\n  type: ${input.type}\n---\n\n${input.body.trim()}\n`;
  await fsp.writeFile(file, md, 'utf8');
  const index = path.join(memDir, 'MEMORY.md');
  const line = `- [${desc || name}](${name}.md) — ${desc || name}\n`;
  const existing = await fsp.readFile(index, 'utf8').catch(() => '');
  await fsp.writeFile(index, (existing ? existing.replace(/\n*$/, '\n') : '# Memory Index\n\n') + line, 'utf8');
  invalidateMemoryCache();
  return file;
}

function yamlStr(s: string): string {
  return JSON.stringify(s);
}
