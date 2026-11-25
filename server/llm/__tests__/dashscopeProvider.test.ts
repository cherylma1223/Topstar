import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DashScopeProvider,
  classifyDashscopeGenerateError,
  dashscopeBaseUrl,
} from '../dashscope/DashScopeProvider';
import type { GenerateRequest, VideoRef } from '../types';

const realFetch = globalThis.fetch;
const VIDEO: VideoRef = {
  storage: 'gemini_files',
  fileRef: 'videos/a.mp4',
  uri: 'https://oss.example.com/a.mp4?sig=1',
  mimeType: 'video/mp4',
  state: 'ready',
};

interface Call { url: string; init: any; body: any }

function stubFetch(reply: { status?: number; body?: unknown } = {}): Call[] {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return {
      ok: (reply.status ?? 200) < 300,
      status: reply.status ?? 200,
      text: async () => JSON.stringify(reply.body ?? {
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1200, completion_tokens: 80 },
      }),
    };
  };
  return calls;
}

const videoReq = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  capability: 'video_pass1',
  system: 'sys',
  messages: [{
    role: 'user',
    parts: [{ type: 'text', text: '请看这段视频' }, { type: 'video', ref: VIDEO, fps: 2 }],
  }],
  responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  traceId: 'job-1',
  ...over,
});

const DASH_ENV = [
  'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL', 'DASHSCOPE_TIMEOUT_MS', 'DASHSCOPE_MAX_TOKENS', 'DASHSCOPE_THINKING',
  'LLM_VIDEO_PASS1_PROVIDER', 'LLM_VIDEO_PASS1_MODELS', 'LLM_VIDEO_PASS1_MAX_RETRIES',
];

beforeEach(() => {
  for (const k of DASH_ENV) delete process.env[k];
  process.env.DASHSCOPE_API_KEY = 'sk-test';
});

afterEach(() => {
  (globalThis as any).fetch = realFetch;
  for (const k of DASH_ENV) delete process.env[k];
});

test('generate：视频走 video_url + 同级 fps，JSON 模式、关思考、带鉴权', async () => {
  const calls = stubFetch();
  const out = await new DashScopeProvider().generate(videoReq(), 'qwen3.8-max');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  const body = calls[0].body;
  assert.equal(body.model, 'qwen3.8-max');
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.enable_thinking, false, '视频环节默认关思考');
  assert.equal(body.messages[0].role, 'system');
  const content = body.messages[1].content;
  assert.equal(content[0].type, 'text');
  assert.deepEqual(content[1], { type: 'video_url', video_url: { url: VIDEO.uri }, fps: 2 });

  assert.equal(out.text, '{"ok":true}');
  assert.deepEqual(out.usage, { inputTokens: 1200, outputTokens: 80 });
});

test('纯文本：content 压成字符串；chat 用服务端默认思考开关，intent 关掉', async () => {
  let calls = stubFetch();
  await new DashScopeProvider().generate({ capability: 'chat', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }, { type: 'text', text: '在吗' }] }] }, 'm');
  assert.equal(calls[0].body.messages[0].content, 'hi\n\n在吗');
  assert.equal('enable_thinking' in calls[0].body, false);

  calls = stubFetch();
  await new DashScopeProvider().generate({ capability: 'intent', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }, 'm');
  assert.equal(calls[0].body.enable_thinking, false);

  process.env.DASHSCOPE_THINKING = 'enabled';
  calls = stubFetch();
  await new DashScopeProvider().generate({ capability: 'video_pass2', messages: [{ role: 'user', parts: [{ type: 'video', ref: VIDEO, fps: 5 }] }] }, 'm');
  assert.equal(calls[0].body.enable_thinking, true, '环境变量可强制打开');
});

