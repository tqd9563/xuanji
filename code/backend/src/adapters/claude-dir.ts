/**
 * ClaudeDirAdapter —— 全仓唯一允许解析 ~/.claude 非公开格式的文件(架构铁律 1)。
 * 解析失败一律降级(跳过计数 / raw 透传),绝不 throw 到上层。全部只读。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import YAML from 'yaml';
import type { HistoryEntry, Memory, Replay, ReplayEvent, Skill } from '../types.js';

// ---------- 项目目录 ----------

/**
 * 解码 projects/ 目录名 → 真实路径。编码规则是 '/'→'-',但路径本身可含 '-',
 * 无法纯文本反解。策略:优先从该目录最新 session jsonl 里嗅探 "cwd" 字段;
 * 兜底用朴素替换。
 */
export async function decodeProjectDir(projectsRoot: string, dirName: string): Promise<string> {
  const dir = path.join(projectsRoot, dirName);
  try {
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    // 取 mtime 最新的一个,嗅探前 50 行
    let newest: { file: string; mtime: number } | null = null;
    for (const f of files) {
      const st = await fsp.stat(path.join(dir, f)).catch(() => null);
      if (st && (!newest || st.mtimeMs > newest.mtime)) newest = { file: f, mtime: st.mtimeMs };
    }
    if (newest) {
      const cwd = await sniffCwd(path.join(dir, newest.file));
      if (cwd) return cwd;
    }
  } catch {
    /* fall through */
  }
  return dirName.replace(/-/g, '/');
}

