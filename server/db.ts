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

// 创建 analysis_jobs 表（视频分析任务）
db.exec(`
  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id                    TEXT PRIMARY KEY,
    status                TEXT NOT NULL DEFAULT 'queued',
    analysis_type         TEXT NOT NULL DEFAULT 'technique',
    video_path            TEXT,
    video_filename        TEXT,
    video_size            INTEGER,
    video_duration        INTEGER,
    mime_type             TEXT,
    report                TEXT,
    report_schema_version TEXT DEFAULT 'v1',
    error                 TEXT,
    model                 TEXT,
    gemini_file_name      TEXT,
    attempt_count         INTEGER DEFAULT 0,
    created_at            TEXT NOT NULL,
    started_at            TEXT,
    completed_at          TEXT
  );
`);

console.log(`[DB] SQLite database ready at ${DB_PATH} (WAL mode)`);

export default db;
