/**
 * 一次性脚本：将 normalized JSON 教程数据导入 SQLite tutorial_videos 表
 * 
 * 运行方式：cd server && npm run import-tutorials
 */
import fs from 'fs';
import path from 'path';
import db from '../db';

interface NormalizedTutorial {
  tutorial_id: string;
  platform: string;
  platform_item_id: string;
  title: string;
  url: string;
  author: string | null;
  source_folder_titles: string[];
  tags: string[];
  related_action_ids: string[];
  related_tactic_ids: string[];
  quality_score: number;
  status: string;
  last_verified_at: string | null;
  duration: number | null;
  description: string | null;
}

interface NormalizedData {
  version: string;
  generated_at: string;
  source: any;
  tutorials: NormalizedTutorial[];
}

const DATA_PATH = path.join(__dirname, '..', 'data', 'tutorials.pingpong-merged.normalized.json');

function main() {
  console.log('[ImportTutorials] Reading normalized data file...');
  
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`[ImportTutorials] Data file not found: ${DATA_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  const data: NormalizedData = JSON.parse(raw);
  
  console.log(`[ImportTutorials] Found ${data.tutorials.length} tutorials in source file`);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO tutorial_videos (
      tutorial_id, platform, platform_item_id, title, url, author,
      source_folder_titles, tags, related_action_ids, related_tactic_ids,
      quality_score, status, last_verified_at, duration, description
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `);

  let imported = 0;
  let skipped = 0;

  const importAll = db.transaction((tutorials: NormalizedTutorial[]) => {
    for (const t of tutorials) {
      const result = insert.run(
        t.tutorial_id,
        t.platform,
        t.platform_item_id,
        t.title || '',
        t.url,
        t.author || null,
        JSON.stringify(t.source_folder_titles || []),
        JSON.stringify(t.tags || []),
        JSON.stringify(t.related_action_ids || []),
        JSON.stringify(t.related_tactic_ids || []),
        0,  // quality_score 初始为 0，冷启动脚本后续覆盖
        'active',
        t.last_verified_at || null,
        t.duration || null,
        t.description || null
      );
      if (result.changes > 0) {
        imported++;
      } else {
        skipped++;
      }
    }
  });

  importAll(data.tutorials);

  console.log(`[ImportTutorials] Complete: imported ${imported}, skipped ${skipped} (already exists)`);
  const totalCount = (db.prepare('SELECT COUNT(*) as count FROM tutorial_videos').get() as { count: number }).count;
  console.log(`[ImportTutorials] Total records in DB: ${totalCount}`);
}

main();
