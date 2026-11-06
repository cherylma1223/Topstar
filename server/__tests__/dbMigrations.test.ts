import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateAnalysisJobs, repairFilenameEncoding } from '../dbMigrations';

/** 迁移前的旧表结构（没有 provider / file_ref） */
function createLegacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE analysis_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      model TEXT,
      gemini_file_name TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`INSERT INTO analysis_jobs (id, gemini_file_name, created_at) VALUES (?, ?, 'x')`);
  insert.run('with-file', 'files/abc');
  insert.run('without-file', null);
  return db;
}

test('旧库：补 provider / file_ref 两列，并回填有文件引用的历史记录', () => {
  const db = createLegacyDb();
  const result = migrateAnalysisJobs(db);

  assert.deepEqual(result.added, ['provider', 'file_ref', 'trace']);
  assert.equal(result.backfilled, 1);

  const rows = db.prepare(`SELECT id, provider, file_ref, gemini_file_name FROM analysis_jobs ORDER BY id`).all();
  assert.deepEqual(rows, [
    { id: 'with-file', provider: 'gemini_files', file_ref: 'files/abc', gemini_file_name: 'files/abc' },
    { id: 'without-file', provider: null, file_ref: null, gemini_file_name: null },
  ]);
});

test('幂等：重复执行不再加列、不再回填，也不覆盖已有的新字段', () => {
  const db = createLegacyDb();
  migrateAnalysisJobs(db);

  db.prepare(`UPDATE analysis_jobs SET provider = 'aliyun_oss', file_ref = 'videos/1.mp4' WHERE id = 'with-file'`).run();
  const second = migrateAnalysisJobs(db);

  assert.deepEqual(second, { added: [], backfilled: 0 });
  const row = db.prepare(`SELECT provider, file_ref FROM analysis_jobs WHERE id = 'with-file'`).get();
  assert.deepEqual(row, { provider: 'aliyun_oss', file_ref: 'videos/1.mp4' });
});

test('新库（建表时已含新列）：直接通过，不报错', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE analysis_jobs (id TEXT PRIMARY KEY, gemini_file_name TEXT, provider TEXT, file_ref TEXT, trace TEXT)`);
  assert.deepEqual(migrateAnalysisJobs(db), { added: [], backfilled: 0 });
});

test('repairFilenameEncoding：只修复乱码的中文名，ASCII / 正确中文 / latin1 原名保持不动，且幂等', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE analysis_jobs (id TEXT PRIMARY KEY, video_filename TEXT)`);
  const insert = db.prepare(`INSERT INTO analysis_jobs (id, video_filename) VALUES (?, ?)`);
  // 用 \u 转义写出 multer 误读后的样子（线上真实值：马诗彤-b.MOV / 大盼盼2.MOV）
  insert.run('garbled', '\u00e9\u00a9\u00ac\u00e8\u00af\u0097\u00e5\u00bd\u00a4-b.MOV');
  insert.run('garbled2', '\u00e5\u00a4\u00a7\u00e7\u009b\u00bc\u00e7\u009b\u00bc2.MOV');
  insert.run('ok-cn', '大盼盼2.MOV');
  insert.run('ascii', 'video.mp4');
  insert.run('latin1', 'café.mov');
  insert.run('null', null);

  assert.equal(repairFilenameEncoding(db), 2);
  assert.equal(repairFilenameEncoding(db), 0); // 幂等

  const names = Object.fromEntries(
    (db.prepare(`SELECT id, video_filename FROM analysis_jobs`).all() as { id: string; video_filename: string | null }[])
      .map(r => [r.id, r.video_filename])
  );
  assert.deepEqual(names, {
    garbled: '马诗彤-b.MOV',
    garbled2: '大盼盼2.MOV',
    'ok-cn': '大盼盼2.MOV',
    ascii: 'video.mp4',
    latin1: 'café.mov',
    null: null,
  });
});
