import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// 必须在加载管道模块之前设置：测试不往线上任务日志里写
process.env.VIDEO_ANALYSIS_LOG_DISABLED = '1';

import { __setProviderForTest } from '../../llm/registry';
import type { GenerateRequest, LLMProvider, VideoRef, VideoStorage } from '../../llm';
import { loadAnalysisKnowledge } from '../analysisKnowledgeLoader';
import { createTrace, isTransientUploadError, runAnalysisPasses, uploadWithRetry } from '../pipeline';

const VIDEO: VideoRef = { storage: 'gemini_files', fileRef: 'files/x', uri: 'https://x', mimeType: 'video/mp4', state: 'ready' };

type Responder = (req: GenerateRequest, model: string) => { text: string; usage?: { inputTokens: number; outputTokens: number } };

/** 假的模型：按环节返回预设内容，并记录每次调用 */
function fakeProvider(respond: Responder) {
  const calls: { capability: string; model: string }[] = [];
  const provider: LLMProvider = {
    name: 'gemini',
    isConfigured: () => true,
    async generate(req, model) {
      calls.push({ capability: req.capability, model });
      return respond(req, model);
    },
    async tts() { throw new Error('not used'); },
  };
  return { provider, calls };
}

const PASS1_OK = JSON.stringify({ segments: [{ start: '00:00', end: '00:19', description: '多球训练' }], total_valid_seconds: 19 });
const pass15 = (id: string, confidence: number) => JSON.stringify({
  audio_transcript: '无可辨识语音', analysis_notes: 'n', primary_action_id: id, confidence,
  evidence: ['e'], top_candidates: [{ action_id: id, probability: confidence }], notable_missing_cues: [],
});
const PASS2_OK = JSON.stringify({
  techName: '反手拉球', summaryText: 's', problems: [{ text: '引拍未下沉、手腕僵硬', timestamp: '00:05' }], improvements: ['i'],
});

const savedLog = console.log;
before(() => {
  console.log = () => {};
  console.warn = () => {};
  loadAnalysisKnowledge();
  for (const k of Object.keys(process.env)) if (k.startsWith('LLM_')) delete process.env[k];
});
after(() => {
  console.log = savedLog;
  __setProviderForTest('gemini', undefined);
});

test('完整链路：trace 记录各环节的原始输出 / 模型 / token，action_id 被强制写成受信任的值，教程由调用方注入', async () => {
  const { provider, calls } = fakeProvider(req => {
    if (req.capability === 'video_pass1') return { text: PASS1_OK, usage: { inputTokens: 100, outputTokens: 10 } };
    if (req.capability === 'video_pass15') return { text: pass15('bh_loop', 0.92), usage: { inputTokens: 1000, outputTokens: 100 } };
    return { text: PASS2_OK, usage: { inputTokens: 500, outputTokens: 50 } };
  });
  __setProviderForTest('gemini', provider);

  const trace = createTrace('technique', 19);
  const { payload, model } = await runAnalysisPasses({
    jobId: 'test', video: VIDEO, analysisType: 'technique', videoDurationSec: 19, trace,
    deps: { recommendTutorials: id => [{ title: `教程-${id}`, url: 'https://t', ...({} as object) }] },
  });

  assert.deepEqual(calls.map(c => c.capability), ['video_pass1', 'video_pass15', 'video_pass2']);
  assert.equal(model, 'gemini-3.1-pro-preview');

  // 报告
  assert.equal(payload.reports.length, 1);
  assert.deepEqual(payload.reports[0].action_ids_detected, ['bh_loop']);
  assert.deepEqual(payload.reports[0].videoLinks, [{ title: '教程-bh_loop', url: 'https://t' }]);
  // 视频时长截断：原始结束 00:19 + 1 秒缓冲 = 00:20，被截到视频长度 00:19
  assert.deepEqual(payload.valid_segments, [{ start: '00:00', end: '00:19', description: '多球训练' }]);

  // trace
  assert.deepEqual(trace.pass1!.raw, JSON.parse(PASS1_OK));
  assert.deepEqual(trace.pass1!.segments, payload.valid_segments);
  assert.deepEqual(trace.pass1!.usage, { inputTokens: 100, outputTokens: 10 });
  assert.equal(trace.pass15!.result.primary_action_id, 'bh_loop');
  assert.equal(trace.pass15!.decision.status, 'confirmed');
  assert.equal(trace.pass15!.model, 'gemini-3.1-pro-preview');
  assert.deepEqual(trace.pass2!.usage, { inputTokens: 500, outputTokens: 50 });
  assert.equal((trace.pass2!.raw as any).techName, '反手拉球');
  assert.equal(typeof trace.timingsMs.passes, 'number');
  assert.equal(trace.error, undefined);
});

test('不注入教程依赖时不报错，报告里没有 videoLinks（评测脚本就是这样用的，不依赖数据库）', async () => {
  const { provider } = fakeProvider(req =>
    ({ text: req.capability === 'video_pass1' ? PASS1_OK : req.capability === 'video_pass15' ? pass15('bh_loop', 0.9) : PASS2_OK }));
  __setProviderForTest('gemini', provider);

  const { payload } = await runAnalysisPasses({ jobId: 't', video: VIDEO, analysisType: 'technique', trace: createTrace('technique') });
  assert.equal(payload.reports[0].videoLinks, undefined);
});

