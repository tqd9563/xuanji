import { Hono } from 'hono';
import fs from 'node:fs';
import { config } from '../config.js';
import { cliVersion, readCrontab } from '../adapters/agents-cli.js';
import { readHistory } from '../adapters/claude-dir.js';
import { dashboard } from '../services/dashboard.js';
import { listProjects } from '../services/projects.js';
import { sessionsBoard, sessionReplay } from '../services/sessions.js';
import { listSkills } from '../services/skills.js';
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

  api.get('/sessions', async (c) => c.json(await sessionsBoard()));

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
    const board = await sessionsBoard();
    const names = new Map<string, string>();
    for (const col of Object.values(board.columns)) for (const s of col) names.set(s.sessionId, s.name);
    return c.json(await todayUsage((id) => names.get(id)));
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
