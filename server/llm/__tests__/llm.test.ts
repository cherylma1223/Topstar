import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { generate, tts, isCapabilityAvailable, LLMError, type LLMProvider, type GenerateRequest } from '../index';
import { __setProviderForTest } from '../registry';
import { classifyGeminiError } from '../gemini/GeminiProvider';

// ─── 假 provider：按脚本依次返回结果或抛错 ─────────────────────────

type Step = { text: string } | { error: LLMError };

class FakeProvider implements LLMProvider {
  readonly name = 'gemini' as const;
  calls: string[] = [];
  constructor(private script: Record<string, Step[]>) {}
  isConfigured() { return true; }
  async generate(_req: GenerateRequest, model: string) {
    this.calls.push(model);
    const step = this.script[model]?.shift();
    if (!step) throw new Error(`no scripted step for ${model}`);
    if ('error' in step) throw step.error;
    return { text: step.text };
  }
  async tts(_req: any, model: string) {
    this.calls.push(model);
    const step = this.script[model]?.shift();
    if (step && 'error' in step) throw step.error;
    return { mimeType: 'audio/pcm', sampleRate: 24000, data: 'AAAA' };
  }
}

const err = (code: ConstructorParameters<typeof LLMError>[0]) => ({ error: new LLMError(code, 'test') });

function useModels(cap: string, models: string[], retries = 2) {
  process.env[`LLM_${cap}_MODELS`] = models.join(',');
  process.env[`LLM_${cap}_MAX_RETRIES`] = String(retries);
  process.env[`LLM_${cap}_RETRY_DELAY_MS`] = '1';
}

const req = (extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
  capability: 'video_pass1',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  ...extra,
});

const savedWarn = console.warn;
beforeEach(() => {
  console.warn = () => {};
  for (const k of Object.keys(process.env)) if (k.startsWith('LLM_')) delete process.env[k];
});
after(() => {
  console.warn = savedWarn;
  __setProviderForTest('gemini', undefined);
});

// ─── 降级与重试 ──────────────────────────────────────────────────

test('MODEL_UNAVAILABLE 降级到下一个模型，并返回实际命中的模型', async () => {
  const fake = new FakeProvider({ a: [err('MODEL_UNAVAILABLE')], b: [{ text: 'ok' }] });
  __setProviderForTest('gemini', fake);
  useModels('VIDEO_PASS1', ['a', 'b']);

  const r = await generate(req());
  assert.equal(r.text, 'ok');
  assert.equal(r.model, 'b');
  assert.deepEqual(fake.calls, ['a', 'b']);
});

test('所有模型都不可用时抛 MODEL_UNAVAILABLE', async () => {
  __setProviderForTest('gemini', new FakeProvider({ a: [err('MODEL_UNAVAILABLE')], b: [err('MODEL_UNAVAILABLE')] }));
  useModels('VIDEO_PASS1', ['a', 'b']);
  await assert.rejects(generate(req()), (e: unknown) => e instanceof LLMError && e.code === 'MODEL_UNAVAILABLE');
});

test('临时性错误在同一模型上重试，不降级', async () => {
  const fake = new FakeProvider({ a: [err('RATE_LIMITED'), err('UPSTREAM_UNAVAILABLE'), { text: 'ok' }] });
  __setProviderForTest('gemini', fake);
  useModels('VIDEO_PASS1', ['a', 'b'], 2);

  const r = await generate(req());
  assert.equal(r.model, 'a');
  assert.deepEqual(fake.calls, ['a', 'a', 'a']);
});

test('超过重试次数后抛出原错误', async () => {
  __setProviderForTest('gemini', new FakeProvider({ a: [err('RATE_LIMITED'), err('RATE_LIMITED')] }));
  useModels('VIDEO_PASS1', ['a'], 1);
  await assert.rejects(generate(req()), (e: unknown) => e instanceof LLMError && e.code === 'RATE_LIMITED');
});

test('INVALID_REQUEST 不重试也不降级', async () => {
  const fake = new FakeProvider({ a: [err('INVALID_REQUEST')], b: [{ text: 'ok' }] });
  __setProviderForTest('gemini', fake);
  useModels('VIDEO_PASS1', ['a', 'b'], 3);
  await assert.rejects(generate(req()), (e: unknown) => e instanceof LLMError && e.code === 'INVALID_REQUEST');
  assert.deepEqual(fake.calls, ['a']);
});

test('QUOTA_EXHAUSTED（402 额度耗尽）不重试也不降级，立即失败', async () => {
  const fake = new FakeProvider({ a: [err('QUOTA_EXHAUSTED')], b: [{ text: 'ok' }] });
  __setProviderForTest('gemini', fake);
  useModels('VIDEO_PASS1', ['a', 'b'], 3);
  await assert.rejects(generate(req()), (e: unknown) => e instanceof LLMError && e.code === 'QUOTA_EXHAUSTED' && !e.retryable);
  assert.deepEqual(fake.calls, ['a']);
});

