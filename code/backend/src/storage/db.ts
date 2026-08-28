/**
 * 自有存储:SQLite(better-sqlite3 + Drizzle)。
 * 铁律 2:只存自有数据与可重建索引;~/.claude 永远是 source of truth,不做双写。
 * M1 内容:meta 键值表(Drizzle)+ memory FTS5 全文索引(raw SQL,trigram 支持中文)。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { desc, eq } from 'drizzle-orm';
import type { Memory, RunbookRun, RunbookTemplate, ScheduledJob, ScheduledRun, Todo, WeeklyDraft } from '../types.js';

export const metaTable = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** 璇玑派发的会话(自有数据):支撑所有权规则「web 只 resume 自己派发的」与来源标签 */
export const dispatchesTable = sqliteTable('dispatches', {
  sessionId: text('session_id').primaryKey(),
  cwd: text('cwd').notNull(),
  createdAt: integer('created_at').notNull(),
  name: text('name'),
  /** 会话死亡前的最后状态:重启后据此还原看板(idle/working/awaiting-permission → 空闲可续接;ended → 已完成) */
  lastState: text('last_state'),
  /** 最近产出时间:「待验收」标记跨重启保留 */
  lastOutputAt: integer('last_output_at'),
  /** 最近活动摘要:跨重启保留卡片 detail */
  activity: text('activity'),
});

/** web 会话重命名的 display-name 覆盖(仅璇玑界面生效,不写 ~/.claude 元数据) */
export const sessionNamesTable = sqliteTable('session_names', {
  sessionId: text('session_id').primaryKey(),
  name: text('name').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** 看板「关闭」的隐藏列表(自有数据,可逆):~/.claude 不动,只是不再展示 */
export const hiddenSessionsTable = sqliteTable('hidden_sessions', {
  sessionId: text('session_id').primaryKey(),
  hiddenAt: integer('hidden_at').notNull(),
});

/**
 * 手动归档:用户把卡片拖到「已完成」列的覆盖表(自有数据,可逆)。
 * 记下归档瞬间的 lastOutputAt,之后会话一旦重新活跃(推导态转 running/blocked,
 * 或产出时间前进)即自动失效——归档是人工判断,不该盖住真实进展。
 */
export const sessionArchivesTable = sqliteTable('session_archives', {
  sessionId: text('session_id').primaryKey(),
  archivedAt: integer('archived_at').notNull(),
  /** 归档时该会话的最近产出时间;无产出记为 0 */
  markedLastOutputAt: integer('marked_last_output_at').notNull(),
});

/**
 * 显式挂起:用户在「验收中」点「挂起」= 看过了、暂时不处理,把卡放回空闲停车场。
 * 与归档同构——记下挂起瞬间的 lastOutputAt,会话一旦重新产出即自动失效回到验收中,
 * 免得挂起变成「永久静音」把新产出也一起埋掉。
 */
export const sessionSuspendsTable = sqliteTable('session_suspends', {
  sessionId: text('session_id').primaryKey(),
  suspendedAt: integer('suspended_at').notNull(),
  /** 挂起时该会话的最近产出时间;无产出记为 0 */
  markedLastOutputAt: integer('marked_last_output_at').notNull(),
});

/** 项目分类色调色板:首次出现顺序分配序号并固定(前 N 个项目互不撞色,全端一致) */
export const paletteTable = sqliteTable('palette', {
  name: text('name').primaryKey(),
  idx: integer('idx').notNull(),
});

/** web 派发的 prompt 流水:SDK 会话不写 ~/.claude/history.jsonl,时间线/统计由此补全 */
export const dispatchPromptsTable = sqliteTable('dispatch_prompts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id'),
  cwd: text('cwd').notNull(),
  display: text('display').notNull(),
  at: integer('at').notNull(),
});

