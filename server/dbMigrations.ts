/**
 * 轻量数据库迁移（SQLite）
 *
 * 项目没有迁移框架，这里只做「幂等、只增不删」的加列和回填，每次启动都会执行。
 * 旧列保留不删，保证切回旧代码（如 main）时数据库仍然可用。
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import { fixMultipartFilename } from './utils/filename';

function hasColumn(db: DatabaseType, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some(c => c.name === column);
}

export interface MigrationResult {
  /** 本次新增的列 */
  added: string[];
  /** 本次回填的历史记录数 */
  backfilled: number;
}

/**
 * analysis_jobs：把 Gemini 专用的 `gemini_file_name` 泛化为 `provider` + `file_ref`，并新增 `trace`
 *
 * - provider：视频托管实现的名称（VideoStorage.name，如 gemini_files / 后续的 aliyun_oss）
 * - file_ref：托管侧的文件标识（Gemini 为 files/xxx；OSS 为 object key）
 * - gemini_file_name：已废弃，只保留历史数据，新任务不再写入
 * - trace：JSON，各环节（Pass 1 / 1.5 / 2）的原始输出、命中的模型、耗时、token 用量和 Schema 校验问题，
 *   成功和失败的任务都会写入；此前 Pass 1.5 的结果只存在于日志里。历史任务该列为空
 */
export function migrateAnalysisJobs(db: DatabaseType): MigrationResult {
  const added: string[] = [];

  for (const column of ['provider', 'file_ref', 'trace']) {
    if (!hasColumn(db, 'analysis_jobs', column)) {
      db.exec(`ALTER TABLE analysis_jobs ADD COLUMN ${column} TEXT`);
      added.push(column);
    }
  }

  const result = db.prepare(
    `UPDATE analysis_jobs
        SET provider = 'gemini_files', file_ref = gemini_file_name
      WHERE provider IS NULL AND gemini_file_name IS NOT NULL`
  ).run();

  return { added, backfilled: result.changes };
}

/**
 * analysis_jobs.video_filename：修复历史上被 multer 按 latin1 误读的中文文件名
 *
 * 只改写「确认是 latin1 误读的 UTF-8」的记录（规则见 fixMultipartFilename），
 * 幂等：修复后的名字含 CJK 字符，再次执行不会改变。返回本次修复的记录数。
 */
export function repairFilenameEncoding(db: DatabaseType): number {
  const rows = db.prepare(
    `SELECT id, video_filename FROM analysis_jobs WHERE video_filename IS NOT NULL`
  ).all() as { id: string; video_filename: string }[];

  const update = db.prepare(`UPDATE analysis_jobs SET video_filename = ? WHERE id = ?`);
  let repaired = 0;
  for (const row of rows) {
    const fixed = fixMultipartFilename(row.video_filename);
    if (fixed !== row.video_filename) {
      update.run(fixed, row.id);
      repaired++;
    }
  }
  return repaired;
}
