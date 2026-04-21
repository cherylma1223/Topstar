/**
 * 候选教程评分函数
 * 
 * 设计文档 §11：评分量级
 * - action_id 精确命中：+5（保证有 action 关联的教程始终排在无关联之前）
 * - tag 命中数：min(hits * 0.5, 2)
 * - 标题关键词命中：+0.5
 */

export interface TutorialCandidate {
  tutorial_id: string;
  platform: string;
  title: string;
  url: string;
  tags: string[];
  related_action_ids: string[];
  quality_score: number;
  status: string;
  author?: string | null;
}

/**
 * 计算单个教程候选的相关性分数
 * 
 * @param tutorial - 教程候选
 * @param searchTags - 搜索标签，action_id 以 'action:' 前缀传入（如 'action:bh_flick'）
 * @returns 相关性分数
 */
export function scoreCandidate(tutorial: TutorialCandidate, searchTags: string[]): number {
  let score = 0;

  // 1. action_id 精确命中：最高权重 +5
  const actionMatched = tutorial.related_action_ids?.some(id =>
    searchTags.includes(`action:${id}`)
  );
  if (actionMatched) score += 5;

  // 2. tag 命中数：每个命中 +0.5，上限 +2
  const plainTags = searchTags.filter(t => !t.startsWith('action:'));
  const tagHits = plainTags.filter(t => tutorial.tags?.includes(t)).length;
  score += Math.min(tagHits * 0.5, 2);

  // 3. 标题关键词命中：+0.5
  const titleHit = plainTags.some(t => tutorial.title?.includes(t));
  if (titleHit) score += 0.5;

  return score;
}
