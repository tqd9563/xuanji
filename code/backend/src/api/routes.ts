import { Hono, type Context } from 'hono';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { cliVersion, listAgents, readCrontab, summarizeForHandoff } from '../adapters/agents-cli.js';
import { moveSkill, readHistory, scanProjectDirs } from '../adapters/claude-dir.js';
import { dashboard } from '../services/dashboard.js';
import { canResume, endDispatchBySessionId } from '../services/dispatch.js';
import { resolveWorkdir } from '../services/paths.js';
import { listProjects } from '../services/projects.js';
import { closedSessions, sessionsBoard, sessionReplay, usageNameResolver } from '../services/sessions.js';
import { invalidateSkillsCache, listSkills } from '../services/skills.js';
import { DAILY_SPAN, lastScanTime, skillDailySeries, USAGE_CALIBER } from '../services/skill-usage.js';
import { listMemories, searchMemories } from '../services/memories.js';
import { queryWorklog } from '../services/worklog.js';
import { isTodoStatus, resolveProject, statusPatch, validateTitle } from '../services/todos.js';
import { isUsageRange, usageReport, type UsageRange } from '../services/usage.js';
import { weeklyReview } from '../services/weekly-review.js';
import { startWeeklyDraft } from '../services/weekly-draft.js';
import { liveEnvironments, resolveRunbook, resolveSessionCleanup, runRequest } from '../services/runbook.js';
import type { SchedulerService, UpdateJobInput } from '../services/scheduler.js';
import type { RunbookItem, RunbookTemplate, SessionState, WorklogCard } from '../types.js';
import type { Storage } from '../storage/db.js';

const DAY = 86_400_000;
const execFileP = promisify(execFile);