async function sniffCwd(jsonlPath: string): Promise<string | null> {
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 50) break;
      const m = line.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (m?.[1]?.startsWith('/')) return m[1];
    }
  } catch {
    /* ignore */
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

export interface RawProjectDir {
  encodedDir: string;
  path: string;
  sessionCount: number;
  memoryCount: number;
  exists: boolean;
}

export async function scanProjectDirs(claudeDir: string): Promise<RawProjectDir[]> {
  const root = path.join(claudeDir, 'projects');
  let dirs: string[] = [];
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: RawProjectDir[] = [];
  for (const encodedDir of dirs) {
    const full = path.join(root, encodedDir);
    const realPath = await decodeProjectDir(root, encodedDir);
    const files = await fsp.readdir(full).catch(() => [] as string[]);
    const sessionCount = files.filter((f) => f.endsWith('.jsonl')).length;
    const memoryFiles = await fsp
      .readdir(path.join(full, 'memory'))
      .catch(() => [] as string[]);
    const memoryCount = memoryFiles.filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
    out.push({
      encodedDir,
      path: realPath,
      sessionCount,
      memoryCount,
      exists: fs.existsSync(realPath),
    });
  }
  return out;
}

// ---------- history.jsonl ----------

export async function readHistory(claudeDir: string, opts?: { sinceMs?: number }): Promise<HistoryEntry[]> {
  const file = path.join(claudeDir, 'history.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: HistoryEntry[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (typeof j.display !== 'string' || typeof j.timestamp !== 'number') continue;
      if (opts?.sinceMs && j.timestamp < opts.sinceMs) continue;
      out.push({
        display: j.display,
        timestamp: j.timestamp,
        project: typeof j.project === 'string' ? j.project : '',
        sessionId: typeof j.sessionId === 'string' ? j.sessionId : '',
      });
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

// ---------- session jsonl 回放 ----------

/** 按 sessionId 在 projects/ 下定位 jsonl 文件 */
export async function findSessionFile(claudeDir: string, sessionId: string): Promise<string | null> {
  const root = path.join(claudeDir, 'projects');
  const dirs = await fsp.readdir(root).catch(() => [] as string[]);
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 批量定位 sessionId → jsonl 文件:一次扫完 projects/ 目录树,
 * 避免逐个 findSessionFile 的 O(会话数 × 目录数) readdir。
 */
export async function mapSessionFiles(claudeDir: string, sessionIds: Iterable<string>): Promise<Map<string, string>> {
  const want = new Set(sessionIds);
  const out = new Map<string, string>();
  if (!want.size) return out;
  const root = path.join(claudeDir, 'projects');
  const dirs = await fsp.readdir(root).catch(() => [] as string[]);
  for (const d of dirs) {
    if (out.size >= want.size) break;
    const files = await fsp.readdir(path.join(root, d)).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      if (want.has(id) && !out.has(id)) out.set(id, path.join(root, d, f));
    }
  }
  return out;
}

export async function parseReplay(jsonlPath: string, sessionId: string): Promise<Replay> {
  const events: ReplayEvent[] = [];
  let skippedLines = 0;
  let title: string | undefined;
  /** tool_use id → 事件索引,用于回填 tool_result */
  const toolIndex = new Map<string, number>();

  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      skippedLines++;
      continue;
    }
    switch (j.type) {
      case 'custom-title':
        if (typeof j.customTitle === 'string') title = j.customTitle;
        break;
      case 'ai-title':
        // 自动命名事件:仅在无人工命名时采用
        if (!title && typeof j.aiTitle === 'string') title = j.aiTitle;
        break;
      case 'agent-name':
        if (typeof j.agentName === 'string') title = j.agentName;
        break;
      case 'user': {
        const c = j.message?.content;
        if (typeof c === 'string') {
          events.push({ kind: 'user', text: c, ts: j.timestamp });
        } else if (Array.isArray(c)) {
          for (const block of c) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              events.push({ kind: 'user', text: block.text, ts: j.timestamp });
            } else if (block?.type === 'tool_result') {
              const idx = toolIndex.get(block.tool_use_id);
              if (idx !== undefined) {
                const ev = events[idx];
                if (ev?.kind === 'tool') {
                  ev.output = stringifyToolResult(block.content);
                  ev.isError = block.is_error === true;
                }
              }
            }
          }
        }
        break;
      }
      case 'assistant': {
        const blocks = j.message?.content;
        const model = j.message?.model;
        if (!Array.isArray(blocks)) break;
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            events.push({ kind: 'assistant', text: block.text, model, ts: j.timestamp });
          } else if (block?.type === 'tool_use') {
            events.push({
              kind: 'tool',
              name: String(block.name ?? 'unknown'),
              input: compactInput(block.input),
            });
            toolIndex.set(block.id, events.length - 1);
          }
          // thinking 块不进回放(签名密文无展示价值)
        }
        break;
      }
      // 已知的元事件:不进回放流
      case 'mode':
      case 'permission-mode':
      case 'file-history-snapshot':
      case 'attachment':
      case 'system':
      case 'last-prompt':
      case 'queue-operation':
        break;
      default:
        // 未知事件类型 → 降级原样透传(adapter 兜底,T1 风险缓解)
        events.push({ kind: 'raw', type: String(j.type ?? 'unknown'), json: line.slice(0, 2000) });
    }
  }
  return { sessionId, events, skippedLines, title };
}

function compactInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 500);
  try {
    const j = input as Record<string, unknown>;
    // 常见工具的主参数优先展示
    for (const key of ['command', 'file_path', 'pattern', 'query', 'prompt', 'url', 'skill', 'description']) {
      if (typeof j[key] === 'string') return (j[key] as string).slice(0, 500);
    }
    return JSON.stringify(input).slice(0, 500);
  } catch {
    return String(input).slice(0, 500);
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 4000);
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('\n')
      .slice(0, 4000);
  }
  try {
    return JSON.stringify(content).slice(0, 4000);
  } catch {
    return '';
  }
}

// ---------- session jsonl 用量(usage) ----------

