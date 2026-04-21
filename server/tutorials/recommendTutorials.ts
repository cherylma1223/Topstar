/**
 * 教程推荐主函数
 * 
 * 设计文档 §11：先召回候选，再综合评分 rerank
 * - 相关性分（scoreCandidate）权重最高
 * - status（active 优先于 suspect）
 * - quality_score 作为 rerank 修正项（乘以系数 0.3）
 */
import db from '../db';
import { scoreCandidate, type TutorialCandidate } from './scoreCandidate';

interface TutorialRow {
  tutorial_id: string;
  platform: string;
  platform_item_id: string;
  title: string;
  url: string;
  author: string | null;
  tags: string;              // JSON string
  related_action_ids: string; // JSON string
  quality_score: number;
  status: string;
}

export interface RecommendedTutorial {
  tutorial_id: string;
  title: string;
  url: string;
  platform: string;
  author?: string | null;
  _score?: number;
  _warn?: string;
}

/**
 * 推荐教程
 * 
 * @param actionId - 匹配到的 action_id（如 'bh_flick'），可为 null
 * @param tags - 搜索标签列表
 * @param limit - 返回条数，默认 3
 * @returns 推荐教程列表
 */
export function recommendTutorials(
  actionId: string | null,
  tags: string[],
  limit = 3
): RecommendedTutorial[] {
  // Step 1: 召回候选（排除 dead 状态）
  const allRows = db.prepare(
    "SELECT tutorial_id, platform, platform_item_id, title, url, author, tags, related_action_ids, quality_score, status FROM tutorial_videos WHERE status IN ('active', 'suspect')"
  ).all() as TutorialRow[];

  // 构建搜索标签：action:xxx + 普通标签
  const searchTags = [...tags];
  if (actionId) {
    searchTags.push(`action:${actionId}`);
  }

  // 解析 JSON 字段并做初步过滤（至少有一个匹配条件才入候选）
  const candidates: (TutorialCandidate & { quality_score: number })[] = [];

  for (const row of allRows) {
    const parsedTags: string[] = JSON.parse(row.tags || '[]');
    const parsedActionIds: string[] = JSON.parse(row.related_action_ids || '[]');

    // 基础相关性过滤：action_id 匹配 OR tag 匹配 OR 标题匹配
    const hasActionMatch = actionId ? parsedActionIds.includes(actionId) : false;
    const hasTagMatch = tags.some(t => parsedTags.includes(t));
    const hasTitleMatch = tags.some(t => row.title?.includes(t));

    if (hasActionMatch || hasTagMatch || hasTitleMatch) {
      candidates.push({
        tutorial_id: row.tutorial_id,
        platform: row.platform,
        title: row.title,
        url: row.url,
        author: row.author,
        tags: parsedTags,
        related_action_ids: parsedActionIds,
        quality_score: row.quality_score,
        status: row.status,
      });
    }
  }

  // 限制候选数量（取 limit * 10），避免无谓的评分计算
  const topCandidates = candidates.slice(0, limit * 10);

  // Step 2: 综合评分 rerank
  const scored = topCandidates.map(t => ({
    ...t,
    _score:
      scoreCandidate(t, searchTags) +
      (t.status === 'active' ? 1 : 0) +
      (t.quality_score ?? 0) * 0.3,
  }));

  scored.sort((a, b) => b._score - a._score);

  // Step 3: 取前 limit 条
  const results = scored.slice(0, limit);

  // 降级：若全部为 suspect，附加警告
  const allSuspect = results.length > 0 && results.every(t => t.status === 'suspect');

  return results.map(t => ({
    tutorial_id: t.tutorial_id,
    title: t.title,
    url: t.url,
    platform: t.platform,
    author: t.author,
    _score: t._score,
    _warn: allSuspect ? 'links_unverified' : undefined,
  }));
}
