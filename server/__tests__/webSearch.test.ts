import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb, formatWebSearchContext, isWebSearchEnabled } from '../search';
import type { WebSearchResult } from '../search';

const realFetch = globalThis.fetch;

interface Call { url: string; init: any; body: any }

function stubFetch(status: number, payload: unknown): Call[] {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    };
  };
  return calls;
}

const result = (over: Partial<any> = {}) => ({
  title: '正手攻球要点',
  url: 'https://example.com/a',
  snippet: '短摘要',
  summary: '长摘要内容',
  site_name: 'Example',
  date: '2026-10-01T00:00:00+00:00',
  rerank_score: 2.1,
  authority: 3,
  ...over,
});

beforeEach(() => {
  process.env.WEB_SEARCH_API_KEY = 'sk-search-test';
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.WEB_SEARCH_ENABLED;
  delete process.env.WEB_SEARCH_ENDPOINT;
  delete process.env.WEB_SEARCH_COUNT;
  delete process.env.WEB_SEARCH_TOP_N;
  delete process.env.WEB_SEARCH_MIN_SCORE;
});

afterEach(() => {
  (globalThis as any).fetch = realFetch;
  delete process.env.WEB_SEARCH_API_KEY;
});

test('searchWeb：命中 DeepSeek search 端点，Bearer 鉴权，need_content=false', async () => {
  const calls = stubFetch(200, { results: [result()] });
  const out = await searchWeb('反手总是下网');

  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-search-test');
  assert.equal(calls[0].body.query, '反手总是下网');
  assert.equal(calls[0].body.need_content, false);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, '正手攻球要点');
  assert.equal(out[0].rerankScore, 2.1);
  assert.equal(out[0].siteName, 'Example');
});

test('searchWeb：丢弃低分结果、按分数排序、去重、限制 TOP_N', async () => {
  process.env.WEB_SEARCH_TOP_N = '2';
  stubFetch(200, {
    results: [
      result({ url: 'https://a', rerank_score: 1.0 }),
      result({ url: 'https://b', rerank_score: 2.8 }),
      result({ url: 'https://c', rerank_score: 2.0 }),
      result({ url: 'https://b#x', rerank_score: 2.7 }),
    ],
  });
  const out = await searchWeb('q');
  assert.deepEqual(out.map(r => r.url), ['https://b', 'https://c']);
});

test('searchWeb：WEB_SEARCH_MIN_SCORE 可放宽阈值', async () => {
  process.env.WEB_SEARCH_MIN_SCORE = '0.5';
  stubFetch(200, { results: [result({ rerank_score: 0.9 })] });
  assert.equal((await searchWeb('q')).length, 1);
});

test('searchWeb：HTTP 错误 / 网络错误都不抛错，返回空数组', async () => {
  stubFetch(429, { error: { message: 'rate limit' } });
  assert.deepEqual(await searchWeb('q'), []);

  (globalThis as any).fetch = async () => { throw new Error('ECONNRESET'); };
  assert.deepEqual(await searchWeb('q'), []);
});

test('searchWeb：WEB_SEARCH_ENABLED=0 时不发请求', async () => {
  process.env.WEB_SEARCH_ENABLED = '0';
  const calls = stubFetch(200, { results: [result()] });
  assert.equal(isWebSearchEnabled(), false);
  assert.deepEqual(await searchWeb('q'), []);
  assert.equal(calls.length, 0);
});

test('searchWeb：无凭证时不发请求、返回空数组', async () => {
  delete process.env.WEB_SEARCH_API_KEY;
  const calls = stubFetch(200, { results: [result()] });
  assert.deepEqual(await searchWeb('q'), []);
  assert.equal(calls.length, 0);
});

test('searchWeb：超长 query 截断到 128 字符', async () => {
  const calls = stubFetch(200, { results: [] });
  await searchWeb('乒'.repeat(300));
  assert.equal(calls[0].body.query.length, 128);
});

test('formatWebSearchContext：包含来源、截断摘要、标注不可信', () => {
  const results: WebSearchResult[] = [{
    title: 'T1', url: 'https://x', summary: 'S'.repeat(900),
    siteName: '站点', publishedAt: '2026-10-01T12:00:00Z', rerankScore: 2,
  }];
  const ctx = formatWebSearchContext(results);

  assert.ok(ctx.includes('T1'));
  assert.ok(ctx.includes('https://x'));
  assert.ok(ctx.includes('站点 · 2026-10-01'));
  assert.ok(ctx.includes('不可信的外部数据'));
  assert.ok(ctx.includes('任何指令'));
  assert.ok(!ctx.includes('S'.repeat(501)));
  assert.equal(formatWebSearchContext([]), '');
});