export interface RawUsageRecord {
  model: string;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

/**
 * 流式抽取一个 session jsonl 的 assistant usage 记录。
 * 同一条 API 回复的 usage 会随流事件重复出现,按 message.id 去重取最后一次。
 */
/**
 * 抽取会话用量记录。sinceMs/untilMs 传入时只计入记录自身 timestamp 落在窗口内的记录
 *（成本必须按记录时间过滤,不能只按文件 mtime——否则窗口内动过的老会话会把整段历史算进来)。
 */
export async function extractUsage(jsonlPath: string, sinceMs?: number, untilMs?: number): Promise<RawUsageRecord[]> {
  const byMsgId = new Map<string, RawUsageRecord>();
  let anon = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.type !== 'assistant') continue;
      const u = j.message?.usage;
      if (!u || typeof u.output_tokens !== 'number') continue;
      if (sinceMs !== undefined || untilMs !== undefined) {
        const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
        if (!Number.isFinite(ts)) continue; // 开了时间过滤但无时间戳:不计入
        if (sinceMs !== undefined && ts < sinceMs) continue;
        if (untilMs !== undefined && ts > untilMs) continue;
      }
      const id = typeof j.message?.id === 'string' ? j.message.id : `anon-${anon++}`;
      byMsgId.set(id, {
        model: String(j.message?.model ?? 'unknown'),
        input: u.input_tokens ?? 0,
        cacheCreation: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      });
    } catch {
      /* skip */
    }
  }
  return [...byMsgId.values()];
}

/**
 * 会话默认名:注册表都查不到名字时,从转录提取一个可读标题。
 * 优先 custom-title/ai-title/agent-name 事件,其次首条 user 文本;扫描上限 120 行(标题都在开头附近)。
 */
export async function extractSessionTitle(jsonlPath: string): Promise<string | undefined> {
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let firstUser: string | undefined;
  let scanned = 0;
  try {
    for await (const line of rl) {
      if (++scanned > 120) break;
      if (!line.trim()) continue;
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const type = j.type;
      if (type === 'custom-title' || type === 'ai-title' || type === 'agent-name') {
        const t = typeof j.title === 'string' ? j.title : typeof j.name === 'string' ? j.name : undefined;
        if (t?.trim()) return t.trim().slice(0, 60);
      }
      if (!firstUser && type === 'user') {
        const content = (j.message as { content?: unknown } | undefined)?.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content.find((b) => (b as { type?: string }).type === 'text') as { text?: string } | undefined)?.text
            : undefined;
        const t = text?.trim();
        // 跳过系统注入的伪首条:compaction 续接摘要、caveat 前缀、命令输出、工具结果 XML
        if (t && !t.startsWith('<') && !/^(This session is being continued|Caveat:|\[Request interrupted)/.test(t)) {
          firstUser = t.replace(/\s+/g, ' ').slice(0, 40);
        }
      }
    }
  } finally {
    rl.close();
  }
  return firstUser;
}

// ---------- 技能 ----------

export async function scanSkills(claudeDir: string): Promise<Skill[]> {
  const out: Skill[] = [];
  const scanDir = async (root: string, source: 'user' | 'plugin', enabled: boolean, depth: number) => {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const dir = path.join(root, e.name);
      // 技能大多以 symlink 安装,必须跟随链接判断目录
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        const st = await fsp.stat(dir).catch(() => null);
        isDir = st?.isDirectory() ?? false;
      }
      if (!isDir) continue;
      const skillMd = path.join(dir, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        const skill = await parseSkillMd(skillMd, source, enabled);
        if (skill) out.push(skill);
      } else if (depth > 0) {
        await scanDir(dir, source, enabled, depth - 1);
      }
    }
  };
  await scanDir(path.join(claudeDir, 'skills'), 'user', true, 0);
  await scanDir(path.join(claudeDir, 'skills-disabled'), 'user', false, 0);
  await scanDir(path.join(claudeDir, 'plugins'), 'plugin', true, 4);
  // 插件目录可能同名多版本,按 name 去重(保留先扫到的)
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

async function parseSkillMd(file: string, source: 'user' | 'plugin', enabled: boolean): Promise<Skill | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const fm = splitFrontmatter(raw);
    if (!fm) return null;
    const meta = YAML.parse(fm.frontmatter) ?? {};
    if (typeof meta.name !== 'string' || !meta.name) return null;
    return {
      name: meta.name,
      description: String(meta.description ?? '').slice(0, 500),
      version: meta.metadata?.version ?? meta.version,
      userInvocable: meta['user-invocable'] !== false,
      allowedTools: Array.isArray(meta['allowed-tools'])
        ? meta['allowed-tools'].join(', ')
        : typeof meta['allowed-tools'] === 'string'
          ? meta['allowed-tools']
          : undefined,
      source,
      enabled,
      body: fm.body.slice(0, 8000),
    };
  } catch {
    return null;
  }
}

