import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCapabilityConfig, getVideoStorageName } from '../config';
import { LLMError } from '../errors';

const ENV_KEYS = [
  'DEPLOY_REGION', 'VIDEO_STORAGE',
  'LLM_CHAT_PROVIDER', 'LLM_CHAT_MODELS', 'LLM_CHAT_MAX_RETRIES', 'LLM_CHAT_RETRY_DELAY_MS',
  'LLM_VIDEO_PASS15_MODELS', 'LLM_INTENT_PROVIDER', 'LLM_INTENT_MODELS',
  'LLM_TTS_PROVIDER', 'LLM_TTS_MODELS',
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

test('global 默认配置：视频链首选 4-argon，Pass 1.5 不含 3.8-flash，TTS 默认千问', () => {
  assert.deepEqual(getCapabilityConfig('chat').models, ['gemini-3-flash-preview']);
  assert.equal(getCapabilityConfig('chat').retry.maxRetries, 3);
  assert.equal(getCapabilityConfig('intent').retry.maxRetries, 0);

  assert.deepEqual(getCapabilityConfig('video_pass1').models, ['gemini-4-argon', 'gemini-3.1-pro-preview', 'gemini-3.8-flash']);
  assert.deepEqual(getCapabilityConfig('video_pass2').models, ['gemini-4-argon', 'gemini-3.1-pro-preview', 'gemini-3.8-flash']);
  // gemini-3.8-flash 在测评里把反手拉球判成正手，不能兜底 Pass 1.5
  assert.deepEqual(getCapabilityConfig('video_pass15').models, ['gemini-4-argon', 'gemini-3.1-pro-preview']);
  // gemini-2.5-pro / 2.5-flash 2026-12-01 停用，且请求会被自动改道，不能再出现在降级链里
  for (const cap of ['video_pass1', 'video_pass15', 'video_pass2'] as const) {
    assert.equal(getCapabilityConfig(cap).models.some(m => m.includes('2.5')), false, cap);
  }

  const tts = getCapabilityConfig('tts');
  assert.equal(tts.provider, 'dashscope');
  assert.deepEqual(tts.models, ['qwen-audio-3.1-tts-flash']);

  assert.equal(getVideoStorageName(), 'gemini_files');
});

test('TTS 切回 Gemini：只改 provider 也用 Gemini 自己的型号，不把千问的模型名发给 Google', () => {
  process.env.LLM_TTS_PROVIDER = 'gemini';
  assert.deepEqual(getCapabilityConfig('tts').models, ['gemini-3.8-flash-tts']);

  process.env.LLM_TTS_MODELS = 'my-tts';  // 显式指定优先
  assert.deepEqual(getCapabilityConfig('tts').models, ['my-tts']);
});

test('只改 provider、且该 provider 没有预置型号时报 NOT_CONFIGURED，指定 models 后恢复', () => {
  process.env.LLM_CHAT_PROVIDER = 'deepseek';
  assert.throws(() => getCapabilityConfig('chat'), (e: unknown) => e instanceof LLMError && e.code === 'NOT_CONFIGURED');

  process.env.LLM_CHAT_MODELS = 'deepseek-chat';
  assert.deepEqual(getCapabilityConfig('chat').models, ['deepseek-chat']);
});

test('环境变量逐项覆盖模型、重试次数和重试间隔', () => {
  process.env.LLM_CHAT_MODELS = 'm1, m2 ,m1';
  process.env.LLM_CHAT_MAX_RETRIES = '0';
  process.env.LLM_CHAT_RETRY_DELAY_MS = '5';
  const cfg = getCapabilityConfig('chat');
  assert.deepEqual(cfg.models, ['m1', 'm2']);
  assert.equal(cfg.retry.maxRetries, 0);
  assert.equal(cfg.retry.initialDelayMs, 5);
});

test('DEPLOY_REGION=cn 未接入国内 provider 前报 NOT_CONFIGURED，可用环境变量显式指定', () => {
  process.env.DEPLOY_REGION = 'cn';
  assert.throws(() => getCapabilityConfig('chat'), (e: unknown) => e instanceof LLMError && e.code === 'NOT_CONFIGURED');
  assert.throws(() => getVideoStorageName(), (e: unknown) => e instanceof LLMError && e.code === 'NOT_CONFIGURED');

  process.env.LLM_INTENT_PROVIDER = 'gemini';
  process.env.LLM_INTENT_MODELS = 'x';
  assert.deepEqual(getCapabilityConfig('intent').models, ['x']);
});
