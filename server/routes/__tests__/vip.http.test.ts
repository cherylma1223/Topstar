/**
 * VIP 判定的 HTTP 回归测试
 *
 * 复现并堵住原来的漏洞：直接请求 /api/v2/chat 并在请求体里写 `prefs: { is_vip: true }`，
 * 过去就能拿到「核心秘诀」。这里通过真实的 Express 路由 + 假模型验证：
 *   - 请求体里的 is_vip 不再起作用；
 *   - 只有服务端配置了令牌、且请求头匹配时才解锁；
 *   - 非 VIP 时秘诀正文在进入模型之前就已被剥离。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.VIDEO_ANALYSIS_LOG_DISABLED = '1';

// 路由会引入 ../db（打开真实数据库）。这个测试不需要数据库，换成内存假的，避免碰线上数据
const fakeStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const dbPath = path.resolve(__dirname, '../../db.ts');
const dbModule = new Module(dbPath);
dbModule.exports = { __esModule: true, default: { prepare: () => fakeStmt, exec: () => {}, pragma: () => {} } };
(dbModule as any).loaded = true;
require.cache[dbPath] = dbModule;

import express from 'express';
import { __setProviderForTest } from '../../llm/registry';
import type { GenerateRequest, LLMProvider } from '../../llm';
import { loadKnowledgeBase } from '../../knowledge/loader';
import { matchKnowledge } from '../../knowledge/matcher';
import { VIP_TOKEN_HEADER } from '../../auth/vip';

const MESSAGE = '正手拉球怎么练';
const TOKEN = 'internal-tester-token-0001';
const LOCKED = '[LOCKED_VIP_CONTENT]';
const SECRET_SECTION_REGEX = /【(?:核心秘诀|VIP专属)[^】]*】([\s\S]*?)(?=\n【|$)/;

let server: Server;
let baseUrl = '';
let secretMarker = '';          // 知识库里「核心秘诀」正文的一小段，用来检查它有没有进入模型
let modelPrompts: string[] = []; // 每次 chat 调用收到的 system prompt

// 假模型：意图识别返回 ACTION_COACHING；对话回答里固定带一段「核心秘诀」
const MODEL_ANSWER = '【动作要领】\n站位要稳。\n\n【核心秘诀】\n模型输出的秘诀正文-XYZ';
const fake: LLMProvider = {
  name: 'gemini',
  isConfigured: () => true,
  async generate(req: GenerateRequest) {
    if (req.capability === 'intent') {
      return { text: '{"intent":"ACTION_COACHING","secondary_intents":[],"entities":{"action_id":null},"confidence":0.9,"reason":"t"}' };
    }
    modelPrompts.push(req.system ?? '');
    return { text: MODEL_ANSWER };
  },
  async tts() { throw new Error('not used'); },
};

before(async () => {
  console.log = () => {};
  console.warn = () => {};
  loadKnowledgeBase();
  __setProviderForTest('gemini', fake);

  // 从真实知识库里找出「核心秘诀」正文，确认测试前提成立（否则这个测试什么也证明不了）
  for (const hit of matchKnowledge(MESSAGE)) {
    const m = hit.content.match(SECRET_SECTION_REGEX);
    if (m) { secretMarker = m[1].replace(/\s+/g, '').slice(0, 12); break; }
  }
  assert.ok(secretMarker.length >= 6, `测试前提不成立：「${MESSAGE}」命中的知识库里没有「核心秘诀」段落`);

  const { default: v2Router } = require('../../routes/v2');
  const app = express();
  app.use(express.json());
  app.use('/api/v2', v2Router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  __setProviderForTest('gemini', undefined);
  delete process.env.VIP_ACCESS_TOKENS;
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  modelPrompts = [];
  delete process.env.VIP_ACCESS_TOKENS;
});

async function chat(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/v2/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ message: MESSAGE, ...body }),
  });
  const json: any = await res.json();
  const prompt = modelPrompts.at(-1) ?? '';
  return { status: res.status, answer: String(json.answerText ?? ''), prompt, json };
}

/** 秘诀正文有没有进入模型：看知识库里的原文片段是否出现在发给模型的 system prompt 里 */
const secretReachedModel = (prompt: string) => prompt.replace(/\s+/g, '').includes(secretMarker);

test('原漏洞：请求体里写 prefs.is_vip=true 不再能解锁（答案锁定，秘诀正文也没进模型）', async () => {
  const r = await chat({ prefs: { is_vip: true } });
  assert.equal(r.status, 200);
  assert.ok(r.answer.includes(LOCKED), r.answer);
  assert.ok(!r.answer.includes('模型输出的秘诀正文-XYZ'), r.answer);
  assert.equal(secretReachedModel(r.prompt), false, '非 VIP 时秘诀正文不应进入模型');
});

test('请求体里无论怎么伪造（isVip / is_vip / vip / prefs 嵌套）都无效', async () => {
  for (const forged of [
    { isVip: true }, { is_vip: true }, { vip: true }, { prefs: { is_vip: 'true' } }, { prefs: { isVip: true } },
  ]) {
    const r = await chat(forged);
    assert.ok(r.answer.includes(LOCKED), JSON.stringify(forged));
    assert.equal(secretReachedModel(r.prompt), false, JSON.stringify(forged));
  }
});

test('默认（没配置令牌）：即使带了令牌请求头也不是 VIP', async () => {
  const r = await chat({}, { [VIP_TOKEN_HEADER]: TOKEN });
  assert.ok(r.answer.includes(LOCKED));
  assert.equal(secretReachedModel(r.prompt), false);
});

test('服务端配置了令牌，但请求头不对 / 缺失：仍然锁定', async () => {
  process.env.VIP_ACCESS_TOKENS = TOKEN;
  for (const headers of [{}, { [VIP_TOKEN_HEADER]: 'wrong-token-wrong-token' }, { [VIP_TOKEN_HEADER]: TOKEN + '0' }] as Record<string, string>[]) {
    const r = await chat({ prefs: { is_vip: true } }, headers);
    assert.ok(r.answer.includes(LOCKED), JSON.stringify(headers));
    assert.equal(secretReachedModel(r.prompt), false, JSON.stringify(headers));
  }
});

test('服务端配置了令牌且请求头匹配：解锁（秘诀正文进入模型，答案不再带锁定占位）', async () => {
  process.env.VIP_ACCESS_TOKENS = TOKEN;
  const r = await chat({}, { [VIP_TOKEN_HEADER]: TOKEN }); // 请求体里没有任何 VIP 字段，只靠请求头
  assert.equal(r.status, 200);
  assert.ok(!r.answer.includes(LOCKED), r.answer);
  assert.ok(r.answer.includes('模型输出的秘诀正文-XYZ'), r.answer);
  assert.equal(secretReachedModel(r.prompt), true, 'VIP 时秘诀正文应提供给模型');
});
