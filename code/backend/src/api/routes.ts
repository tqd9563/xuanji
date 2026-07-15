import { Hono } from 'hono';
import fs from 'node:fs';
import { config } from '../config.js';
import { cliVersion, listAgents, readCrontab, summarizeForHandoff } from '../adapters/agents-cli.js';
import { moveSkill, readHistory, scanProjectDirs } from '../adapters/claude-dir.js';
import { dashboard } from '../services/dashboard.js';
import { canResume, endDispatchBySessionId } from '../services/dispatch.js';
import { listProjects } from '../services/projects.js';
import { closedSessions, sessionsBoard, sessionReplay } from '../services/sessions.js';
import { invalidateSkillsCache, listSkills } from '../services/skills.js';
import { listMemories, searchMemories } from '../services/memories.js';
import { todayUsage } from '../services/usage.js';
import { weeklyReview } from '../services/weekly-review.js';
import { startWeeklyDraft } from '../services/weekly-draft.js';
import type { Storage } from '../storage/db.js';

const DAY = 86_400_000;

/** query/body 数值参数:仅接受有限正数 */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createApi(storage: Storage) {
  const api = new Hono();

  api.get('/health', async (c) => {
    const cli = await cliVersion();
    return c.json({
      ok: true,
      cli,
      claudeDir: config.claudeDir,
      claudeDirExists: fs.existsSync(config.claudeDir),
      now: Date.now(),
    });
  });

  api.get('/dashboard', async (c) => c.json(await dashboard(storage)));

  api.get('/projects', async (c) => {
    const history = await readHistory(config.claudeDir, { sinceMs: Date.now() - 90 * DAY });
    return c.json(await listProjects(history));
  });

  api.get('/sessions', async (c) => c.json(await sessionsBoard(storage)));

  /** 项目分类色调色板:name → 序号(首次出现顺序,SQLite 固定;色相映射在前端色环) */
  api.get('/palette', async (c) => {
    const [dirs, agents] = await Promise.all([scanProjectDirs(config.claudeDir), listAgents()]);
    const names: string[] = [];
    for (const p of dirs) {
      if (config.projectNoisePatterns.some((re) => re.test(p.path) || re.test(p.encodedDir))) continue;
      if (!p.exists) continue;
      names.push(p.path.split('/').filter(Boolean).pop() ?? '');
    }
    for (const s of agents.sessions) names.push(s.project);
    for (const d of storage.allDispatches()) names.push(d.cwd.split('/').filter(Boolean).pop() ?? '');
    const map = storage.assignPalette(names.filter(Boolean));
    return c.json({ idx: Object.fromEntries(map) });
  });

  api.get('/sessions/:sessionId/replay', async (c) => {
    const replay = await sessionReplay(c.req.param('sessionId'));
    if (!replay) return c.json({ error: 'session not found' }, 404);
    return c.json(replay);
  });

  api.get('/skills', async (c) => c.json({ skills: await listSkills() }));

  api.get('/memories', async (c) => c.json({ memories: await listMemories(storage) }));

  api.get('/memories/search', async (c) => {
    const q = c.req.query('q')?.trim() ?? '';
    if (!q) return c.json({ memories: [] });
    return c.json({ memories: await searchMemories(storage, q) });
  });

  api.get('/usage/today', async (c) => {
    const board = await sessionsBoard(storage);
    const names = new Map<string, string>();
    for (const col of Object.values(board.columns)) for (const s of col) names.set(s.sessionId, s.name);
    return c.json(await todayUsage((id) => names.get(id)));
  });

  // ---------- M2 写操作与派发辅助 ----------

  /** 技能启停:铁律例外②——显式触发 + confirm 双确认,目录移动可逆 */
  api.post('/skills/:name/toggle', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.confirm !== true) return c.json({ error: '需要 confirm: true(二次确认)' }, 400);
    if (typeof body.enable !== 'boolean') return c.json({ error: '需要 enable: boolean' }, 400);
    const r = await moveSkill(config.claudeDir, c.req.param('name'), body.enable);
    if (!r.ok) return c.json({ error: r.error }, 409);
    invalidateSkillsCache();
    return c.json({ ok: true });
  });

  /** web 会话重命名:display-name 覆盖存自有 SQLite,终端存活会话拒绝 */
  api.put('/sessions/:sessionId/name', async (c) => {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 80) return c.json({ error: 'name 需为 1-80 字符' }, 400);
    const check = await canResume(sessionId);
    if (!check.ok) return c.json({ error: check.reason }, 403);
    storage.setSessionName(sessionId, name);
    return c.json({ ok: true });
  });

  /** 跨目录交接(方案二):生成上一会话的结构化摘要,由前端注入新会话首条消息 */
  api.post('/dispatch/handoff', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = String(body.sessionId ?? '');
    const replay = await sessionReplay(sessionId);
    if (!replay) return c.json({ error: '找不到会话记录' }, 404);
    const transcript = replay.events
      .filter((e) => e.kind === 'user' || e.kind === 'assistant')
      .slice(-40)
      .map((e) => `${e.kind === 'user' ? '用户' : 'Claude'}: ${(e as { text: string }).text}`)
      .join('\n');
    try {
      const summary = await summarizeForHandoff(transcript);
      return c.json({ summary, from: replay.title ?? sessionId.slice(0, 8) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  /**
   * 看板「关闭」会话:自有隐藏列表(不写 ~/.claude,可逆);
   * 进程内存活的派发会话额外真正结束其子进程;终端存活/运行中的 bg 任务拒绝。
   */
  api.post('/sessions/:sessionId/close', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return c.json({ error: 'bad sessionId' }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (body.confirm !== true) return c.json({ error: '需要 confirm: true(二次确认)' }, 400);
    // 自家存活的派发会话:结束子进程 + 隐藏
    if (await endDispatchBySessionId(sessionId)) {
      storage.hideSession(sessionId);
      return c.json({ ok: true, ended: true });
    }
    const agents = await listAgents();
    const live = agents.sessions.find((s) => s.sessionId === sessionId);
    if (live?.readonly) return c.json({ error: '终端存活的交互会话只读,请在终端里退出' }, 403);
    if (live?.kind === 'background' && live.state === 'running') {
      return c.json({ error: '运行中的后台任务不能从璇玑关闭,等它完成或在终端 claude agents 处理' }, 409);
    }
    storage.hideSession(sessionId);
    return c.json({ ok: true, ended: false });
  });

  /** resume 前的所有权预检(前端在跳转派发页前调用) */
  api.get('/sessions/:sessionId/can-resume', async (c) => {
    return c.json(await canResume(c.req.param('sessionId')));
  });

  /** 已关闭(隐藏)会话清单:/resume 弹窗数据源;cwd 过滤当前项目 */
  api.get('/sessions/closed', async (c) => {
    const cwd = c.req.query('cwd')?.trim() || undefined;
    return c.json({ sessions: await closedSessions(storage, cwd) });
  });

  /** 恢复已关闭会话:hide 的逆操作(自有隐藏列表删行,~/.claude 不涉及),卡片回看板 */
  api.post('/sessions/:sessionId/unhide', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return c.json({ error: 'bad sessionId' }, 400);
    storage.unhideSession(sessionId);
    return c.json({ ok: true });
  });

  // ---------- 周回顾 ----------

  /** 周活动聚合:默认最近 7 天;start/end 为 epoch ms,窗口封顶 32 天 */
  api.get('/weekly-review', async (c) => {
    const now = Date.now();
    const end = num(c.req.query('end')) ?? now;
    const start = num(c.req.query('start')) ?? end - 7 * DAY;
    if (!(start < end) || end - start > 32 * DAY) {
      return c.json({ error: 'start/end 需为 ms 且 0 < end - start ≤ 32 天' }, 400);
    }
    return c.json(await weeklyReview(storage, start, end));
  });

  /** 手动生成周报草稿:走派发通道(看板可跟踪),立即返回草稿 id,前端轮询 drafts */
  api.post('/weekly-review/draft', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const end = num(body.end) ?? Date.now();
    const start = num(body.start) ?? end - 7 * DAY;
    if (!(start < end) || end - start > 32 * DAY) {
      return c.json({ error: 'start/end 需为 ms 且 0 < end - start ≤ 32 天' }, 400);
    }
    const model = typeof body.model === 'string' && body.model ? body.model : undefined;
    try {
      return c.json(await startWeeklyDraft(storage, { start, end, model }));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  /** 草稿列表(倒序,含 running/done/error),前端按窗口过滤与轮询 */
  api.get('/weekly-review/drafts', async (c) => {
    return c.json({ drafts: storage.listDrafts() });
  });

  api.get('/crons', async (c) => {
    const system = await readCrontab();
    return c.json({
      app: [], // 应用内调度器 M3 落地
      system,
      caliber: 'system 来自 crontab -l 只读输出(过滤注释与空行),仅展示不接管',
    });
  });

  return api;
}