test('各环节的模型可以独立配置：Pass 1.5 / Pass 2 用各自的首选模型，且互不沿用', async () => {
  process.env.LLM_VIDEO_PASS1_MODELS = 'm-pass1';
  process.env.LLM_VIDEO_PASS15_MODELS = 'm-pass15';
  process.env.LLM_VIDEO_PASS2_MODELS = 'm-pass2';
  try {
    const { provider, calls } = fakeProvider(req =>
      ({ text: req.capability === 'video_pass1' ? PASS1_OK : req.capability === 'video_pass15' ? pass15('bh_loop', 0.9) : PASS2_OK }));
    __setProviderForTest('gemini', provider);

    const trace = createTrace('technique');
    await runAnalysisPasses({ jobId: 't', video: VIDEO, analysisType: 'technique', trace });
    assert.deepEqual(calls, [
      { capability: 'video_pass1', model: 'm-pass1' },
      { capability: 'video_pass15', model: 'm-pass15' },
      { capability: 'video_pass2', model: 'm-pass2' },
    ]);
    assert.deepEqual([trace.pass1!.model, trace.pass15!.model, trace.pass2!.model], ['m-pass1', 'm-pass15', 'm-pass2']);
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('LLM_')) delete process.env[k];
  }
});

test('非乒乓球视频：抛出 NO_VALID_SEGMENTS:not_table_tennis，已完成的 Pass 1 输出保留在 trace 里，不会进入后续环节', async () => {
  const { provider, calls } = fakeProvider(() => ({ text: JSON.stringify({ not_table_tennis: true, total_valid_seconds: 0, segments: [] }) }));
  __setProviderForTest('gemini', provider);

  const trace = createTrace('technique');
  await assert.rejects(
    runAnalysisPasses({ jobId: 't', video: VIDEO, analysisType: 'technique', trace }),
    /NO_VALID_SEGMENTS:not_table_tennis/,
  );
  assert.deepEqual(calls.map(c => c.capability), ['video_pass1']);
  assert.equal((trace.pass1!.raw as any).not_table_tennis, true);
  assert.equal(trace.pass15, undefined);
  assert.equal(typeof trace.timingsMs.passes, 'number'); // 失败时也记录已用时间
});

test('分类为 unknown：降级为「未识别技术动作」，跳过 Pass 2，不产生诊断', async () => {
  const { provider, calls } = fakeProvider(req => ({ text: req.capability === 'video_pass1' ? PASS1_OK : pass15('unknown', 0.2) }));
  __setProviderForTest('gemini', provider);

  const trace = createTrace('technique');
  const { payload } = await runAnalysisPasses({ jobId: 't', video: VIDEO, analysisType: 'technique', trace });
  assert.deepEqual(calls.map(c => c.capability), ['video_pass1', 'video_pass15']);
  assert.equal(payload.reports[0].techName, '未识别技术动作');
  assert.deepEqual(payload.reports[0].problems, []);
  assert.equal(trace.pass15!.decision.status, 'unknown');
  assert.equal(trace.pass2, undefined);
});

test('Pass 1 输出无法解析成 JSON：映射为 REPORT_PARSE_FAILED:pass1', async () => {
  const { provider } = fakeProvider(() => ({ text: '抱歉，我无法分析这个视频' }));
  __setProviderForTest('gemini', provider);
  process.env.LLM_VIDEO_PASS1_MAX_RETRIES = '0';
  process.env.LLM_VIDEO_PASS1_RETRY_DELAY_MS = '0';
  try {
    await assert.rejects(
      runAnalysisPasses({ jobId: 't', video: VIDEO, analysisType: 'technique', trace: createTrace('technique') }),
      /REPORT_PARSE_FAILED:pass1/,
    );
  } finally {
    delete process.env.LLM_VIDEO_PASS1_MAX_RETRIES;
    delete process.env.LLM_VIDEO_PASS1_RETRY_DELAY_MS;
  }
});

// ─── 上传重试 ────────────────────────────────────────────────────

test('isTransientUploadError：网络抖动 / 限流 / 5xx 视为临时性，文件本身的问题不是', () => {
  for (const msg of ['upload failed: fetch failed', 'read ECONNRESET', 'socket hang up', 'request timeout', '503 UNAVAILABLE', 'HTTP 429', 'The service is overloaded']) {
    assert.equal(isTransientUploadError(msg), true, msg);
  }
  for (const msg of ['INVALID_ARGUMENT: unsupported mime type', 'file is too large', 'ENOENT: no such file', '400 Bad Request']) {
    assert.equal(isTransientUploadError(msg), false, msg);
  }
});

function flakyStorage(failures: string[]) {
  let calls = 0;
  const storage = {
    name: 'gemini_files',
    async upload() {
      const err = failures[calls++];
      if (err) throw new Error(err);
      return VIDEO;
    },
    async waitReady(v: VideoRef) { return v; },
    async cleanup() {},
  } as unknown as VideoStorage;
  return { storage, count: () => calls };
}

test('uploadWithRetry：临时性错误重试后成功（对应线上出现过的 fetch failed）', async () => {
  const { storage, count } = flakyStorage(['upload failed: fetch failed', 'read ECONNRESET']);
  const retries: number[] = [];
  const video = await uploadWithRetry(storage, '/x.mp4', 'video/mp4', attempt => retries.push(attempt), [0, 0]);
  assert.equal(video, VIDEO);
  assert.equal(count(), 3);
  assert.deepEqual(retries, [1, 2]);
});

test('uploadWithRetry：非临时性错误不重试；重试用完后抛出最后一次的错误', async () => {
  const bad = flakyStorage(['INVALID_ARGUMENT: unsupported mime type']);
  await assert.rejects(uploadWithRetry(bad.storage, '/x', 'video/x', undefined, [0, 0]), /unsupported mime type/);
  assert.equal(bad.count(), 1);

  const down = flakyStorage(['fetch failed', 'fetch failed', 'fetch failed 最后一次']);
  await assert.rejects(uploadWithRetry(down.storage, '/x', 'video/x', undefined, [0, 0]), /最后一次/);
  assert.equal(down.count(), 3);
});
