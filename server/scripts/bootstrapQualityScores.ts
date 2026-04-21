/**
 * 一次性脚本：为教程库记录计算初始 quality_score（冷启动评分）
 * 
 * 基于设计文档 §19.2 的结构化信号评分逻辑
 * 运行方式：cd server && npm run bootstrap-scores
 */
import db from '../db';

interface TutorialRow {
  tutorial_id: string;
  title: string;
  author: string | null;
  description: string | null;
  duration: number | null;
  source_folder_titles: string; // JSON string
  related_action_ids: string;   // JSON string
  quality_score: number;
}

function scoreTitleQuality(title: string): number {
  if (!title || title.startsWith('#')) return -0.5;  // 纯 hashtag 标题质量低
  if (title.length < 5) return -0.5;                 // 标题过短
  if (title.length > 10) return 0.5;                  // 标题有实质内容
  return 0;
}

function computeInitialScore(t: TutorialRow): number {
  let score = 0;

  // 信源质量
  if (t.author) score += 1;

  // 内容标注完整度
  const actionIds: string[] = JSON.parse(t.related_action_ids || '[]');
  if (actionIds.length > 0) score += 2;   // 最高权重：有动作关联才能精确推荐

  if (t.description) score += 0.5;
  if (t.duration && t.duration > 0) score += 0.5;

  // 收藏夹交叉度（被多个收藏夹收录 = 更多人认为值得保存）
  const folderTitles: string[] = JSON.parse(t.source_folder_titles || '[]');
  const folderCount = folderTitles.length;
  score += Math.min(Math.max(folderCount - 1, 0), 2);   // 最多 +2

  // 标题质量（简单启发式）
  score += scoreTitleQuality(t.title);

  return Math.round(score * 10) / 10;   // 保留一位小数
}

function main() {
  console.log('[BootstrapScores] Starting quality score bootstrap...');

  // 只更新 quality_score = 0 的记录
  const tutorials = db.prepare(
    'SELECT tutorial_id, title, author, description, duration, source_folder_titles, related_action_ids, quality_score FROM tutorial_videos WHERE quality_score = 0'
  ).all() as TutorialRow[];

  console.log(`[BootstrapScores] Found ${tutorials.length} records with quality_score = 0`);

  const update = db.prepare(
    'UPDATE tutorial_videos SET quality_score = ?, score_source = ? WHERE tutorial_id = ?'
  );

  let updated = 0;
  let scoreDistribution: Record<string, number> = {};

  const updateAll = db.transaction((records: TutorialRow[]) => {
    for (const t of records) {
      const score = computeInitialScore(t);
      update.run(score, 'auto_bootstrap_v1', t.tutorial_id);
      updated++;

      // 统计分布
      const bucket = Math.floor(score).toString();
      scoreDistribution[bucket] = (scoreDistribution[bucket] || 0) + 1;
    }
  });

  updateAll(tutorials);

  console.log(`[BootstrapScores] Complete: ${updated} records updated`);
  console.log('[BootstrapScores] Score distribution:');
  for (const [bucket, count] of Object.entries(scoreDistribution).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  score ${bucket}.x: ${count} records`);
  }

  // 输出 Top 10
  const top10 = db.prepare(
    'SELECT tutorial_id, title, quality_score, score_source FROM tutorial_videos ORDER BY quality_score DESC LIMIT 10'
  ).all();
  console.log('\n[BootstrapScores] Top 10 by quality_score:');
  for (const row of top10 as any[]) {
    console.log(`  [${row.quality_score}] ${row.title} (${row.tutorial_id})`);
  }
}

main();
