/**
 * 教程库数据访问层
 * 提供单条查询等辅助函数
 */
import db from '../db';

interface TutorialRow {
  tutorial_id: string;
  platform: string;
  platform_item_id: string;
  title: string;
  url: string;
  author: string | null;
  tags: string;
  related_action_ids: string;
  quality_score: number;
  status: string;
  consecutive_failures: number;
  last_checked_at: string | null;
  failure_reported_by_user: number;
}

/**
 * 按 tutorial_id 查询单条教程
 */
export function getTutorial(tutorialId: string): TutorialRow | undefined {
  return db.prepare(
    'SELECT * FROM tutorial_videos WHERE tutorial_id = ?'
  ).get(tutorialId) as TutorialRow | undefined;
}

/**
 * 更新教程状态（链接健康检查、用户上报等使用）
 */
export function updateTutorialStatus(
  tutorialId: string,
  updates: {
    status?: string;
    consecutive_failures?: number;
    last_checked_at?: string;
    failure_reported_by_user?: number;
  }
): void {
  const setClauses: string[] = [];
  const values: any[] = [];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
  }
  if (updates.consecutive_failures !== undefined) {
    setClauses.push('consecutive_failures = ?');
    values.push(updates.consecutive_failures);
  }
  if (updates.last_checked_at !== undefined) {
    setClauses.push('last_checked_at = ?');
    values.push(updates.last_checked_at);
  }
  if (updates.failure_reported_by_user !== undefined) {
    setClauses.push('failure_reported_by_user = ?');
    values.push(updates.failure_reported_by_user);
  }

  if (setClauses.length === 0) return;

  values.push(tutorialId);
  db.prepare(
    `UPDATE tutorial_videos SET ${setClauses.join(', ')} WHERE tutorial_id = ?`
  ).run(...values);
}

/**
 * 获取需要健康检查的教程列表
 */
export function getTutorialsForHealthCheck(checkIntervalDays: number, deadRetryDays: number): TutorialRow[] {
  // 获取所有教程，由健康检查 Job 自行判断是否需要检查
  return db.prepare(
    'SELECT * FROM tutorial_videos'
  ).all() as TutorialRow[];
}
