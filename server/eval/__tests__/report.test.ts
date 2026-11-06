import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, errorKey, renderCompare, renderReport, type Pricing } from '../lib/report';
import type { EvalResults, RunRecord, VideoResult } from '../lib/types';

const RULES = {
  rulesByAction: {
    bh_loop: [
      { issue_id: 'bh_loop_a', evidence: '引拍未下沉、手腕僵硬', problem: '拉球没转，总是撞击过多' },
      { issue_id: 'bh_loop_b', evidence: '仅用手臂发力、无核心参与', problem: '发不出力，球的威力小' },
    ],
  },
};

const decision = (status: 'confirmed' | 'unknown', id: string) => ({ status, validated_action_id: id });
const cls = (id: string, confidence: number) => ({
  primary_action_id: id, confidence, evidence: [], top_candidates: [], notable_missing_cues: [], audio_transcript: '', analysis_notes: '',
});

/** 一次成功运行：Pass 1（原始 00:00-00:19，校验后 00:00-00:20）→ Pass 1.5 → Pass 2 */
function okRun(opts: { predicted: string; confidence: number; problems: string[]; passesMs: number; pass2SchemaErrors?: string[] }): RunRecord {
  return {
    ok: true,
    trace: {
      analysisType: 'technique',
      timingsMs: { passes: opts.passesMs, total: opts.passesMs },
      pass1: {
        model: 'm', durationMs: 1000, usage: { inputTokens: 100, outputTokens: 10 },
        raw: { segments: [{ start: '00:00', end: '00:19' }] },
        segments: [{ start: '00:00', end: '00:20' }],
      },
      pass15: {
        model: 'm', durationMs: 1500, usage: { inputTokens: 1000, outputTokens: 100 },
        result: cls(opts.predicted, opts.confidence), decision: decision('confirmed', opts.predicted),
      },
      pass2: {
        model: 'm', durationMs: 500, usage: { inputTokens: 500, outputTokens: 50 }, schemaErrors: opts.pass2SchemaErrors,
        raw: { techName: 't', problems: opts.problems.map(text => ({ text, timestamp: '00:05' })), improvements: [] },
      },
    },
  };
}

function build(label: string, repeat = 2): EvalResults {
  const A: VideoResult = {
    videoId: 'A', videoFile: 'a.mov', durationSec: 20, storage: 'gemini_files', uploadMs: 5000, readyMs: 3000,
    gold: { actionId: 'bh_loop', segments: [{ start: 0, end: 20 }], issues: ['bh_loop_a'], tags: [] },
    runs: [
      okRun({ predicted: 'bh_loop', confidence: 0.95, problems: ['引拍未下沉、手腕僵硬，拉球没转'], passesMs: 3000 }),
      okRun({ predicted: 'fh_loop', confidence: 0.95, problems: ['别的问题'], passesMs: 4000, pass2SchemaErrors: ['$.problems: expected array'] }),
    ],
  };
  const B: VideoResult = {
    videoId: 'B', videoFile: 'b.mov', durationSec: 5, storage: 'gemini_files', uploadMs: 4000, readyMs: 1000,
    gold: { actionId: 'bh_drive', tags: [] },
    runs: [{
      ok: false,
      error: 'NO_VALID_SEGMENTS:not_table_tennis',
      trace: {
        analysisType: 'technique', timingsMs: { passes: 800 },
        pass1: { model: 'm', durationMs: 800, raw: { not_table_tennis: true, segments: [] }, segments: [] },
        error: 'NO_VALID_SEGMENTS:not_table_tennis',
      },
    }],
  };
  const C: VideoResult = { videoId: 'C', videoFile: 'c.mov', gold: { tags: [] }, skipped: '视频文件不存在', runs: [] };
  return {
    schemaVersion: 1, label, startedAt: '2026-11-06T00:00:00.000Z', finishedAt: '2026-11-06T00:10:00.000Z', gitCommit: 'abc1234',
    config: { pass1Models: ['m'], pass15Models: ['m'], pass2Models: ['m'], region: 'global', storage: 'gemini_files', repeat },
    videos: [A, B, C],
  };
}

const close = (a: number | undefined, b: number, eps = 1e-9) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('computeMetrics：分类准确率、自信地错、混淆、失败分布', () => {
  const m = computeMetrics(build('t'), RULES);
  assert.equal(m.videosTotal, 3);
  assert.equal(m.videosEvaluated, 2); // C 被跳过
  assert.equal(m.runs, 3);
  close(m.successRate, 2 / 3);
  assert.deepEqual(m.errors, { 'NO_VALID_SEGMENTS:not_table_tennis': 1 });

  const c = m.classification;
  assert.equal(c.evaluatedRuns, 3);          // A×2 + B×1（失败也计入分母）
  close(c.accuracyAll, 1 / 3);
  assert.equal(c.answeredRuns, 2);
  close(c.accuracyAnswered, 1 / 2);
  assert.deepEqual(c.highConfWrong, [{ videoId: 'A', gold: 'bh_loop', predicted: 'fh_loop', confidence: 0.95 }]);
  assert.deepEqual(c.confusion, { 'bh_loop → fh_loop': 1, 'bh_drive → （失败）': 1 });
  close(c.meanConfCorrect, 0.95);
  close(c.meanConfWrong, 0.95);
});

test('computeMetrics：片段 IoU / 边界误差（原始输出 vs 系统校验后）', () => {
  const s = computeMetrics(build('t'), RULES).segments;
  assert.equal(s.evaluatedRuns, 2);
  close(s.iouRaw, 19 / 20);   // 模型原始 00:00-00:19，标注 00:00-00:20
  close(s.iouValidated, 1);   // 系统加 1 秒缓冲后正好是 00:00-00:20
  close(s.startMeanAbsError, 0);
  close(s.endMeanAbsError, 1);
  close(s.endBias, -1);
  assert.equal(s.missedGold, 0);
});