/** 定时任务定义(自有数据,M3):一次性 + 周期统一模型,到点由 SchedulerService 触发真实派发会话 */
export const scheduledJobsTable = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // once | cron
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  cwd: text('cwd').notNull(),
  model: text('model'),
  permissionMode: text('permission_mode').notNull(),
  maxBudgetUsd: real('max_budget_usd'),
  runAt: integer('run_at'),
  cronExpr: text('cron_expr'),
  status: text('status').notNull(),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  resultSessionId: text('result_session_id'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  nextRunAt: integer('next_run_at'),
});

/** 定时任务运行历史(自有数据,M3):每次触发一行,周期任务逐期累积 */
export const scheduledRunsTable = sqliteTable('scheduled_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: text('job_id').notNull(),
  scheduledFor: integer('scheduled_for').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  status: text('status').notNull(), // running | done | error | blocked | missed
  sessionId: text('session_id'),
  costUsd: real('cost_usd'),
  durationMs: integer('duration_ms'),
  error: text('error'),
});

/** 周报草稿(自有数据):周回顾视图的产物,生成会话可在看板跟踪/续接 */
export const weeklyDraftsTable = sqliteTable('weekly_drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  rangeStart: integer('range_start').notNull(),
  rangeEnd: integer('range_end').notNull(),
  status: text('status').notNull(), // running | done | error
  content: text('content'),
  error: text('error'),
  model: text('model').notNull(),
  sessionId: text('session_id'),
  createdAt: integer('created_at').notNull(),
  finishedAt: integer('finished_at'),
});

/**
 * 待办(自有数据):临时想法收集箱。与 ~/.claude 无任何映射关系,纯璇玑自有,
 * 因此可以放心写——不违反只读铁律(铁律约束的是他人格式的文件)。
 */
export const todosTable = sqliteTable('todos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  cwd: text('cwd'),
  project: text('project'),
  status: text('status').notNull(), // open | doing | done
  sessionId: text('session_id'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  doneAt: integer('done_at'),
  source: text('source').notNull(), // web | external
});

/**
 * 项目级验收模板(自有数据):验收骨架一次沉淀长期复用。
 * items 存 JSON 串——清单项是嵌套结构且只整体读写,拆表徒增 join 无收益。
 * 版本号只增不改:实例按 (id, version) 锁定引用,模板后续编辑不回溯已交付的清单。
 */
