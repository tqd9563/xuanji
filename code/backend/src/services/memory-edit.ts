/**
 * 经验的编辑 / 删除 / 恢复(架构铁律 2 例外④,2026-11-27 用户批准)。
 *
 * 只在用户于经验页显式触发时调用。三条不变量:
 * 1. 编辑前校验 rev(原文指纹),文件被别处改过就拒绝,由用户决定载入最新还是覆盖;
 * 2. 删除不真删:文件进 `config.trashDir/memory/<id>/`,连同被移除的 MEMORY.md 索引行一起记下,可原样恢复;
 * 3. 共享经验是指向 memory-shared 的软链:写入要落到真身(不能把软链换成普通文件),删除默认只卸载本项目的软链。
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { config } from '../config.js';
import { memoryRev, parseMemoryIndex, parseMemoryMd, splitMemoryMd } from '../adapters/claude-dir.js';
import type { Memory, TrashedMemory } from '../types.js';
import { invalidateMemoryCache, listMemories } from './memories.js';

export class MemoryEditError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const EDITABLE_TYPES = new Set(['user', 'feedback', 'project', 'reference', 'cross-project']);
const trashRoot = () => path.join(config.trashDir, 'memory');
const exists = (p: string) => fsp.lstat(p).then(() => true, () => false);

/** 只接受 `<claudeDir>/projects/<slug>/memory/<name>.md`,且不是索引本身;其余路径一律拒绝 */
function resolveMemoryFile(file: unknown): { abs: string; memDir: string; base: string } {
  if (typeof file !== 'string' || !file) throw new MemoryEditError(400, '缺少 file');
  const root = path.join(config.claudeDir, 'projects');
  const abs = path.resolve(file);
  const parts = path.relative(root, abs).split(path.sep);
  if (parts.length !== 3 || parts[0] === '..' || parts[1] !== 'memory' || !parts[2]!.endsWith('.md') || parts[2] === 'MEMORY.md') {
    throw new MemoryEditError(400, '不是经验文件');
  }
  return { abs, memDir: path.dirname(abs), base: parts[2]! };
}

async function known(abs: string): Promise<Memory | undefined> {
  return (await listMemories()).find((m) => path.normalize(m.file) === abs);
}

/** 完整详情(正文不截断):编辑前取 */
export async function memoryDetail(file: unknown): Promise<Memory> {
  const { abs, memDir, base } = resolveMemoryFile(file);
  const listed = await known(abs);
  const m = await parseMemoryMd(abs, listed?.projectPath ?? path.dirname(memDir), { full: true });
  if (!m) throw new MemoryEditError(404, '经验文件不存在');
  const hooks = parseMemoryIndex(await fsp.readFile(path.join(memDir, 'MEMORY.md'), 'utf8').catch(() => ''));
  return { ...m, sharedWith: listed?.sharedWith ?? m.sharedWith, indexHook: hooks.get(base) ?? null };
}