// ─── 结构化输出 ──────────────────────────────────────────────────

const SCHEMA = {
  type: 'object' as const,
  properties: { segments: { type: 'array' as const }, total: { type: 'number' as const } },
  required: ['segments', 'total'],
};

test('JSON 解析失败时即使 maxRetries=0 也重试一次', async () => {
  const fake = new FakeProvider({ a: [{ text: '抱歉，我无法' }, { text: '```json\n{"segments":[],"total":0}\n```' }] });
  __setProviderForTest('gemini', fake);
  useModels('VIDEO_PASS1', ['a'], 0);

  const r = await generate(req({ responseSchema: SCHEMA }));
  assert.deepEqual(r.json, { segments: [], total: 0 });
  assert.equal(r.schemaErrors, undefined);
  assert.deepEqual(fake.calls, ['a', 'a']);
});

test('Schema 校验不通过时不抛错，返回 schemaErrors；数组自动纠正为对象', async () => {
  __setProviderForTest('gemini', new FakeProvider({ a: [{ text: '[{"segments":[]}]' }] }));
  useModels('VIDEO_PASS1', ['a'], 0);

  const r = await generate(req({ responseSchema: SCHEMA }));
  assert.deepEqual(r.json, { segments: [] });
  assert.deepEqual(r.schemaErrors, ['$.total: required']);
});

test('要求 JSON 但返回空文本时按 EMPTY_RESPONSE 重试', async () => {
  const fake = new FakeProvider({ a: [{ text: '' }, { text: '{"segments":[],"total":1}' }] });
  __setProviderForTest('gemini', fake);
  useModels('VIDEO_PASS1', ['a'], 1);
  const r = await generate(req({ responseSchema: SCHEMA }));
  assert.deepEqual(r.json, { segments: [], total: 1 });
});

test('不要求 JSON 时空文本原样返回（与迁移前 chat 行为一致）', async () => {
  __setProviderForTest('gemini', new FakeProvider({ a: [{ text: '' }] }));
  useModels('CHAT', ['a'], 0);
  const r = await generate(req({ capability: 'chat' }));
  assert.equal(r.text, '');
});

// ─── TTS / 可用性 ────────────────────────────────────────────────

test('tts 返回音频并带上 provider / model', async () => {
  __setProviderForTest('gemini', new FakeProvider({ t1: [err('MODEL_UNAVAILABLE')] }));
  useModels('TTS', ['t1', 't2'], 0);
  const a = await tts({ text: '你好' });
  assert.equal(a.model, 't2');
  assert.equal(a.provider, 'gemini');
  assert.equal(a.mimeType, 'audio/pcm');
});

test('isCapabilityAvailable：cn 区域未配置时为 false', () => {
  process.env.DEPLOY_REGION = 'cn';
  assert.equal(isCapabilityAvailable('chat'), false);
  delete process.env.DEPLOY_REGION;
  assert.equal(isCapabilityAvailable('chat'), true); // 假 provider isConfigured=true
});

// ─── Gemini 错误归一（样本取自 analysis_jobs 历史失败记录）────────

test('classifyGeminiError 覆盖历史失败样本', () => {
  const notFound = '{"error":{"code":404,"message":"models/gemini-2.5-pro-preview-05-06 is not found for API version v1beta, or is not supported for generateContent.","status":"NOT_FOUND"}}';
  assert.equal(classifyGeminiError(new Error(notFound)), 'MODEL_UNAVAILABLE');
  assert.equal(classifyGeminiError(new Error('{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}')), 'UPSTREAM_UNAVAILABLE');
  // 真实线上样本：额度耗尽的 status 同样是 RESOURCE_EXHAUSTED，必须和 429 限流区分开
  const quota = '{"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}';
  assert.equal(classifyGeminiError(new Error(quota)), 'QUOTA_EXHAUSTED');
  assert.equal(classifyGeminiError(Object.assign(new Error('x'), { status: 402 })), 'QUOTA_EXHAUSTED');
  assert.equal(classifyGeminiError(new Error('{"error":{"code":429,"message":"rate","status":"RESOURCE_EXHAUSTED"}}')), 'RATE_LIMITED');
  assert.equal(classifyGeminiError(new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}')), 'INVALID_REQUEST');
  assert.equal(classifyGeminiError(new Error('fetch failed')), 'UPSTREAM_UNAVAILABLE');
  assert.equal(classifyGeminiError(Object.assign(new Error('quota'), { status: 429 })), 'RATE_LIMITED');
  assert.equal(classifyGeminiError(Object.assign(new Error('denied'), { status: 403 })), 'AUTH_FAILED');
  assert.equal(classifyGeminiError(new Error('something odd')), 'UNKNOWN');
});
