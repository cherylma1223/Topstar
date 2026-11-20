import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  QwenTtsProvider,
  classifyDashscopeError,
  resolveQwenVoice,
} from '../dashscope/QwenTtsProvider';

const realFetch = globalThis.fetch;
const PCM = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

interface Call { url: string; init: any; body: any }

function stubFetch(opts: { synthStatus?: number; synthBody?: unknown; audioStatus?: number; audioBytes?: Uint8Array } = {}): Call[] {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.includes('SpeechSynthesizer')) {
      return {
        ok: (opts.synthStatus ?? 200) < 300,
        status: opts.synthStatus ?? 200,
        text: async () => JSON.stringify(opts.synthBody ?? {
          output: { audio: { url: 'https://oss.example.com/a.pcm' }, finish_reason: 'stop' },
          usage: { characters: 12, input_tokens: 11, output_tokens: 30 },
        }),
      };
    }
    return {
      ok: (opts.audioStatus ?? 200) < 300,
      status: opts.audioStatus ?? 200,
      arrayBuffer: async () => (opts.audioBytes ?? PCM).buffer,
    };
  };
  return calls;
}

beforeEach(() => {
  process.env.DASHSCOPE_API_KEY = 'sk-test';
  delete process.env.DASHSCOPE_TTS_VOICE;
  delete process.env.DASHSCOPE_TTS_ENDPOINT;
});

afterEach(() => {
  (globalThis as any).fetch = realFetch;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_TTS_VOICE;
});

test('tts：请求体与鉴权正确，返回 PCM base64', async () => {
  const calls = stubFetch();
  const out = await new QwenTtsProvider().tts({ text: '你好，我是您的私人教练。' }, 'qwen-audio-3.1-tts-flash');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.equal(calls[0].body.model, 'qwen-audio-3.1-tts-flash');
  assert.equal(calls[0].body.input.voice, 'longhua_v3.1');
  assert.equal(calls[0].body.input.format, 'pcm');
  assert.equal(calls[0].body.input.sample_rate, 24000);
  assert.equal(calls[1].url, 'https://oss.example.com/a.pcm');

  assert.equal(out.mimeType, 'audio/pcm');
  assert.equal(out.sampleRate, 24000);
  assert.equal(Buffer.from(out.data, 'base64').length, PCM.length);
});

test('tts：Gemini 音色名（Kore）回落到默认音色，环境变量可覆盖', async () => {
  let calls = stubFetch();
  await new QwenTtsProvider().tts({ text: 'hi', voice: 'Kore' }, 'm');
  assert.equal(calls[0].body.input.voice, 'longhua_v3.1');

  process.env.DASHSCOPE_TTS_VOICE = 'longxiaochun_v3.1';
  calls = stubFetch();
  await new QwenTtsProvider().tts({ text: 'hi' }, 'm');
  assert.equal(calls[0].body.input.voice, 'longxiaochun_v3.1');
});

test('resolveQwenVoice：只认音色 ID 形态', () => {
  assert.equal(resolveQwenVoice('longhua_v3.1'), 'longhua_v3.1');
  assert.equal(resolveQwenVoice('Kore'), 'longhua_v3.1');
  assert.equal(resolveQwenVoice(undefined), 'longhua_v3.1');
});

test('classifyDashscopeError：常见状态的归一', () => {
  assert.equal(classifyDashscopeError(401, 'invalid api key'), 'AUTH_FAILED');
  assert.equal(classifyDashscopeError(429, 'throttling'), 'RATE_LIMITED');
  assert.equal(classifyDashscopeError(500, 'internal'), 'UPSTREAM_UNAVAILABLE');
  assert.equal(classifyDashscopeError(400, 'InvalidParameter'), 'INVALID_REQUEST');
  assert.equal(classifyDashscopeError(400, 'model not exist'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyDashscopeError(403, 'Arrearage'), 'QUOTA_EXHAUSTED');
});

test('接口报错时抛 LLMError，且不泄露 key', async () => {
  stubFetch({ synthStatus: 429, synthBody: { code: 'Throttling', message: 'too many requests' } });
  await assert.rejects(
    () => new QwenTtsProvider().tts({ text: 'hi' }, 'm'),
    (err: any) => {
      assert.equal(err.code, 'RATE_LIMITED');
      assert.ok(!err.message.includes('sk-test'));
      return true;
    }
  );
});

test('响应缺少 audio.url → EMPTY_RESPONSE；音频下载失败 → UPSTREAM_UNAVAILABLE', async () => {
  stubFetch({ synthBody: { output: { audio: {} }, usage: {} } });
  await assert.rejects(() => new QwenTtsProvider().tts({ text: 'hi' }, 'm'), (err: any) => err.code === 'EMPTY_RESPONSE');

  stubFetch({ audioStatus: 503 });
  await assert.rejects(() => new QwenTtsProvider().tts({ text: 'hi' }, 'm'), (err: any) => err.code === 'UPSTREAM_UNAVAILABLE');
});

test('未配置 key 时 NOT_CONFIGURED；generate 明确拒绝', async () => {
  delete process.env.DASHSCOPE_API_KEY;
  const p = new QwenTtsProvider();
  assert.equal(p.isConfigured(), false);
  await assert.rejects(() => p.tts({ text: 'hi' }, 'm'), (err: any) => err.code === 'NOT_CONFIGURED');

  process.env.DASHSCOPE_API_KEY = 'sk-test';
  await assert.rejects(
    () => p.generate({ capability: 'chat', messages: [] }, 'm'),
    (err: any) => err.code === 'NOT_CONFIGURED'
  );
});
