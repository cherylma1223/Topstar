import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TOKEN_LENGTH, resolveIsVip, VIP_TOKEN_HEADER } from '../vip';

const TOKEN = 'internal-tester-token-0001';
const H = (v?: string | string[]) => (v === undefined ? {} : { [VIP_TOKEN_HEADER]: v });

const warn = console.warn;
beforeEach(() => { console.warn = () => {}; });

test('默认（没配置令牌）：谁都不是 VIP，哪怕带了请求头', () => {
  assert.equal(resolveIsVip({}, {}), false);
  assert.equal(resolveIsVip(H(TOKEN), {}), false);
  assert.equal(resolveIsVip(H(TOKEN), { VIP_ACCESS_TOKENS: '' }), false);
  assert.equal(resolveIsVip(H(TOKEN), { VIP_ACCESS_TOKENS: ' , ,' }), false);
});

test('配置了令牌：只有请求头与之匹配才是 VIP', () => {
  const env = { VIP_ACCESS_TOKENS: TOKEN };
  assert.equal(resolveIsVip(H(TOKEN), env), true);
  assert.equal(resolveIsVip(H(TOKEN + 'x'), env), false);
  assert.equal(resolveIsVip(H(TOKEN.slice(0, -1)), env), false);
  assert.equal(resolveIsVip(H('wrong-token-wrong-token'), env), false);
  assert.equal(resolveIsVip(H(''), env), false);
  assert.equal(resolveIsVip({}, env), false);
});

test('多个令牌（逗号分隔，忽略空格）；请求头是数组时取第一个', () => {
  const env = { VIP_ACCESS_TOKENS: ` ${TOKEN} , another-tester-token-0002 ` };
  assert.equal(resolveIsVip(H('another-tester-token-0002'), env), true);
  assert.equal(resolveIsVip(H(TOKEN), env), true);
  assert.equal(resolveIsVip(H([TOKEN, 'x']), env), true);
  assert.equal(resolveIsVip(H(['x', TOKEN]), env), false);
});

test(`短于 ${MIN_TOKEN_LENGTH} 个字符的令牌被忽略（防止被猜中）`, () => {
  assert.equal(resolveIsVip(H('abc123'), { VIP_ACCESS_TOKENS: 'abc123' }), false);
  // 同时配了弱令牌和强令牌：弱的无效，强的有效
  const env = { VIP_ACCESS_TOKENS: `abc123,${TOKEN}` };
  assert.equal(resolveIsVip(H('abc123'), env), false);
  assert.equal(resolveIsVip(H(TOKEN), env), true);
  assert.equal(TOKEN.length >= MIN_TOKEN_LENGTH, true);
});

test('令牌区分大小写，且不受请求体影响（函数根本不接收请求体）', () => {
  assert.equal(resolveIsVip(H(TOKEN.toUpperCase()), { VIP_ACCESS_TOKENS: TOKEN }), false);
  assert.equal(resolveIsVip.length >= 1, true);
  console.warn = warn;
});
