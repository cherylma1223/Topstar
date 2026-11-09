/**
 * DeepSeek 搜索 Provider
 *
 * POST https://api.deepseek.com/v1/tools/search
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search/
 *
 * 与 chat 接口的区别：
 * - 独立接口、独立计价（成功请求 5 元 / 千次），不是 chat 的「联网开关」
 * - 返回结构化检索结果，不含生成内容；正文是否返回由 need_content 控制
 *
 * 实现选择：need_content=false + 只取 summary。summary 已够模型阅读（600~800 字），
 * 正文动辄几万字，既贵又容易挤爆上下文。
 */
import { LLMError, errorMessage } from '../llm/errors';
import { classifyDeepSeekError } from '../llm/deepseek/DeepSeekProvider';
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from './types';

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
const DEFAULT_TIMEOUT_MS = 8000;

export function searchApiKey(): string {
  return (process.env.WEB_SEARCH_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
}

export function searchEndpoint(): string {
  return (process.env.WEB_SEARCH_ENDPOINT || DEFAULT_ENDPOINT).trim();
}

export class DeepSeekSearchProvider implements WebSearchProvider {
  readonly name = 'deepseek';

  isConfigured(): boolean {
    return searchApiKey().length > 0;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResult[]> {
    if (!this.isConfigured()) {
      throw new LLMError('NOT_CONFIGURED', 'WEB_SEARCH_API_KEY / DEEPSEEK_API_KEY is not set', { provider: 'deepseek-search' });
    }

    const body: Record<string, unknown> = {
      query: req.query,
      count: req.count ?? 5,
      need_content: false,
    };
    if (req.oriQuestion) body.ori_question = req.oriQuestion;

    const timeoutMs = Number(process.env.WEB_SEARCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

    let res: Response;
    try {
      res = await fetch(searchEndpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${searchApiKey()}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LLMError('UPSTREAM_UNAVAILABLE', `search request failed: ${errorMessage(err)}`, { provider: 'deepseek-search', cause: err });
    }

    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      throw new LLMError(classifyDeepSeekError(res.status, raw), `HTTP ${res.status}: ${raw.slice(0, 300)}`, { provider: 'deepseek-search' });
    }

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new LLMError('UPSTREAM_UNAVAILABLE', `invalid JSON in search response: ${raw.slice(0, 200)}`, { provider: 'deepseek-search' });
    }

    const items: any[] = Array.isArray(payload?.results) ? payload.results : [];
    return items
      .filter(it => it && typeof it.url === 'string' && it.url)
      .map(it => ({
        title: typeof it.title === 'string' && it.title ? it.title : it.url,
        url: it.url,
        snippet: typeof it.snippet === 'string' ? it.snippet : undefined,
        summary: typeof it.summary === 'string' ? it.summary : undefined,
        siteName: it.site_name ?? null,
        publishedAt: it.date ?? null,
        rerankScore: typeof it.rerank_score === 'number' ? it.rerank_score : undefined,
        authority: typeof it.authority === 'number' ? it.authority : undefined,
      }));
  }
}
