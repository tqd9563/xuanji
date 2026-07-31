/**
 * WorklogAdapter —— 解析 ~/.claude/worklog/ 下由 wrapup skill 生成的任务总结卡
 * (架构铁律 1:非公开格式的解析只允许存在于 Adapter 层)。全部只读。
 *
 * 卡片由 skill 生成,格式可能漂移,所以解析全程降级:frontmatter 坏了标 degraded 但保留卡,
 * 正文段落一个都认不出就把全文塞进 sections.raw。绝不因单张坏卡拖垮整个列表。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { WorklogCard, WorklogSections } from '../types.js';

/** worklog 根目录:与 skills/ memory/ 同级,挂在 claudeDir 下 */
export function worklogRoot(claudeDir: string): string {
  return path.join(claudeDir, 'worklog');
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/;
const VALID_STATUS = new Set(['merged', 'pending-merge', 'unresolved']);

/**
 * 扫 worklog/<YYYY>/<MM>/*.md。目录层级是 skill 的约定,但不强依赖——
 * 递归两层找 .md 即可,顶层 INDEX.md 是给人看的索引,跳过。
 */
export async function scanWorklog(claudeDir: string): Promise<WorklogCard[]> {
  const root = worklogRoot(claudeDir);
  const out: WorklogCard[] = [];
  const years = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    const yDir = path.join(root, y.name);
    const months = await fsp.readdir(yDir, { withFileTypes: true }).catch(() => []);
    for (const m of months) {
      if (!m.isDirectory()) continue;
      const mDir = path.join(yDir, m.name);
      const files = await fsp.readdir(mDir).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith('.md') || f === 'INDEX.md') continue;
        const card = await parseWorklogMd(path.join(mDir, f));
        if (card) out.push(card);
      }
    }
  }
  // 日期倒序,同日按文件名倒序(名字里含任务 slug,稳定可预期)
  out.sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
  return out;
}

export async function parseWorklogMd(file: string): Promise<WorklogCard | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const base = path.basename(file, '.md');
  const fm = splitFrontmatter(raw);
  let meta: Record<string, unknown> = {};
  let degraded = false;
  if (fm) {
    try {
      meta = (YAML.parse(fm.frontmatter) as Record<string, unknown>) ?? {};
    } catch {
      degraded = true; // frontmatter 语法坏了:仍然出卡,字段走文件名兜底
    }
  } else {
    degraded = true;
  }
  const body = (fm ? fm.body : raw).trim();

  // 文件名形如 2026-07-31-<project>-<task>.md,是 date 的可靠兜底
  const fromName = DATE_RE.exec(base);
  const date = str(meta.date) ?? (fromName ? `${fromName[1]}-${fromName[2]}-${fromName[3]}` : '');
  const rawStatus = str(meta.status);

  return {
    name: str(meta.name) ?? base,
    date,
    project: str(meta.project) ?? '(未标注)',
    task: str(meta.task) ?? base,
    branch: str(meta.branch),
    commits: strList(meta.commits),
    mr: str(meta.mr),
    refs: strList(meta.refs),
    status: rawStatus && VALID_STATUS.has(rawStatus) ? (rawStatus as WorklogCard['status']) : 'unknown',
    session: str(meta.session),
    coversUntil: str(meta.covers_until) ?? str(meta.coversUntil),
    file,
    sections: parseSections(body),
    degraded,
  };
}

/** 正文按 `## 段名` 切分。段名认中文标题(skill 模板固定),认不出的段落并入 raw。 */
function parseSections(body: string): WorklogSections {
  const s: WorklogSections = { excluded: [], residue: [], decisions: [], files: [] };
  if (!body) return s;
  const parts = body.split(/^##\s+/m).slice(1);
  if (parts.length === 0) {
    s.raw = body.slice(0, 8000);
    return s;
  }
  let matched = 0;
  const leftover: string[] = [];
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = (nl === -1 ? part : part.slice(0, nl)).trim();
    const content = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (head.startsWith('问题')) {
      s.problem = content.slice(0, 4000);
      matched++;
    } else if (head.startsWith('结论')) {
      s.conclusion = content.slice(0, 4000);
      matched++;
    } else if (head.startsWith('排除')) {
      s.excluded = bullets(content);
      matched++;
    } else if (head.includes('残留')) {
      s.residue = bullets(content);
      matched++;
    } else if (head.includes('决策')) {
      s.decisions = bullets(content);
      matched++;
    } else if (head.includes('文件')) {
      s.files = bullets(content);
      matched++;
    } else {
      leftover.push(`## ${head}\n${content}`);
    }
  }
  // 一个已知段落都没认出来 → 全文兜底;认出了但有多余段落 → 只留多余部分
  if (matched === 0) s.raw = body.slice(0, 8000);
  else if (leftover.length > 0) s.raw = leftover.join('\n\n').slice(0, 8000);
  return s;
}

/** `- xxx` / `* xxx` 逐条;非列表正文整体作一条(卡片里写「无」是常态) */
function bullets(content: string): string[] {
  if (!content) return [];
  const items = content
    .split(/\r?\n/)
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
  if (items.length > 0) return items.slice(0, 40).map((x) => x.slice(0, 800));
  const flat = content.trim();
  return flat ? [flat.slice(0, 800)] : [];
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** commits/refs 在卡里写作 YAML 数组,但手写成逗号串也认 */
function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 40);
  const s = str(v);
  if (!s) return [];
  return s
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  return { frontmatter: m[1]!, body: m[2] ?? '' };
}