// ---------- 经验 memory ----------

export async function scanMemories(
  claudeDir: string,
  projectMap: Map<string, string>, // encodedDir -> realPath
): Promise<Memory[]> {
  const root = path.join(claudeDir, 'projects');
  const out: Memory[] = [];
  for (const [encodedDir, realPath] of projectMap) {
    const memDir = path.join(root, encodedDir, 'memory');
    const files = await fsp.readdir(memDir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const m = await parseMemoryMd(path.join(memDir, f), realPath);
      if (m) out.push(m);
    }
  }
  return out;
}

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference']);

async function parseMemoryMd(file: string, projectPath: string): Promise<Memory | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const fm = splitFrontmatter(raw);
    const meta = fm ? (YAML.parse(fm.frontmatter) ?? {}) : {};
    const body = (fm ? fm.body : raw).trim();
    const rawType = meta.metadata?.type ?? meta.type;
    const links = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!).filter(Boolean);
    return {
      name: String(meta.name ?? path.basename(file, '.md')),
      description: String(meta.description ?? '').slice(0, 500),
      type: VALID_TYPES.has(rawType) ? rawType : 'unknown',
      project: path.basename(projectPath),
      projectPath,
      file,
      body: body.slice(0, 8000),
      links,
    };
  } catch {
    return null;
  }
}

// ---------- jobs/<id>/state.json ----------

export interface JobState {
  state?: string;
  detail?: string;
  needs?: string;
  tokens?: number;
  /** state.json 的 updatedAt(ms):bg 任务最近变化时间,「待验收」比较基准 */
  updatedAt?: number;
}

export async function readJobStates(claudeDir: string): Promise<Map<string, JobState>> {
  const root = path.join(claudeDir, 'jobs');
  const out = new Map<string, JobState>();
  const dirs = await fsp.readdir(root).catch(() => [] as string[]);
  for (const d of dirs) {
    try {
      const raw = await fsp.readFile(path.join(root, d, 'state.json'), 'utf8');
      const j = JSON.parse(raw);
      const updatedAt = typeof j.updatedAt === 'string' ? Date.parse(j.updatedAt) : NaN;
      out.set(d, {
        state: typeof j.state === 'string' ? j.state : undefined,
        detail: typeof j.detail === 'string' ? j.detail : undefined,
        needs: typeof j.needs === 'string' ? j.needs : undefined,
        tokens: typeof j.tokens === 'number' ? j.tokens : undefined,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
      });
    } catch {
      /* 无 state.json 或坏文件,跳过 */
    }
  }
  return out;
}

// ---------- 技能启停(唯一的 ~/.claude 写操作之一) ----------

/**
 * 铁律 2 例外②(2026-07-08 用户批准):用户在界面显式触发、带二次确认的管理操作。
 * 启停 = 在 skills/ 与 skills-disabled/ 间移动技能目录(rename,不改内容,可逆)。
 */
export async function moveSkill(
  claudeDir: string,
  name: string,
  enable: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!/^[\w.-]+$/.test(name)) return { ok: false, error: 'invalid skill name' };
  const from = path.join(claudeDir, enable ? 'skills-disabled' : 'skills', name);
  const to = path.join(claudeDir, enable ? 'skills' : 'skills-disabled', name);
  try {
    const st = await fsp.lstat(from).catch(() => null);
    if (!st) return { ok: false, error: `技能不在${enable ? '禁用' : '启用'}目录中` };
    if (await fsp.lstat(to).catch(() => null)) return { ok: false, error: '目标位置已存在同名技能' };
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- 工具 ----------

function splitFrontmatter(raw: string): { frontmatter: string; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  return { frontmatter: m[1]!, body: m[2] ?? '' };
}
