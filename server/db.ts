import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { migrateAnalysisJobs, migrateAnalysisJobsOwner, repairFilenameEncoding } from './dbMigrations';
import { migrateAuthTables } from './auth/schema';

const DB_PATH = path.join(__dirname, 'data', 'topstar.db');

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
    gemini_file_name      TEXT,   -- 已废弃：仅保留历史数据，新任务写 provider + file_ref
    provider              TEXT,   -- 视频托管实现名（gemini_files / 后续 aliyun_oss）
    file_ref              TEXT,   -- 托管侧文件标识
    trace                 TEXT,   -- JSON：各环节原始输出 / 模型 / 耗时 / token 用量（见 videoAnalysis/pipeline.ts）
    attempt_count         INTEGER DEFAULT 0,
    created_at            TEXT NOT NULL,
    started_at            TEXT,
    completed_at          TEXT
  );
`);

// 旧库补列并回填历史数据（幂等）
const migration = migrateAnalysisJobs(db);
if (migration.added.length > 0 || migration.backfilled > 0) {
  console.log(`[DB] analysis_jobs migrated: added=[${migration.added.join(',')}] backfilled=${migration.backfilled}`);
}

// 账号体系：用户 / 验证码 / 会话表，以及任务归属列（幂等）
migrateAuthTables(db);
if (migrateAnalysisJobsOwner(db)) {
  console.log('[DB] analysis_jobs migrated: added=[user_id]（历史任务没有归属，任何账号都读不到）');
}

// 修复历史上被误读为 latin1 的中文文件名（幂等）
const repairedNames = repairFilenameEncoding(db);
if (repairedNames > 0) {
  console.log(`[DB] analysis_jobs.video_filename: repaired ${repairedNames} garbled filename(s)`);
}

console.log(`[DB] SQLite database ready at ${DB_PATH} (WAL mode)`);

export default db;
