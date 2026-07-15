/**
 * 自有存储:SQLite(better-sqlite3 + Drizzle)。
 * 铁律 2:只存自有数据与可重建索引;~/.claude 永远是 source of truth,不做双写。
 * M1 内容:meta 键值表(Drizzle)+ memory FTS5 全文索引(raw SQL,trigram 支持中文)。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import type { Memory, WeeklyDraft } from '../types.js';

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

  close() {
    this.sqlite.close();
  }
}

/** 把用户输入包成 FTS5 字符串字面量,避免被解析成查询语法 */
function escapeFtsQuery(q: string): string {
  return `"${q.replaceAll('"', '""')}"`;
}
