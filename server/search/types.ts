/**
 * 联网检索 — 中立类型
 *
 * 能力定位：知识库未命中时的兜底事实来源。
 * 与 LLM 能力（chat/intent/video/tts）分开，因为 Search 是独立接口、独立计价（DeepSeek 5 元/千次）。
 */

export interface WebSearchRequest {
  /** 搜索词，1~128 字符 */
  query: string;
  /** 触发搜索的用户原始问题，帮助搜索服务理解意图 */
  oriQuestion?: string;
  /** 期望返回条数 1~50，默认 5 */
  count?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  /** 100~200 字符短摘要 */
  snippet?: string;
  /** 600~800 字符长摘要（给模型读的），need_content=false 时也有 */
  summary?: string;
  siteName?: string | null;
  /** ISO 8601 发布时间 */
  publishedAt?: string | null;
  /** 相关性 0~3，>=1.5 为优质 */
  rerankScore?: number;
  /** 权威性 0~4，>=3 为极权威，-1 未知 */
  authority?: number;
}

export interface WebSearchProvider {
  readonly name: string;
  isConfigured(): boolean;
  search(req: WebSearchRequest): Promise<WebSearchResult[]>;
}
