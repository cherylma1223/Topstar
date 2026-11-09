import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekProvider, classifyDeepSeekError, deepseekBaseUrl } from '../deepseek/DeepSeekProvider';
import { LLMError } from '../errors';
import type { GenerateRequest } from '../types';

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

const req = (extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
  capability: 'intent',
  messages: [{ role: 'user', parts: [{ type: 'text', text: '正手怎么练' }] }],
  ...extra,
});

const okPayload = {
  choices: [{ message: { content: '{"intent":"ACTION_COACHING"}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
};

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_THINKING;
  delete process.env.DEEPSEEK_MAX_TOKENS;
});

afterEach(() => {
  (globalThis as any).fetch = realFetch;
  delete process.env.DEEPSEEK_API_KEY;
});

// ─── 请求拼装 ────────────────────────────────────────────────────

test('generate：Bearer 鉴权、命中 base_url、返回 text 与 usage', async () => {
  const calls = stubFetch(200, okPayload);
  const out = await new DeepSeekProvider().generate(req(), 'deepseek-flash');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].body.stream, false);
  assert.equal(out.text, '{"intent":"ACTION_COACHING"}');
  assert.deepEqual(out.usage, { inputTokens: 11, outputTokens: 7 });
});

test('intent 能力默认关闭思考模式，chat 能力留给服务端默认', async () => {
  const intentCalls = stubFetch(200, okPayload);
  await new DeepSeekProvider().generate(req({ capability: 'intent' }), 'deepseek-flash');
  assert.deepEqual(intentCalls[0].body.thinking, { type: 'disabled' });

  const chatCalls = stubFetch(200, okPayload);
  await new DeepSeekProvider().generate(req({ capability: 'chat' }), 'deepseek-flash');
  assert.equal(chatCalls[0].body.thinking, undefined);
});

test('DEEPSEEK_THINKING 可强制覆盖，system 转为 system 消息', async () => {
  process.env.DEEPSEEK_THINKING = 'enabled';
  const calls = stubFetch(200, okPayload);
  await new DeepSeekProvider().generate(req({ capability: 'intent', system: '你是教练' }), 'm');
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled' });
  assert.deepEqual(calls[0].body.messages[0], { role: 'system', content: '你是教练' });
  assert.deepEqual(calls[0].body.messages[1], { role: 'user', content: '正手怎么练' });
});

test('提供 responseSchema 时开启 JSON Output', async () => {
  const calls = stubFetch(200, okPayload);
  await new DeepSeekProvider().generate(
    req({ responseSchema: { type: 'object', properties: { intent: { type: 'string' } } } as any }),
    'deepseek-flash'
  );
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
});

test('DEEPSEEK_BASE_URL 去尾斜杠，自定义端点生效', async () => {
  process.env.DEEPSEEK_BASE_URL = 'https://proxy.example.com/v1/';
  assert.equal(deepseekBaseUrl(), 'https://proxy.example.com/v1');
  const calls = stubFetch(200, okPayload);
  await new DeepSeekProvider().generate(req(), 'm');
  assert.equal(calls[0].url, 'https://proxy.example.com/v1/chat/completions');
});

// ─── 错误归一 ────────────────────────────────────────────────────

test('classifyDeepSeekError 覆盖各状态码', () => {
  assert.equal(classifyDeepSeekError(404, 'model not exist'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyDeepSeekError(402, 'Insufficient Balance'), 'QUOTA_EXHAUSTED');
  assert.equal(classifyDeepSeekError(429, 'rate limit'), 'RATE_LIMITED');
  assert.equal(classifyDeepSeekError(503, 'server busy'), 'UPSTREAM_UNAVAILABLE');
  assert.equal(classifyDeepSeekError(401, 'auth'), 'AUTH_FAILED');
  assert.equal(classifyDeepSeekError(422, 'bad param'), 'INVALID_REQUEST');
  assert.equal(classifyDeepSeekError(418, 'teapot'), 'UNKNOWN');
});

test('非 2xx 转为 LLMError，且不泄露 API key', async () => {
  stubFetch(402, { error: { message: 'Insufficient Balance', type: 'insufficient_balance' } });
  await assert.rejects(
    () => new DeepSeekProvider().generate(req(), 'm'),
    (err: any) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.code, 'QUOTA_EXHAUSTED');
      assert.equal(err.retryable, false);
      assert.ok(!err.message.includes('sk-test'));
      return true;
    }
  );
});

test('网络异常归一为可重试的 UPSTREAM_UNAVAILABLE', async () => {
  (globalThis as any).fetch = async () => { throw new Error('fetch failed: ECONNRESET'); };
  await assert.rejects(
    () => new DeepSeekProvider().generate(req(), 'm'),
    (err: any) => {
      assert.equal(err.code, 'UPSTREAM_UNAVAILABLE');
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

test('空 content 判为 EMPTY_RESPONSE（JSON 模式被替换成空格的情况）', async () => {
  stubFetch(200, { choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] });
  await assert.rejects(() => new DeepSeekProvider().generate(req(), 'm'), (err: any) => err.code === 'EMPTY_RESPONSE');
});

// ─── 能力边界 ────────────────────────────────────────────────────

test('视频 part 直接拒绝，不允许静默丢帧', async () => {
  const calls = stubFetch(200, okPayload);
  await assert.rejects(
    () => new DeepSeekProvider().generate(
      req({ capability: 'video_pass1', messages: [{ role: 'user', parts: [{ type: 'video', ref: { storage: 'gemini_files', fileRef: 'f', uri: 'u', mimeType: 'video/mp4', state: 'ready' } }] }] }),
      'deepseek-flash'
    ),
    (err: any) => err.code === 'INVALID_REQUEST'
  );
  assert.equal(calls.length, 0);
});

test('未配置 key 时 NOT_CONFIGURED，TTS 一律拒绝', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const p = new DeepSeekProvider();
  assert.equal(p.isConfigured(), false);
  await assert.rejects(() => p.generate(req(), 'm'), (err: any) => err.code === 'NOT_CONFIGURED');

  process.env.DEEPSEEK_API_KEY = 'sk-test';
  await assert.rejects(() => p.tts({ text: '你好' }, 'm'), (err: any) => err.code === 'NOT_CONFIGURED');
});
