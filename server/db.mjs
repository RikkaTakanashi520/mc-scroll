/**
 * 数据库打开与初始化。
 * 使用 Node 内置 node:sqlite（Node 22+，当前环境实测可用），零第三方依赖。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, SEED_SOURCES } from './schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '..', 'data');
export const DB_PATH = path.join(DATA_DIR, 'mc.db');

let _db = null;

export function openDb(dbPath = DB_PATH) {
  if (_db) return _db;
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const insert = db.prepare(
    `INSERT INTO sources (key, display_name, base_url) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET display_name=excluded.display_name, base_url=excluded.base_url`,
  );
  for (const s of SEED_SOURCES) insert.run(s.key, s.display_name, s.base_url);

  _db = db;
  return db;
}

/** 事务包装：better-sqlite3 风格，这里手写 BEGIN/COMMIT */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

/** 读一个抓取检查点 */
export function getCheckpoint(db, key) {
  const row = db.prepare('SELECT value FROM crawl_checkpoints WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setCheckpoint(db, key, value) {
  db.prepare(
    `INSERT INTO crawl_checkpoints (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
  ).run(key, String(value));
}

/** 统计概览，抓取完和 API 健康检查都用 */
export function stats(db) {
  const one = (sql) => db.prepare(sql).get()?.n ?? 0;
  return {
    projects: one('SELECT COUNT(*) n FROM projects'),
    byType: db
      .prepare('SELECT project_type, COUNT(*) n FROM projects GROUP BY project_type ORDER BY n DESC')
      .all(),
    images: one('SELECT COUNT(*) n FROM project_images'),
    categories: one('SELECT COUNT(*) n FROM taxonomy_categories'),
    loaders: one('SELECT COUNT(*) n FROM taxonomy_loaders'),
    gameVersions: one('SELECT COUNT(*) n FROM taxonomy_game_versions'),
    sources: db.prepare('SELECT key, display_name, synced_at FROM sources').all(),
    dbSizeBytes: one('PRAGMA page_count') * one('PRAGMA page_size'),
  };
}
