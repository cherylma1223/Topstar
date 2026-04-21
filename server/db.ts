import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, 'topstar.db');

const db: DatabaseType = new Database(DB_PATH);

// WAL 模式：允许并发读，写仍串行
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 3000');

// 创建 tutorial_videos 表
db.exec(`
  CREATE TABLE IF NOT EXISTS tutorial_videos (
    tutorial_id         TEXT PRIMARY KEY,
    platform            TEXT NOT NULL,
    platform_item_id    TEXT NOT NULL,
    title               TEXT,
    url                 TEXT NOT NULL,
    author              TEXT,
    source_folder_titles TEXT,  -- JSON array
    tags                TEXT,  -- JSON array
    related_action_ids  TEXT,  -- JSON array
    related_tactic_ids  TEXT,  -- JSON array
    quality_score       REAL DEFAULT 0,
    score_source        TEXT,
    status              TEXT DEFAULT 'active',
    last_verified_at    TEXT,
    last_checked_at     TEXT,
    consecutive_failures INTEGER DEFAULT 0,
    failure_reported_by_user INTEGER DEFAULT 0,
    click_count         INTEGER DEFAULT 0,
    impression_count    INTEGER DEFAULT 0,
    duration            INTEGER,
    description         TEXT
  );
`);

console.log(`[DB] SQLite database ready at ${DB_PATH} (WAL mode)`);

export default db;
