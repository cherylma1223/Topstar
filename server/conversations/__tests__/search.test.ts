/**
 * 模糊搜索工具的单测（纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnippet, escapeLike, normalizeQuery, MAX_QUERY_LENGTH } from '../search';

test('normalizeQuery: 非字符串 / 空白 → null', () => {
  assert.equal(normalizeQuery(undefined), null);
  assert.equal(normalizeQuery(123), null);
  assert.equal(normalizeQuery(''), null);
  assert.equal(normalizeQuery('   '), null);
});

test('normalizeQuery: 去首尾空格并按字符截断到 50', () => {
  assert.equal(normalizeQuery('  反手拧拉  '), '反手拧拉');
  const long = '反'.repeat(80);
  assert.equal(Array.from(normalizeQuery(long)!).length, MAX_QUERY_LENGTH);
});

test('escapeLike: % _ \\ 都被转义', () => {
  assert.equal(escapeLike('50%'), '50\\%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.equal(escapeLike('a\\b'), 'a\\\\b');
  assert.equal(escapeLike('反手'), '反手');
});

test('buildSnippet: 命中位置前后各取 radius 个字符', () => {
  const title = '这是一段很长的标题用来测试命中片段是否居中显示反手拧拉总下网怎么办';
  assert.equal(buildSnippet(title, '反手拧拉', 4), '…居中显示反手拧拉总下网怎…');
  assert.equal(buildSnippet('直板反手拧拉', '反手', 2), '直板反手拧拉');
});

test('buildSnippet: 命中在开头不加前置省略号，命中在结尾不加后置省略号', () => {
  assert.equal(buildSnippet('反手拧拉入门', '反手'), '反手拧拉入门');
  assert.equal(buildSnippet('直板反手拧拉', '拧拉', 1), '…手拧拉');
});

test('buildSnippet: 没命中 → null；空参数 → null', () => {
  assert.equal(buildSnippet('正手攻球', '反手'), null);
  assert.equal(buildSnippet('', '反手'), null);
  assert.equal(buildSnippet('反手', '  '), null);
});

test('buildSnippet: ASCII 不区分大小写', () => {
  assert.equal(buildSnippet('Forehand Loop', 'loop'), 'Forehand Loop');
});

test('buildSnippet: 超长标题两端都有省略号', () => {
  const title = '前'.repeat(20) + '反手' + '后'.repeat(20);
  const snippet = buildSnippet(title, '反手', 3)!;
  assert.ok(snippet.startsWith('…'), '前置省略号');
  assert.ok(snippet.endsWith('…'), '后置省略号');
  assert.ok(snippet.includes('反手'));
});