export const runbookTemplatesTable = sqliteTable('runbook_templates', {
  id: text('id').primaryKey(),
  project: text('project').notNull(),
  name: text('name').notNull(),
  version: integer('version').notNull(),
  status: text('status').notNull(), // draft | active | archived
  source: text('source').notNull(), // user | agent
  items: text('items').notNull(), // JSON: RunbookItem[]
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** 验收面板每次执行的运行态(自有数据):谁、跑了哪条插值后的命令、结果如何 */
export const runbookRunsTable = sqliteTable('runbook_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  itemId: text('item_id').notNull(),
  /** 插值后的完整命令:审计与「用户点的到底是什么」的唯一事实 */
  resolvedCommand: text('resolved_command').notNull(),
  status: text('status').notNull(), // running | ready | ok | exited | failed | stopped
  pid: integer('pid'),
  exitCode: integer('exit_code'),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  logPath: text('log_path'),
});

export class Storage {
  private sqlite: Database.Database;
  private orm: ReturnType<typeof drizzle>;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.sqlite = new Database(path.join(dataDir, 'xuanji.db'));
    this.sqlite.pragma('journal_mode = WAL');
    this.orm = drizzle(this.sqlite);
    this.migrate();
  }

  private migrate() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatches (
        session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_names (
        session_id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hidden_sessions (
        session_id TEXT PRIMARY KEY, hidden_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_archives (
        session_id TEXT PRIMARY KEY, archived_at INTEGER NOT NULL,
        marked_last_output_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_suspends (
        session_id TEXT PRIMARY KEY, suspended_at INTEGER NOT NULL,
        marked_last_output_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS palette (
        name TEXT PRIMARY KEY, idx INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatch_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT, cwd TEXT NOT NULL, display TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS weekly_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        range_start INTEGER NOT NULL, range_end INTEGER NOT NULL,
        status TEXT NOT NULL, content TEXT, error TEXT,
        model TEXT NOT NULL, session_id TEXT,
        created_at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
        cwd TEXT NOT NULL, model TEXT, permission_mode TEXT NOT NULL, max_budget_usd REAL,
        run_at INTEGER, cron_expr TEXT, status TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        result_session_id TEXT, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_run_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS scheduled_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        status TEXT NOT NULL, session_id TEXT, cost_usd REAL, duration_ms INTEGER, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_runs_job ON scheduled_runs(job_id, id DESC);
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, cwd TEXT, project TEXT,
        status TEXT NOT NULL, session_id TEXT,
        created_at INTEGER NOT NULL, started_at INTEGER, done_at INTEGER,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status, id DESC);
      CREATE TABLE IF NOT EXISTS runbook_templates (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
        version INTEGER NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
        items TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runbook_templates_project ON runbook_templates(project);
      CREATE TABLE IF NOT EXISTS runbook_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, item_id TEXT NOT NULL,
        resolved_command TEXT NOT NULL, status TEXT NOT NULL,
        pid INTEGER, exit_code INTEGER,
        started_at INTEGER NOT NULL, ended_at INTEGER, log_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runbook_runs_session ON runbook_runs(session_id, id DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        name, description, body, project, type UNINDEXED, file UNINDEXED,
        tokenize = 'trigram'
      );
    `);
    for (const ddl of [
      'ALTER TABLE dispatches ADD COLUMN name TEXT',
      'ALTER TABLE dispatches ADD COLUMN last_state TEXT',
      'ALTER TABLE dispatches ADD COLUMN last_output_at INTEGER',
      'ALTER TABLE dispatches ADD COLUMN activity TEXT',
    ]) {
      try {
        this.sqlite.exec(ddl);
      } catch {
        /* 列已存在 */
      }
    }
  }

  recordDispatch(sessionId: string, cwd: string, name?: string) {
    this.orm
      .insert(dispatchesTable)
      .values({ sessionId, cwd, createdAt: Date.now(), name: name ?? null })
      .onConflictDoNothing()
      .run();
  }

  /**
   * 派发会话的起始时刻(ms);非 web 派发的会话返回 null。
   * onConflictDoNothing 保证它是「这条会话第一次出现」的时刻,后端重启/接回都不会刷新,
   * 因此可以拿来判定验收清单是不是本次交付写的。
   */
  dispatchStartedAt(sessionId: string): number | null {
    const row = this.sqlite
      .prepare('SELECT created_at as createdAt FROM dispatches WHERE session_id = ?')
      .get(sessionId) as { createdAt: number } | undefined;
    return row?.createdAt ?? null;
  }

  /** 全部 web 派发记录:进程/CLI 都不再知道的历史 web 会话由此回到看板 */
  allDispatches(): {
    sessionId: string;
    cwd: string;
    createdAt: number;
    name: string | null;
    lastState: string | null;
    lastOutputAt: number | null;
    activity: string | null;
  }[] {
    return this.orm.select().from(dispatchesTable).all();
  }

  recordPrompt(cwd: string, display: string, sessionId?: string) {
    this.orm
      .insert(dispatchPromptsTable)
      .values({ cwd, display: display.slice(0, 200), sessionId: sessionId ?? null, at: Date.now() })
      .run();
  }

  recentPrompts(sinceMs: number): { sessionId: string | null; cwd: string; display: string; at: number }[] {
    return this.sqlite
      .prepare('SELECT session_id as sessionId, cwd, display, at FROM dispatch_prompts WHERE at >= ? ORDER BY at ASC')
      .all(sinceMs) as { sessionId: string | null; cwd: string; display: string; at: number }[];
  }

  /** 会话状态快照(每次状态/产出变化时写入):重启后看板据此如实还原 */
  updateDispatchState(sessionId: string, lastState: string, lastOutputAt?: number, activity?: string) {
    this.orm
      .update(dispatchesTable)
      .set({ lastState, lastOutputAt: lastOutputAt ?? null, activity: activity ?? null })
      .where(eq(dispatchesTable.sessionId, sessionId))
      .run();
  }

  isWebDispatched(sessionId: string): boolean {
    return !!this.orm
      .select()
      .from(dispatchesTable)
      .where(eq(dispatchesTable.sessionId, sessionId))
      .get();
  }

  setSessionName(sessionId: string, name: string) {
    this.orm
      .insert(sessionNamesTable)
      .values({ sessionId, name, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: sessionNamesTable.sessionId, set: { name, updatedAt: Date.now() } })
      .run();
  }

  /** sessionId → display-name 覆盖表 */
  sessionNames(): Map<string, string> {
    const rows = this.orm.select().from(sessionNamesTable).all();
    return new Map(rows.map((r) => [r.sessionId, r.name]));
  }

  webDispatchedIds(): Set<string> {
    const rows = this.orm.select().from(dispatchesTable).all();
    return new Set(rows.map((r) => r.sessionId));
  }

  hideSession(sessionId: string) {
    this.orm
      .insert(hiddenSessionsTable)
      .values({ sessionId, hiddenAt: Date.now() })
      .onConflictDoNothing()
      .run();
  }

  hiddenSessionIds(): Set<string> {
    const rows = this.orm.select().from(hiddenSessionsTable).all();
    return new Set(rows.map((r) => r.sessionId));
  }

  /** hide 的逆操作:从隐藏列表移除,卡片回看板(/resume 恢复已关闭会话) */
  unhideSession(sessionId: string) {
    this.orm.delete(hiddenSessionsTable).where(eq(hiddenSessionsTable.sessionId, sessionId)).run();
  }

  /** 隐藏(已关闭)会话完整行:/resume 弹窗数据源 */
  hiddenSessions(): { sessionId: string; hiddenAt: number }[] {
    return this.orm.select().from(hiddenSessionsTable).all();
  }

  /** 手动归档(拖到「已完成」):记下当时的最近产出时间,作为日后自动失效的基准 */
  archiveSession(sessionId: string, lastOutputAt?: number) {
    const marked = lastOutputAt ?? 0;
    this.orm
      .insert(sessionArchivesTable)
      .values({ sessionId, archivedAt: Date.now(), markedLastOutputAt: marked })
      .onConflictDoUpdate({
        target: sessionArchivesTable.sessionId,
        set: { archivedAt: Date.now(), markedLastOutputAt: marked },
      })
      .run();
  }

  /** sessionId → 归档基准(archivedAt / 归档时的 lastOutputAt) */
  sessionArchives(): Map<string, { archivedAt: number; markedLastOutputAt: number }> {
    const rows = this.orm.select().from(sessionArchivesTable).all();
    return new Map(
      rows.map((r) => [r.sessionId, { archivedAt: r.archivedAt, markedLastOutputAt: r.markedLastOutputAt }]),
    );
  }

  /** 撤销归档:手动撤销与「会话重新活跃」的自动失效共用此入口 */
  unarchiveSession(sessionId: string) {
    this.orm.delete(sessionArchivesTable).where(eq(sessionArchivesTable.sessionId, sessionId)).run();
  }

  /** 显式挂起(验收中 →「挂起」):与归档同构,记下当时的最近产出时间作为失效基准 */
  suspendSession(sessionId: string, lastOutputAt?: number) {
    const marked = lastOutputAt ?? 0;
    this.orm
      .insert(sessionSuspendsTable)
      .values({ sessionId, suspendedAt: Date.now(), markedLastOutputAt: marked })
      .onConflictDoUpdate({
        target: sessionSuspendsTable.sessionId,
        set: { suspendedAt: Date.now(), markedLastOutputAt: marked },
      })
      .run();
  }

  /** sessionId → 挂起基准(suspendedAt / 挂起时的 lastOutputAt) */
  sessionSuspends(): Map<string, { suspendedAt: number; markedLastOutputAt: number }> {
    const rows = this.orm.select().from(sessionSuspendsTable).all();
    return new Map(
      rows.map((r) => [r.sessionId, { suspendedAt: r.suspendedAt, markedLastOutputAt: r.markedLastOutputAt }]),
    );
  }

  /** 撤销挂起:手动复位与「会话重新产出」的自动失效共用此入口 */
  unsuspendSession(sessionId: string) {
    this.orm.delete(sessionSuspendsTable).where(eq(sessionSuspendsTable.sessionId, sessionId)).run();
  }

  /**
   * 「验收中」启用基线:首次调用即钉住当前时刻并持久化。
   * 只有产出时间晚于基线的会话才会被收进验收中——否则功能一上线,
   * 历史上几十个早就了结的空闲/已完成会话会集体涌入,验收列当场失去意义。
   */
  reviewBaseline(): number {
    const cached = this.getMeta('review_baseline_at');
    if (cached) return Number(cached);
    const now = Date.now();
    this.setMeta('review_baseline_at', String(now));
    return now;
  }

  /** 调色板:已有的保持不变,新名字按当前最大序号顺延(首次出现即永久固定) */
  assignPalette(names: string[]): Map<string, number> {
    const rows = this.orm.select().from(paletteTable).all();
    const map = new Map(rows.map((r) => [r.name, r.idx]));
    let next = rows.length ? Math.max(...rows.map((r) => r.idx)) + 1 : 0;
    const insert = this.sqlite.prepare('INSERT OR IGNORE INTO palette (name, idx) VALUES (?, ?)');
    for (const n of names) {
      if (!n || map.has(n)) continue;
      insert.run(n, next);
      map.set(n, next);
      next++;
    }
    return map;
  }

  // ---------- 周报草稿 ----------

  createDraft(rangeStart: number, rangeEnd: number, model: string): number {
    const r = this.orm
      .insert(weeklyDraftsTable)
      .values({ rangeStart, rangeEnd, status: 'running', model, createdAt: Date.now() })
      .run();
    return Number(r.lastInsertRowid);
  }

  updateDraft(
    id: number,
    patch: Partial<{ status: string; content: string; error: string; sessionId: string; finishedAt: number }>,
  ) {
    this.orm.update(weeklyDraftsTable).set(patch).where(eq(weeklyDraftsTable.id, id)).run();
  }

  getDraft(id: number): WeeklyDraft | null {
    return (this.orm.select().from(weeklyDraftsTable).where(eq(weeklyDraftsTable.id, id)).get() as WeeklyDraft | undefined) ?? null;
  }

  /** 最近草稿(倒序),前端按窗口自行过滤 */
  listDrafts(limit = 20): WeeklyDraft[] {
    return this.sqlite
      .prepare(
        `SELECT id, range_start as rangeStart, range_end as rangeEnd, status, content, error,
                model, session_id as sessionId, created_at as createdAt, finished_at as finishedAt
         FROM weekly_drafts ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as WeeklyDraft[];
  }

  // ---------- 待办 ----------

  createTodo(input: { title: string; cwd?: string | null; project?: string | null; source: Todo['source'] }): Todo {
    const r = this.orm
      .insert(todosTable)
      .values({
        title: input.title,
        cwd: input.cwd ?? null,
        project: input.project ?? null,
        status: 'open',
        createdAt: Date.now(),
        source: input.source,
      })
      .run();
    return this.getTodo(Number(r.lastInsertRowid))!;
  }

  getTodo(id: number): Todo | null {
    return (this.orm.select().from(todosTable).where(eq(todosTable.id, id)).get() as Todo | undefined) ?? null;
  }

  /** 全部待办,新建的在前;过滤/分组交给前端(总量是几十到几百条量级) */
  listTodos(): Todo[] {
    return this.orm.select().from(todosTable).orderBy(desc(todosTable.id)).all() as Todo[];
  }

  updateTodo(id: number, patch: Partial<Omit<Todo, 'id' | 'createdAt'>>) {
    this.orm.update(todosTable).set(patch).where(eq(todosTable.id, id)).run();
  }

  deleteTodo(id: number) {
    this.orm.delete(todosTable).where(eq(todosTable.id, id)).run();
  }

  getMeta(key: string): string | null {
    const row = this.orm.select().from(metaTable).where(eq(metaTable.key, key)).get();
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.orm
      .insert(metaTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: metaTable.key, set: { value } })
      .run();
  }

  /** 全量重建 memory 索引(索引可随时重建,不做增量同步) */
  rebuildMemoryIndex(memories: Memory[]) {
    const insert = this.sqlite.prepare(
      'INSERT INTO memory_fts (name, description, body, project, type, file) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this.sqlite.transaction((rows: Memory[]) => {
      this.sqlite.exec('DELETE FROM memory_fts');
      for (const m of rows) insert.run(m.name, m.description, m.body, m.project, m.type, m.file);
    });
    tx(memories);
    this.setMeta('memory_index_at', String(Date.now()));
  }

  /** FTS5 搜索,返回命中 memory 的 file 路径(按相关度排序) */
  searchMemories(query: string, limit = 50): string[] {
    const q = query.trim();
    if (q.length < 3) return []; // trigram 分词最短 3 字符,更短的查询由服务层朴素匹配兜底
    try {
      const rows = this.sqlite
        .prepare('SELECT file FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?')
        .all(escapeFtsQuery(q), limit) as { file: string }[];
      return rows.map((r) => r.file);
    } catch {
      return [];
    }
  }

  // ---------- 定时任务(M3) ----------

  createScheduledJob(job: Omit<ScheduledJob, 'createdAt' | 'updatedAt'>) {
    const now = Date.now();
    this.orm
      .insert(scheduledJobsTable)
      .values({ ...job, createdAt: now, updatedAt: now })
      .run();
  }

  updateScheduledJob(id: string, patch: Partial<Omit<ScheduledJob, 'id' | 'createdAt'>>) {
    this.orm
      .update(scheduledJobsTable)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(scheduledJobsTable.id, id))
      .run();
  }

  getScheduledJob(id: string): ScheduledJob | null {
    return (this.orm.select().from(scheduledJobsTable).where(eq(scheduledJobsTable.id, id)).get() as ScheduledJob | undefined) ?? null;
  }

  /** 全部任务,创建时间倒序(新建的排前面) */
  listScheduledJobs(): ScheduledJob[] {
    return this.orm.select().from(scheduledJobsTable).orderBy(desc(scheduledJobsTable.createdAt)).all() as ScheduledJob[];
  }

  deleteScheduledJob(id: string) {
    this.orm.delete(scheduledJobsTable).where(eq(scheduledJobsTable.id, id)).run();
    this.sqlite.prepare('DELETE FROM scheduled_runs WHERE job_id = ?').run(id);
  }

  createScheduledRun(run: Omit<ScheduledRun, 'id'>): number {
    const r = this.orm.insert(scheduledRunsTable).values(run).run();
    return Number(r.lastInsertRowid);
  }

  updateScheduledRun(id: number, patch: Partial<Omit<ScheduledRun, 'id' | 'jobId'>>) {
    this.orm.update(scheduledRunsTable).set(patch).where(eq(scheduledRunsTable.id, id)).run();
  }

  /** 某任务的运行历史,倒序(最新在前);limit 封顶,「查看全部」由更大 limit 的同一接口满足 */
  listScheduledRuns(jobId: string, limit = 50): ScheduledRun[] {
    return this.sqlite
      .prepare(
        `SELECT id, job_id as jobId, scheduled_for as scheduledFor, started_at as startedAt, finished_at as finishedAt,
                status, session_id as sessionId, cost_usd as costUsd, duration_ms as durationMs, error
         FROM scheduled_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(jobId, limit) as ScheduledRun[];
  }

  countScheduledRuns(jobId: string): number {
    const row = this.sqlite.prepare('SELECT COUNT(*) as n FROM scheduled_runs WHERE job_id = ?').get(jobId) as { n: number };
    return row.n;
  }

  // ---------- 验收面板:模板 ----------

  /** 某项目下的模板。draft 不参与实例引用,但要在管理界面看得到,故一并返回 */
  listRunbookTemplates(project?: string): RunbookTemplate[] {
    const rows = project
      ? this.sqlite.prepare('SELECT * FROM runbook_templates WHERE project = ? ORDER BY updated_at DESC').all(project)
      : this.sqlite.prepare('SELECT * FROM runbook_templates ORDER BY updated_at DESC').all();
    return (rows as Record<string, unknown>[]).map(rowToTemplate);
  }

  getRunbookTemplate(id: string): RunbookTemplate | null {
    const row = this.sqlite.prepare('SELECT * FROM runbook_templates WHERE id = ?').get(id);
    return row ? rowToTemplate(row as Record<string, unknown>) : null;
  }

  upsertRunbookTemplate(t: RunbookTemplate) {
    this.sqlite
      .prepare(
        `INSERT INTO runbook_templates (id, project, name, version, status, source, items, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project=excluded.project, name=excluded.name, version=excluded.version,
           status=excluded.status, source=excluded.source, items=excluded.items,
           updated_at=excluded.updated_at`,
      )
      .run(t.id, t.project, t.name, t.version, t.status, t.source, JSON.stringify(t.items), t.createdAt, t.updatedAt);
  }

  deleteRunbookTemplate(id: string) {
    this.sqlite.prepare('DELETE FROM runbook_templates WHERE id = ?').run(id);
  }

  // ---------- 验收面板:运行态 ----------

  createRunbookRun(run: Omit<RunbookRun, 'id'>): number {
    const r = this.orm.insert(runbookRunsTable).values(run).run();
    return Number(r.lastInsertRowid);
  }

  updateRunbookRun(id: number, patch: Partial<Omit<RunbookRun, 'id' | 'sessionId' | 'itemId'>>) {
    this.orm.update(runbookRunsTable).set(patch).where(eq(runbookRunsTable.id, id)).run();
  }

  /** 某会话每个 item 的最近一次运行(面板状态灯的数据源) */
  latestRunbookRuns(sessionId: string): RunbookRun[] {
    return this.sqlite
      .prepare(
        `SELECT id, session_id as sessionId, item_id as itemId, resolved_command as resolvedCommand,
                status, pid, exit_code as exitCode, started_at as startedAt, ended_at as endedAt, log_path as logPath
         FROM runbook_runs
         WHERE id IN (SELECT MAX(id) FROM runbook_runs WHERE session_id = ? GROUP BY item_id)
         ORDER BY id DESC`,
      )
      .all(sessionId) as RunbookRun[];
  }

  /** 全局仍在跑的 service 进程:仪表盘「运行中的验收环境」与重启后收养的数据源 */
  liveRunbookRuns(): RunbookRun[] {
    return this.sqlite
      .prepare(
        `SELECT id, session_id as sessionId, item_id as itemId, resolved_command as resolvedCommand,
                status, pid, exit_code as exitCode, started_at as startedAt, ended_at as endedAt, log_path as logPath
         FROM runbook_runs WHERE status IN ('running','ready') ORDER BY id DESC`,
      )
      .all() as RunbookRun[];
  }

  close() {
    this.sqlite.close();
  }
}

/** DB 行 → 模板领域对象;items 是 JSON 串,解析失败降级为空清单而不是抛 */
function rowToTemplate(row: Record<string, unknown>): RunbookTemplate {
  let items: RunbookTemplate['items'] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.items ?? '[]'));
    if (Array.isArray(parsed)) items = parsed as RunbookTemplate['items'];
  } catch {
    /* 坏数据不该让整个面板挂掉 */
  }
  return {
    id: String(row.id),
    project: String(row.project),
    name: String(row.name),
    version: Number(row.version),
    status: row.status as RunbookTemplate['status'],
    source: row.source as RunbookTemplate['source'],
    items,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 把用户输入包成 FTS5 字符串字面量,避免被解析成查询语法 */
function escapeFtsQuery(q: string): string {
  return `"${q.replaceAll('"', '""')}"`;
}