/** query/body 数值参数:仅接受有限正数 */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createApi(storage: Storage, scheduler: SchedulerService) {
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

  /** /wd 手输路径的解析与校验:展开 `~`、归一为绝对路径,并回报是否真是一个目录 */
  api.get('/resolve-path', (c) => {
    const raw = c.req.query('path');
    if (!raw?.trim()) return c.json({ error: 'path required' }, 400);
    return c.json(resolveWorkdir(raw));
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

  api.get('/skills', async (c) =>
    c.json({
      skills: await listSkills(storage),
      usageCaliber: USAGE_CALIBER,
      usageComputedAt: lastScanTime(),
    }),
  );

  /** 单技能近 30 天逐日触发次数(抽屉迷你柱);只读索引,不触发扫描 */
  api.get('/skills/:name/usage-daily', (c) =>
    c.json({ days: skillDailySeries(storage, c.req.param('name')), span: DAILY_SPAN }),
  );

  api.get('/memories', async (c) => c.json({ memories: await listMemories(storage) }));

  api.get('/memories/search', async (c) => {
    const q = c.req.query('q')?.trim() ?? '';
    if (!q) return c.json({ memories: [] });
    return c.json({ memories: await searchMemories(storage, q) });
  });

  /** 任务总结(wrapup 卡):只读扫 ~/.claude/worklog,支持窗口/项目/状态/关键词过滤 */
  api.get('/worklog', async (c) => {
    const status = c.req.query('status');
    const cards = await queryWorklog({
      start: num(c.req.query('start')),
      end: num(c.req.query('end')),
      project: c.req.query('project')?.trim() || undefined,
      status: status && status !== 'all' ? (status as WorklogCard['status']) : undefined,
      q: c.req.query('q')?.trim() || undefined,
    });
    return c.json({ cards });
  });

  // ---------- 待办(自有数据) ----------

  api.get('/todos', async (c) => c.json({ todos: storage.listTodos() }));

  /**
   * 新建待办。project 宽松匹配(见 services/todos.resolveProject):
   * web 传绝对路径,Raycast 等外部脚本传手打短名,匹配不上就存「未指定」而不是报错。
   */
  api.post('/todos', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const invalid = validateTitle(body.title);
    if (invalid) return c.json(invalid, 400);
    const { cwd, project } = await resolveProject(
      typeof body.cwd === 'string' && body.cwd ? body.cwd : typeof body.project === 'string' ? body.project : null,
    );
    const todo = storage.createTodo({
      title: String(body.title).trim(),
      cwd,
      project,
      source: body.source === 'external' ? 'external' : 'web',
    });
    return c.json({ todo }, 201);
  });

  api.patch('/todos/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!storage.getTodo(id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) {
      const invalid = validateTitle(body.title);
      if (invalid) return c.json(invalid, 400);
      patch.title = String(body.title).trim();
    }
    if (body.status !== undefined) {
      if (!isTodoStatus(body.status)) return c.json({ error: 'status 需为 open/doing/done' }, 400);
      Object.assign(patch, statusPatch(body.status));
    }
    // cwd 显式传 null = 清空归属;传字符串走同一套宽松匹配
    if (body.cwd !== undefined || body.project !== undefined) {
      const { cwd, project } = await resolveProject(
        typeof body.cwd === 'string' ? body.cwd : typeof body.project === 'string' ? body.project : null,
      );
      patch.cwd = cwd;
      patch.project = project;
    }
    if (body.sessionId !== undefined) {
      patch.sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    }
    if (Object.keys(patch).length === 0) return c.json({ error: '没有可更新的字段' }, 400);
    storage.updateTodo(id, patch);
    return c.json({ todo: storage.getTodo(id) });
  });

  api.delete('/todos/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!storage.getTodo(id)) return c.json({ error: 'not found' }, 404);
    storage.deleteTodo(id);
    return c.json({ ok: true });
  });

  /** ?range=today|7d(非法值退回 today)。/usage/today 是既有路径,固定 today 口径 */
  const usageHandler = (fixed?: UsageRange) => async (c: Context) => {
    const q = c.req.query('range');
    const range: UsageRange = fixed ?? (isUsageRange(q) ? q : 'today');
    const board = await sessionsBoard(storage);
    return c.json(await usageReport(range, usageNameResolver(board, storage)));
  };
  api.get('/usage', usageHandler());
  api.get('/usage/today', usageHandler('today'));

  // ---------- M2 写操作与派发辅助 ----------

  /** 桌面壳外链兜底:Pake/Tauri 壳内 Tauri IPC 未注入时,target=_blank 的新窗口请求会被
   *  WKWebView 吞掉(点了没反应)。后端与壳同机,由后端 `open <url>` 唤起系统默认浏览器。
   *  仅放行 http/https;execFile 参数数组传参,无 shell 注入面。不触碰 ~/.claude,只读铁律不涉及。 */
  api.post('/open-url', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let url: URL;
    try {
      url = new URL(String(body.url ?? ''));
    } catch {
      return c.json({ error: 'url 非法' }, 400);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return c.json({ error: '仅允许 http/https 链接' }, 400);
    }
    try {
      await execFileP('open', [url.href], { timeout: 10_000 });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: `唤起系统浏览器失败: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  });

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

  /**
   * 手动归档(看板拖到「已完成」):自有覆盖表,~/.claude 不动。
   * 运行中/等待输入的会话拒绝——那是真实进行态,归档没有意义。
   */
  api.put('/sessions/:sessionId/archive', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return c.json({ error: 'bad sessionId' }, 400);
    const board = await sessionsBoard(storage);
    const found = (Object.keys(board.columns) as SessionState[])
      .flatMap((k) => board.columns[k])
      .find((s) => s.sessionId === sessionId);
    if (!found) return c.json({ error: '会话不在看板上' }, 404);
    if (found.state === 'running' || found.state === 'blocked') {
      return c.json({ error: '运行中/等待输入的会话不能归档' }, 409);
    }
    storage.archiveSession(sessionId, found.lastOutputAt);
    // 验收通过 = 归档:先跑清单里的 cleanup 项,再兜底停掉本会话名下仍活着的验收环境。
    // 放在这里而不是前端,是因为归档有多个入口(拖拽/按钮/快捷键),收尾必须在唯一的消费侧生效
    // ——与「角标 markSeen 写在消费侧」同一教训(memory: unread-badge-multi-entry-paths)。
    let cleaned: string[] = [];
    if (found.cwd) {
      try {
        cleaned = await resolveSessionCleanup(storage, sessionId, found.cwd);
      } catch (e) {
        console.warn(`[runbook] 归档收尾失败 ${sessionId}:`, e);
      }
    }
    return c.json({ ok: true, cleaned });
  });

  /** 撤销归档:卡片回归推导态(会话重新活跃时后端也会自动撤销) */
  api.delete('/sessions/:sessionId/archive', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return c.json({ error: 'bad sessionId' }, 400);
    storage.unarchiveSession(sessionId);
    return c.json({ ok: true });
  });

  /**
   * 挂起(验收中 →「挂起」):看过了、暂时不处理,卡片放回空闲停车场。
   * 与归档同样拒绝进行态——运行中/等待输入的会话没有「暂时不处理」这一说。
   */
  api.put('/sessions/:sessionId/suspend', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return c.json({ error: 'bad sessionId' }, 400);
    const board = await sessionsBoard(storage);
    const found = (Object.keys(board.columns) as SessionState[])
      .flatMap((k) => board.columns[k])
      .find((s) => s.sessionId === sessionId);
    if (!found) return c.json({ error: '会话不在看板上' }, 404);
    if (found.state === 'running' || found.state === 'blocked') {
      return c.json({ error: '运行中/等待输入的会话不能挂起' }, 409);
    }
    storage.suspendSession(sessionId, found.lastOutputAt);
    return c.json({ ok: true });
  });

  /** 撤销挂起:卡片回验收中(会话重新产出时后端也会自动撤销) */
  api.delete('/sessions/:sessionId/suspend', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return c.json({ error: 'bad sessionId' }, 400);
    storage.unsuspendSession(sessionId);
    return c.json({ ok: true });
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
      app: scheduler.list(),
      system,
      caliber: 'app 为璇玑应用内调度器(croner);system 来自 crontab -l 只读输出(过滤注释与空行),仅展示不接管',
    });
  });

  // ---------- 定时任务(M3) ----------

  const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

  function validateJobBody(body: Record<string, unknown>): { error: string } | null {
    if (body.kind !== 'once' && body.kind !== 'cron') return { error: 'kind 需为 once 或 cron' };
    if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'name 不能为空' };
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) return { error: 'prompt 不能为空' };
    if (typeof body.cwd !== 'string' || !body.cwd.trim()) return { error: 'cwd 不能为空' };
    if (body.permissionMode !== undefined && !PERMISSION_MODES.has(String(body.permissionMode))) {
      return { error: `permissionMode 需为 ${[...PERMISSION_MODES].join('/')}` };
    }
    if (body.kind === 'once' && !num(body.runAt)) return { error: 'once 任务需要 runAt(未来时间,epoch ms)' };
    if (body.kind === 'cron' && (typeof body.cronExpr !== 'string' || !body.cronExpr.trim())) {
      return { error: 'cron 任务需要 cronExpr' };
    }
    if (body.maxBudgetUsd !== undefined && body.maxBudgetUsd !== null && !num(body.maxBudgetUsd)) {
      return { error: 'maxBudgetUsd 需为正数或省略(不限)' };
    }
    return null;
  }

  api.get('/schedules', async (c) => c.json({ jobs: scheduler.list() }));

  api.post('/schedules', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const invalid = validateJobBody(body);
    if (invalid) return c.json(invalid, 400);
    try {
      const job = scheduler.create({
        kind: body.kind,
        name: String(body.name).trim(),
        prompt: String(body.prompt).trim(),
        cwd: String(body.cwd).trim(),
        model: typeof body.model === 'string' && body.model ? body.model : undefined,
        permissionMode: body.permissionMode ? String(body.permissionMode) : 'default',
        maxBudgetUsd: num(body.maxBudgetUsd),
        runAt: num(body.runAt),
        cronExpr: typeof body.cronExpr === 'string' ? body.cronExpr : undefined,
      });
      return c.json({ job }, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.get('/schedules/:id', async (c) => {
    const job = scheduler.get(c.req.param('id'));
    if (!job) return c.json({ error: 'not found' }, 404);
    return c.json({ job });
  });

  api.patch('/schedules/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.permissionMode !== undefined && !PERMISSION_MODES.has(String(body.permissionMode))) {
      return c.json({ error: `permissionMode 需为 ${[...PERMISSION_MODES].join('/')}` }, 400);
    }
    const patch: UpdateJobInput = {
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
      prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : undefined,
      cwd: typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined,
      model: body.model !== undefined ? (typeof body.model === 'string' && body.model ? body.model : null) : undefined,
      permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined,
      maxBudgetUsd: body.maxBudgetUsd !== undefined ? (num(body.maxBudgetUsd) ?? null) : undefined,
      runAt: body.runAt !== undefined ? (num(body.runAt) ?? null) : undefined,
      cronExpr: typeof body.cronExpr === 'string' ? body.cronExpr : undefined,
    };
    try {
      const job = scheduler.update(c.req.param('id'), patch);
      return c.json({ job });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete('/schedules/:id', async (c) => {
    if (!scheduler.get(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    scheduler.remove(c.req.param('id'));
    return c.json({ ok: true });
  });

  /** 运行历史:逐期一行,倒序;limit 默认 7(折叠态摘要),?limit=all 或大数字取完整历史(「查看全部」) */
  api.get('/schedules/:id/runs', async (c) => {
    if (!scheduler.get(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    const limitParam = c.req.query('limit');
    const limit = limitParam === 'all' ? 100_000 : (num(limitParam) ?? 7);
    return c.json(scheduler.runs(c.req.param('id'), limit));
  });

  api.post('/schedules/:id/run-now', async (c) => {
    if (!scheduler.runNow(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  api.post('/schedules/:id/pause', async (c) => {
    if (!scheduler.pause(c.req.param('id'))) return c.json({ error: '仅周期任务可暂停,或任务不存在' }, 400);
    return c.json({ ok: true });
  });

  api.post('/schedules/:id/resume', async (c) => {
    if (!scheduler.resume(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  /** 一次性任务取消(尚未触发时);周期任务用 /pause */
  api.post('/schedules/:id/cancel', async (c) => {
    if (!scheduler.cancel(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // ---------- 验收面板(Acceptance Runbook)----------

  /** 会话在看板上的记录:面板所有操作都要先拿到它的 cwd(清单文件与执行目录都由它定) */
  const findOnBoard = async (sessionId: string) => {
    const board = await sessionsBoard(storage);
    return (Object.keys(board.columns) as SessionState[])
      .flatMap((k) => board.columns[k])
      .find((s) => s.sessionId === sessionId);
  };

  /**
   * 某会话的验收面板数据。404 与「没有清单」是两回事:
   * 会话不在看板上才 404;有会话但没清单返回 {runbook:null},前端据此不渲染面板(退化路径)。
   */
  api.get('/sessions/:sessionId/runbook', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return c.json({ error: 'bad sessionId' }, 400);
    const found = await findOnBoard(sessionId);
    if (!found?.cwd) return c.json({ error: '会话不在看板上' }, 404);
    return c.json({ runbook: resolveRunbook(storage, sessionId, found.cwd) });
  });

  /** 执行预置 HTTP 请求。不走 WS:它是一问一答,没有流式输出 */
  api.post('/sessions/:sessionId/runbook/request', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return c.json({ error: 'bad sessionId' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { itemId?: string; confirmed?: boolean };
    const found = await findOnBoard(sessionId);
    if (!found?.cwd) return c.json({ error: '会话不在看板上' }, 404);
    const rb = resolveRunbook(storage, sessionId, found.cwd);
    const item = rb?.items.find((i) => i.id === body.itemId && i.type === 'request');
    if (!item) return c.json({ error: '请求项不存在' }, 404);
    const r = await runRequest(item, body.confirmed);
    return c.json(r, r.ok ? 200 : 400);
  });

  /** 仪表盘「运行中的验收环境」:跨会话列出仍活着的 service,防止攒僵尸进程占端口 */
  api.get('/runbook/live', (c) => c.json({ items: liveEnvironments() }));

  /** 项目级模板列表(?project=<真实路径>);不带 project 返回全部 */
  api.get('/runbook/templates', (c) => {
    const project = c.req.query('project');
    return c.json({ templates: storage.listRunbookTemplates(project || undefined) });
  });

  /**
   * 新建/更新模板。version 由后端递增而非调用方传:
   * 实例按 (id, version) 锁定引用,版本号是这套引用的锚,不能让调用方自己编。
   */
  api.put('/runbook/templates/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Partial<RunbookTemplate>;
    if (!body.project || !body.name || !Array.isArray(body.items)) {
      return c.json({ error: '需要 project / name / items' }, 400);
    }
    const prev = storage.getRunbookTemplate(id);
    const now = Date.now();
    const tpl: RunbookTemplate = {
      id,
      project: body.project,
      name: body.name,
      version: (prev?.version ?? 0) + 1,
      status: body.status ?? prev?.status ?? 'draft',
      source: body.source ?? prev?.source ?? 'user',
      items: (body.items as RunbookItem[]).map((i) => ({ ...i, origin: 'template' as const })),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    storage.upsertRunbookTemplate(tpl);
    return c.json({ ok: true, template: tpl });
  });

  api.delete('/runbook/templates/:id', (c) => {
    storage.deleteRunbookTemplate(c.req.param('id'));
    return c.json({ ok: true });
  });

  return api;
}