test('DASHSCOPE_BASE_URL 覆盖并去掉尾部斜杠；DASHSCOPE_MAX_TOKENS 生效', async () => {
  process.env.DASHSCOPE_BASE_URL = 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/';
  process.env.DASHSCOPE_MAX_TOKENS = '2048';
  assert.equal(dashscopeBaseUrl(), 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');

  const calls = stubFetch();
  await new DashScopeProvider().generate({ capability: 'chat', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }, 'm');
  assert.equal(calls[0].url, 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(calls[0].body.max_tokens, 2048);
});

test('视频未 ready 或不是公网 URL 时不发请求，直接报 INVALID_REQUEST', async () => {
  const calls = stubFetch();
  const provider = new DashScopeProvider();

  await assert.rejects(
    () => provider.generate(videoReq({ messages: [{ role: 'user', parts: [{ type: 'video', ref: { ...VIDEO, state: 'processing' }, fps: 2 }] }] }), 'm'),
    (err: any) => err.code === 'INVALID_REQUEST' && err.message.includes('processing')
  );
  await assert.rejects(
    () => provider.generate(videoReq({ messages: [{ role: 'user', parts: [{ type: 'video', ref: { ...VIDEO, uri: 'file:///tmp/a.mp4' }, fps: 2 }] }] }), 'm'),
    (err: any) => err.code === 'INVALID_REQUEST' && err.message.includes('oss://')
  );
  assert.equal(calls.length, 0);
});

test('oss:// 视频地址放行，并带上 X-DashScope-OssResourceResolve 头；http 地址不带', async () => {
  const provider = new DashScopeProvider();
  const ossReq = videoReq({ messages: [{ role: 'user', parts: [{ type: 'video', ref: { ...VIDEO, uri: 'oss://dashscope-data/x/a.mp4' }, fps: 2 }] }] });

  let calls = stubFetch();
  await provider.generate(ossReq, 'm');
  assert.equal(calls[0].init.headers['X-DashScope-OssResourceResolve'], 'enable');
  assert.equal(calls[0].body.messages[1].content[0].video_url.url, 'oss://dashscope-data/x/a.mp4');

  calls = stubFetch();
  await provider.generate(videoReq(), 'm');
  assert.equal('X-DashScope-OssResourceResolve' in calls[0].init.headers, false);
});

test('fps 越界夹到 0.1–10', async () => {
  const provider = new DashScopeProvider();
  const cases: Array<[number, number]> = [[30, 10], [0.01, 0.1], [5, 5]];
  for (const [input, expected] of cases) {
    const calls = stubFetch();
    await provider.generate(videoReq({ messages: [{ role: 'user', parts: [{ type: 'video', ref: VIDEO, fps: input }] }] }), 'm');
    assert.equal(calls[0].body.messages[1].content[0].fps, expected);
  }
});

test('classifyDashscopeGenerateError：常见状态的归一', () => {
  assert.equal(classifyDashscopeGenerateError(401, 'InvalidApiKey'), 'AUTH_FAILED');
  assert.equal(classifyDashscopeGenerateError(403, 'Arrearage'), 'QUOTA_EXHAUSTED');
  assert.equal(classifyDashscopeGenerateError(404, 'model not found'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyDashscopeGenerateError(429, 'Throttling'), 'RATE_LIMITED');
  assert.equal(classifyDashscopeGenerateError(500, 'internal error'), 'UPSTREAM_UNAVAILABLE');
  assert.equal(classifyDashscopeGenerateError(400, 'download video failed'), 'INVALID_REQUEST');
  assert.equal(classifyDashscopeGenerateError(400, 'DataInspectionFailed'), 'INVALID_REQUEST');
});

test('接口报错时抛对应 LLMError，且不泄露 key', async () => {
  const cases: Array<[number, string]> = [[404, 'MODEL_UNAVAILABLE'], [429, 'RATE_LIMITED'], [503, 'UPSTREAM_UNAVAILABLE'], [401, 'AUTH_FAILED']];
  for (const [status, code] of cases) {
    stubFetch({ status, body: { error: { message: 'nope' } } });
    await assert.rejects(
      () => new DashScopeProvider().generate(videoReq(), 'm'),
      (err: any) => {
        assert.equal(err.code, code);
        assert.ok(!err.message.includes('sk-test'));
        return true;
      }
    );
  }
});

test('响应里 content 为空 → EMPTY_RESPONSE', async () => {
  stubFetch({ body: { choices: [{ message: { content: '  ' }, finish_reason: 'length' }] } });
  await assert.rejects(
    () => new DashScopeProvider().generate(videoReq(), 'm'),
    (err: any) => err.code === 'EMPTY_RESPONSE' && err.message.includes('length')
  );
});

test('未配置 key 时 isConfigured 为 false，generate 报 NOT_CONFIGURED', async () => {
  delete process.env.DASHSCOPE_API_KEY;
  const provider = new DashScopeProvider();
  assert.equal(provider.isConfigured(), false);
  await assert.rejects(() => provider.generate(videoReq(), 'm'), (err: any) => err.code === 'NOT_CONFIGURED');
});

test('tts 委托给 Qwen 实现（同一把 key，走 SpeechSynthesizer 端点）', async () => {
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    if (url.includes('SpeechSynthesizer')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ output: { audio: { url: 'https://oss.example.com/a.pcm' } } }),
      };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const out = await new DashScopeProvider().tts({ text: '你好' }, 'qwen-audio-3.1-tts-flash');
  assert.equal(out.mimeType, 'audio/pcm');
  assert.equal(calls[0], 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
});

test('门面集成：provider 配成 dashscope 时按降级链切模型，JSON 正常解析', async () => {
  process.env.LLM_VIDEO_PASS1_PROVIDER = 'dashscope';
  process.env.LLM_VIDEO_PASS1_MODELS = 'qwen3.8-max,qwen3.8-flash';
  process.env.LLM_VIDEO_PASS1_MAX_RETRIES = '0';
  const { generate } = await import('../index');

  let n = 0;
  (globalThis as any).fetch = async () => {
    n++;
    if (n === 1) return { ok: false, status: 404, text: async () => '{"error":{"message":"model not found"}}' };
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }),
    };
  };

  const out = await generate(videoReq());
  assert.equal(n, 2, '第一个模型不可用后降级到第二个');
  assert.equal(out.provider, 'dashscope');
  assert.equal(out.model, 'qwen3.8-flash');
  assert.deepEqual(out.json, { ok: true });
  assert.equal(out.schemaErrors, undefined);
});
