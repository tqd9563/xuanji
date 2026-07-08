/**
 * 自有存储:SQLite(better-sqlite3 + Drizzle)。
 * 铁律 2:只存自有数据与可重建索引;~/.claude 永远是 source of truth,不做双写。
 * M1 内容:meta 键值表(Drizzle)+ memory FTS5 全文索引(raw SQL,trigram 支持中文)。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import type { Memory } from '../types.js';

export const metaTable = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
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
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        name, description, body, project, type UNINDEXED, file UNINDEXED,
        tokenize = 'trigram'
      );
    `);
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
