import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtsCache } from '../tts/cache';

const make = (over: Partial<{ ttlMs: number; maxEntries: number; maxTotalBytes: number }> = {}) =>
  new TtsCache<string>({ ttlMs: 60_000, maxEntries: 10, maxTotalBytes: 1_000_000, ...over });

test('get/set 与命中统计', () => {
  const cache = make();
  cache.set('a', 'A', 10);

  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.get('missing'), undefined);

  const stats = cache.stats();
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 1);
  assert.equal(stats.entries, 1);
  assert.equal(stats.totalBytes, 10);
});

test('过期条目读取时被删除，cleanupExpired 返回清理数', () => {
  const cache = make();
  cache.set('a', 'A', 5, -1); // 立即过期
  cache.set('b', 'B', 5, -1);
  cache.set('c', 'C', 5);

  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.cleanupExpired(), 1);
  assert.equal(cache.get('c'), 'C');
});

test('超过条数上限时淘汰最久未使用的条目', () => {
  const cache = make({ maxEntries: 2 });
  cache.set('a', 'A', 1);
  cache.set('b', 'B', 1);
  cache.get('a'); // a 变成最近使用
  cache.set('c', 'C', 1); // 应淘汰 b

  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.get('c'), 'C');
  assert.ok(cache.stats().evictions >= 1);
});

test('超过总字节上限时继续淘汰', () => {
  const cache = make({ maxTotalBytes: 100 });
  cache.set('a', 'A', 60);
  cache.set('b', 'B', 60);

  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 'B');
  assert.ok(cache.stats().totalBytes <= 100);
});

test('同 key 覆盖写会重算占用字节', () => {
  const cache = make();
  cache.set('a', 'A', 100);
  cache.set('a', 'A2', 10);

  assert.equal(cache.get('a'), 'A2');
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().totalBytes, 10);
});

test('clear 清空所有条目', () => {
  const cache = make();
  cache.set('a', 'A', 10);
  cache.clear();
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().totalBytes, 0);
});
