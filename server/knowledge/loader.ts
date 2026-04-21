import fs from 'fs';
import path from 'path';

export interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
  keywords: string[];
  content: string;
}

const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', 'client', 'src', 'assets', 'knowledge');
const knowledgeStore = new Map<string, KnowledgeEntry>();
let knowledgeIndex: Array<{
  id: string;
  title: string;
  category: string;
  file: string;
  keywords?: string[];
}> = [];

/**
 * 加载知识库文件到内存
 */
export function loadKnowledgeBase(): void {
  try {
    const indexPath = path.join(KNOWLEDGE_DIR, 'index.json');
    if (!fs.existsSync(indexPath)) {
      console.warn('[Knowledge] index.json not found at:', indexPath);
      return;
    }

    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    knowledgeIndex = indexData.entries || [];

    let loaded = 0;
    for (const entry of knowledgeIndex) {
      const filePath = path.join(KNOWLEDGE_DIR, entry.file);
      if (fs.existsSync(filePath)) {
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        // 去除 YAML frontmatter（--- ... ---）
        const content = rawContent.replace(/^---[\s\S]*?---\n*/, '').trim();
        knowledgeStore.set(entry.id, {
          id: entry.id,
          title: entry.title,
          category: entry.category,
          keywords: entry.keywords || [],
          content: content,
        });
        loaded++;
      } else {
        console.warn(`[Knowledge] File not found: ${filePath}`);
      }
    }
    console.log(`[Knowledge] Loaded ${loaded}/${knowledgeIndex.length} knowledge files.`);
  } catch (err: any) {
    console.error('[Knowledge] Failed to load knowledge base:', err.message);
  }
}

/**
 * 获取知识库 Store（用于外部模块访问）
 */
export function getKnowledgeStore(): Map<string, KnowledgeEntry> {
  return knowledgeStore;
}

/**
 * 获取所有知识条目的 id 列表（用于意图路由注入 action_id 候选）
 */
export function getActionIds(): string[] {
  return knowledgeIndex
    .filter(e => e.category === 'actions')
    .map(e => e.id);
}

/**
 * 获取知识索引
 */
export function getKnowledgeIndex() {
  return knowledgeIndex;
}
