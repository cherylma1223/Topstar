import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCapabilityConfig, getVideoStorageName } from '../config';
import { LLMError } from '../errors';

const ENV_KEYS = [
  'DEPLOY_REGION', 'VIDEO_STORAGE',
  'LLM_CHAT_PROVIDER', 'LLM_CHAT_MODELS', 'LLM_CHAT_MAX_RETRIES', 'LLM_CHAT_RETRY_DELAY_MS',
  'LLM_VIDEO_PASS15_MODELS', 'LLM_INTENT_PROVIDER', 'LLM_INTENT_MODELS',
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

test('global 默认配置与迁移前线上行为一致', () => {
  assert.deepEqual(getCapabilityConfig('chat').models, ['gemini-3-flash-preview']);
  assert.equal(getCapabilityConfig('chat').retry.maxRetries, 3);
  assert.equal(getCapabilityConfig('intent').retry.maxRetries, 0);
  assert.deepEqual(getCapabilityConfig('video_pass1').models, ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash']);
  assert.deepEqual(getCapabilityConfig('tts').models, ['gemini-2.5-flash-preview-tts']);
  assert.equal(getVideoStorageName(), 'gemini_files');
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
