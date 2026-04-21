import { getKnowledgeStore, type KnowledgeEntry } from './loader';

export interface KnowledgeMatch {
  id: string;
  title: string;
  category: string;
  content: string;
  score: number;
}

/**
 * 根据用户输入匹配相关知识文件
 * @param query - 用户的问题文本
 * @param maxResults - 最多返回的知识文件数量
 */
export function matchKnowledge(query: string, maxResults = 5): KnowledgeMatch[] {
  const store = getKnowledgeStore();
  if (!query || store.size === 0) return [];

  const scored: KnowledgeMatch[] = [];

  for (const [id, data] of store) {
    let score = 0;

    // 关键词匹配：每命中一个关键词 +10 分，命中越多得分越高
    for (const keyword of data.keywords) {
      if (query.includes(keyword)) {
        // 根据关键词长度加权（更长的关键词匹配更精确）
        score += 10 + keyword.length;
      }
    }

    // 标题匹配：+20 分
    if (query.includes(data.title)) {
      score += 20;
    }

    if (score > 0) {
      scored.push({ id, title: data.title, category: data.category, content: data.content, score });
    }
  }

  // 按得分降序排列，取前 N 个
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/**
 * 生成知识库摘要列表（兜底：当没有命中任何关键词时使用）
 */
export function getKnowledgeSummary(): string {
  return '（系统提示：本次回复未命中特定的专家知识库条目，请严格根据你自身的专业知识并仅使用上述要求的输出结构回答，不要主动提供或罗列其他的帮助选项或目录。）';
}
