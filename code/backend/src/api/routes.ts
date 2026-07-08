import { Hono } from 'hono';
import fs from 'node:fs';
import { config } from '../config.js';
import { cliVersion, readCrontab, summarizeForHandoff } from '../adapters/agents-cli.js';
import { moveSkill, readHistory } from '../adapters/claude-dir.js';
import { dashboard } from '../services/dashboard.js';
import { canResume } from '../services/dispatch.js';
import { listProjects } from '../services/projects.js';
import { sessionsBoard, sessionReplay } from '../services/sessions.js';
import { invalidateSkillsCache, listSkills } from '../services/skills.js';
import { listMemories, searchMemories } from '../services/memories.js';
import { todayUsage } from '../services/usage.js';
import type { Storage } from '../storage/db.js';

const DAY = 86_400_000;

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

  api.get('/dashboard', async (c) => c.json(await dashboard()));

  api.get('/projects', async (c) => {
    const history = await readHistory(config.claudeDir, { sinceMs: Date.now() - 90 * DAY });
    return c.json(await listProjects(history));
  });

  api.get('/sessions', async (c) => c.json(await sessionsBoard(storage)));

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

  /** resume 前的所有权预检(前端在跳转派发页前调用) */
  api.get('/sessions/:sessionId/can-resume', async (c) => {
    return c.json(await canResume(c.req.param('sessionId')));
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