test('computeMetrics：诊断只评「动作判对」的运行', () => {
  const d = computeMetrics(build('t'), RULES).diagnosis;
  assert.equal(d.evaluatedRuns, 1); // A 的第 2 次判成 fh_loop，诊断的是另一个动作，不计入
  assert.equal(d.precision, 1);
  assert.equal(d.recall, 1);
  assert.equal(d.f1, 1);
  assert.equal(d.extraProblemsPerRun, 0);
});

test('computeMetrics：Schema 通过率按「各环节被执行的次数」统计', () => {
  const s = computeMetrics(build('t'), RULES).schema;
  assert.deepEqual(s.pass1, { executed: 3, passed: 3 });
  assert.deepEqual(s.pass15, { executed: 2, passed: 2 }); // B 的片段为空，没走到 Pass 1.5
  assert.deepEqual(s.pass2, { executed: 2, passed: 1 });  // A 第 2 次 Schema 校验未通过
  close(s.overall, 6 / 7);
});

test('computeMetrics：稳定性、耗时分位数、端到端估算、token、费用', () => {
  const pricing: Pricing = { m: { inputPerMTok: 1, outputPerMTok: 2, currency: 'USD' } };
  const m = computeMetrics(build('t'), RULES, pricing);

  assert.deepEqual(
    { n: m.stability.videosWithRepeats, agree: m.stability.fullyAgreeVideos, mean: m.stability.meanAgreement },
    { n: 1, agree: 0, mean: 0.5 },
  );

  // 成功运行 A×2：3000ms、4000ms
  assert.equal(m.latency.passes.n, 2);
  close(m.latency.passes.p50, 3500);
  close(m.latency.passes.p95, 3950);
  // 端到端 = 模型耗时 + 该视频上传/等待就绪（5000+3000）
  close(m.latency.e2eEstimate.p50, 11500);
  // 上传每个视频只算一次：A=8000，B=5000
  assert.equal(m.latency.upload.n, 2);
  close(m.latency.upload.mean, 6500);

  close(m.tokens.perRunInput, 1600);
  close(m.tokens.perRunOutput, 160);
  close(m.cost.perRun, (1600 * 1 + 160 * 2) / 1_000_000);
  assert.equal(m.cost.currency, 'USD');
  assert.deepEqual(m.cost.missingPrice, []);
});

test('computeMetrics：没有价格表时不计算费用，并列出缺价格的模型', () => {
  const m = computeMetrics(build('t'), RULES);
  assert.equal(m.cost.perRun, undefined);
  assert.deepEqual(m.cost.missingPrice, ['m']);
});

test('errorKey：保留有意义的后缀，丢掉冗长细节', () => {
  assert.equal(errorKey('NO_VALID_SEGMENTS:not_table_tennis'), 'NO_VALID_SEGMENTS:not_table_tennis');
  assert.equal(errorKey('NO_VALID_SEGMENTS:unanalyzable (画面全黑)'), 'NO_VALID_SEGMENTS:unanalyzable');
  assert.equal(errorKey('REPORT_PARSE_FAILED:pass1'), 'REPORT_PARSE_FAILED:pass1');
  assert.equal(errorKey('MODEL_UNAVAILABLE: models/x is not found'), 'MODEL_UNAVAILABLE');
  assert.equal(errorKey('QUOTA_EXHAUSTED: {"error":...}'), 'QUOTA_EXHAUSTED');
});

test('renderReport：包含关键数字和各小节；没标注的指标显示跳过而不是 0', () => {
  const text = renderReport(computeMetrics(build('demo'), RULES));
  for (const must of [
    '# 视频分析评测报告：demo', '代码版本：`abc1234`', '66.7%', '33.3%', '50.0%', '自信地错', '`bh_loop → fh_loop`'.replace(/`/g, ''),
    '## 2. 动作分类', '## 3. 片段切割', '## 4. 动作诊断', '## 7. 逐视频明细', 'C（视频文件不存在）',
  ]) assert.ok(text.includes(must), `缺少：${must}`);
  assert.ok(text.includes('bh_loop×1, fh_loop×1'));

  // 一个标注都没有的结果：对应小节应说明「跳过」
  const bare = build('bare');
  for (const v of bare.videos) v.gold = { tags: [] };
  const bareText = renderReport(computeMetrics(bare, RULES));
  assert.ok(bareText.includes('没有视频标注了 `segments`'));
  assert.ok(bareText.includes('没有视频标注了 `issues`'));
});

test('renderCompare：并排对比，逐视频标出全对 / 部分对 / 全错', () => {
  const a = computeMetrics(build('first'), RULES);
  const better = build('second');
  better.videos[0].runs[1] = okRun({ predicted: 'bh_loop', confidence: 0.9, problems: ['引拍未下沉、手腕僵硬'], passesMs: 2000 });
  const b = computeMetrics(better, RULES);

  const text = renderCompare([a, b]);
  assert.ok(text.includes('# 评测对比：first vs second'));
  assert.match(text, /\| A \| `bh_loop` \| bh_loop×1, fh_loop×1 ⚠️ \| bh_loop×2 ✅ \|/);
  assert.match(text, /\| B \| `bh_drive` \| （失败） ❌ \| （失败） ❌ \|/);
  assert.ok(text.includes('样本量太小时差异不能当结论'));
});