/** 同目录临时文件 + rename:写一半断电不会留下半截文件 */
async function atomicWrite(file: string, text: string) {
  const tmp = `${file}.xuanji-${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 改写 MEMORY.md 里指向 base 的那一行的摘要;没有索引行则追加一行 */
async function writeIndexHook(memDir: string, base: string, name: string, hook: string) {
  const index = path.join(memDir, 'MEMORY.md');
  const text = await fsp.readFile(index, 'utf8').catch(() => '');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes(`](${base})`));
  if (at >= 0) {
    const head = lines[at]!.slice(0, lines[at]!.indexOf(`](${base})`) + base.length + 3);
    lines[at] = hook ? `${head} — ${hook}` : head;
    await atomicWrite(index, lines.join('\n'));
  } else if (hook) {
    await atomicWrite(index, (text ? text.replace(/\n*$/, '\n') : '# Memory Index\n\n') + `- [${name}](${base}) — ${hook}\n`);
  }
}

export async function updateMemory(input: {
  file: unknown;
  description?: unknown;
  type?: unknown;
  body?: unknown;
  indexHook?: unknown;
  rev?: unknown;
  force?: unknown;
}): Promise<Memory> {
  const { abs, memDir, base } = resolveMemoryFile(input.file);
  if (typeof input.body !== 'string' || !input.body.trim()) throw new MemoryEditError(400, '正文不能为空');
  if (typeof input.description !== 'string') throw new MemoryEditError(400, '缺少 description');
  // 'unknown' = 原文件的类型不在白名单里且用户没改它:保存时原样保留,不强行归类
  const keepType = input.type === 'unknown';
  if (!keepType && (typeof input.type !== 'string' || !EDITABLE_TYPES.has(input.type))) throw new MemoryEditError(400, '类型不合法');
  const raw = await fsp.readFile(abs, 'utf8').catch(() => null);
  if (raw === null) throw new MemoryEditError(404, '经验文件不存在(可能已被删除)');
  if (!input.force && input.rev !== memoryRev(raw)) {
    throw new MemoryEditError(409, '文件在你编辑期间被别处改过', { latest: await memoryDetail(abs) });
  }

  const { meta } = splitMemoryMd(raw);
  const next: Record<string, unknown> = { ...meta };
  if (next.name === undefined) next.name = path.basename(base, '.md');
  next.description = oneLine(input.description);
  // type 写回它原来所在的位置:metadata.type(新格式)或顶层 type(旧格式);都没有时用新格式
  if (keepType) {
    /* 不动 */
  } else if (meta.metadata && typeof meta.metadata === 'object') next.metadata = { ...(meta.metadata as object), type: input.type };
  else if ('type' in meta) next.type = input.type;
  else next.metadata = { type: input.type };
  const text = `---\n${YAML.stringify(next, { lineWidth: 0 }).trimEnd()}\n---\n\n${input.body.trim()}\n`;
  // 软链要写到真身:对软链路径 rename 会把它换成普通文件,共享关系就断了
  if (text !== raw) await atomicWrite(await fsp.realpath(abs), text);

  if (typeof input.indexHook === 'string') {
    const hooks = parseMemoryIndex(await fsp.readFile(path.join(memDir, 'MEMORY.md'), 'utf8').catch(() => ''));
    const hook = oneLine(input.indexHook);
    if ((hooks.get(base) ?? '') !== hook) await writeIndexHook(memDir, base, String(next.name), hook);
  }
  invalidateMemoryCache();
  return memoryDetail(abs);
}

interface TrashMount {
  /** 被移走的路径(本项目里的文件或软链) */
  path: string;
  /** 软链的原始指向(readlink 原文,恢复时照原样重建);普通文件为 null */
  link: string | null;
  /** 被移除的 MEMORY.md 索引行原文与行号;没有索引行为 null */
  indexLine: string | null;
  indexAt: number;
}
interface TrashMeta {
  id: string;
  deletedAt: number;
  mode: TrashedMemory['mode'];
  base: string;
  projectPath: string;
  /** all 模式下被移走的共享库真身路径 */
  target: string | null;
  mounts: TrashMount[];
}

async function removeIndexLine(memDir: string, base: string): Promise<{ line: string | null; at: number }> {
  const index = path.join(memDir, 'MEMORY.md');
  const text = await fsp.readFile(index, 'utf8').catch(() => null);
  if (text === null) return { line: null, at: -1 };
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes(`](${base})`));
  if (at < 0) return { line: null, at: -1 };
  const [line] = lines.splice(at, 1);
  await atomicWrite(index, lines.join('\n'));
  return { line: line!, at };
}

async function restoreIndexLine(memDir: string, line: string, at: number) {
  const index = path.join(memDir, 'MEMORY.md');
  const text = await fsp.readFile(index, 'utf8').catch(() => '# Memory Index\n');
  const lines = text.split('\n');
  // 原行号还在范围内就放回原位;否则插到末尾的空行之前
  let pos = at >= 0 && at <= lines.length ? at : lines.length;
  if (pos === lines.length && lines[lines.length - 1] === '') pos = lines.length - 1;
  lines.splice(pos, 0, line);
  await atomicWrite(index, lines.join('\n'));
}

/** 所有指向同一真身的软链(含噪音项目——它们不在列表里,但「连真身一起删」时同样会断) */
async function mountsOf(target: string, base: string): Promise<string[]> {
  const root = path.join(config.claudeDir, 'projects');
  const out: string[] = [];
  for (const d of await fsp.readdir(root).catch(() => [] as string[])) {
    const p = path.join(root, d, 'memory', base);
    const st = await fsp.lstat(p).catch(() => null);
    if (st?.isSymbolicLink() && (await fsp.realpath(p).catch(() => '')) === target) out.push(p);
  }
  return out;
}

export async function deleteMemory(input: { file: unknown; mode?: unknown }): Promise<TrashedMemory> {
  const { abs, memDir, base } = resolveMemoryFile(input.file);
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) throw new MemoryEditError(404, '经验文件不存在(可能已被删除)');
  const isLink = st.isSymbolicLink();
  const mode: TrashMeta['mode'] = !isLink ? 'file' : input.mode === 'all' ? 'all' : 'unmount';
  const listed = await known(abs);
  const projectPath = listed?.projectPath ?? path.dirname(memDir);
  const target = isLink ? await fsp.realpath(abs) : null;

  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(trashRoot(), id);
  await fsp.mkdir(dir, { recursive: true });
  // 先把内容安顿进回收目录,再动原处:中途失败也不会丢内容
  await fsp.copyFile(target ?? abs, path.join(dir, base));

  const paths = mode === 'all' ? [...new Set([abs, ...(await mountsOf(target!, base))])] : [abs];
  const mounts: TrashMount[] = [];
  for (const p of paths) {
    const link = isLink ? await fsp.readlink(p) : null;
    const idx = await removeIndexLine(path.dirname(p), base);
    await fsp.unlink(p);
    mounts.push({ path: p, link, indexLine: idx.line, indexAt: idx.at });
  }
  if (mode === 'all') await fsp.unlink(target!);
  const meta: TrashMeta = { id, deletedAt: Date.now(), mode, base, projectPath, target: mode === 'all' ? target : null, mounts };
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  invalidateMemoryCache();
  return toTrashed(meta);
}

async function readMeta(id: string): Promise<TrashMeta> {
  if (!/^[\w-]+$/.test(id)) throw new MemoryEditError(400, '回收记录 id 不合法');
  const raw = await fsp.readFile(path.join(trashRoot(), id, 'meta.json'), 'utf8').catch(() => null);
  if (raw === null) throw new MemoryEditError(404, '回收记录不存在');
  return JSON.parse(raw) as TrashMeta;
}

async function toTrashed(meta: TrashMeta): Promise<TrashedMemory> {
  const m = await parseMemoryMd(path.join(trashRoot(), meta.id, meta.base), meta.projectPath, { full: true });
  if (!m) throw new MemoryEditError(404, '回收目录里的文件读不出来');
  const hook = meta.mounts[0]?.indexLine ? (parseMemoryIndex(meta.mounts[0].indexLine).get(meta.base) ?? null) : null;
  return {
    id: meta.id,
    deletedAt: meta.deletedAt,
    mode: meta.mode,
    // file 给回原路径:前端展示与「恢复到哪」都以它为准
    memory: { ...m, file: meta.mounts[0]?.path ?? m.file, sharedWith: meta.mode === 'file' ? null : [], indexHook: hook },
  };
}

export async function listTrash(): Promise<TrashedMemory[]> {
  const ids = await fsp.readdir(trashRoot()).catch(() => [] as string[]);
  const out: TrashedMemory[] = [];
  for (const id of ids) {
    try {
      out.push(await toTrashed(await readMeta(id)));
    } catch {
      /* 残缺的回收记录不挡其它条目 */
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function restoreMemory(id: string): Promise<{ file: string }> {
  const meta = await readMeta(id);
  const src = path.join(trashRoot(), id, meta.base);
  // 先全部检查再动手:原位置已有同名文件就整体拒绝,不做一半
  for (const p of [...meta.mounts.map((m) => m.path), ...(meta.target ? [meta.target] : [])]) {
    if (await exists(p)) throw new MemoryEditError(409, `原位置已有同名文件:${p}`);
  }
  if (meta.target) {
    await fsp.mkdir(path.dirname(meta.target), { recursive: true });
    await fsp.copyFile(src, meta.target);
  }
  for (const m of meta.mounts) {
    await fsp.mkdir(path.dirname(m.path), { recursive: true });
    if (m.link !== null) await fsp.symlink(m.link, m.path);
    else await fsp.copyFile(src, m.path);
    if (m.indexLine !== null) await restoreIndexLine(path.dirname(m.path), m.indexLine, m.indexAt);
  }
  await fsp.rm(path.join(trashRoot(), id), { recursive: true, force: true });
  invalidateMemoryCache();
  return { file: meta.mounts[0]?.path ?? meta.target ?? '' };
}
