/**
 * 评测指标汇总与报告生成
 *
 * 输入只有 results.json（EvalResults）和知识库的诊断规则，不调用任何模型，
 * 所以 `compare` 和重新生成报告都是免费的。
 */
import type { AnalysisTrace, PassMeta } from '../../videoAnalysis/pipeline';
import {
  agreement, boundaryErrors, intervalsIoU, matchProblemsToRules, mean, parsePredictedSegments,
  percentile, precisionRecallF1, sum, type RuleLite,
} from './metrics';
import type { EvalResults, RunRecord, VideoResult } from './types';

// ─── 输入：知识库规则、价格表 ─────────────────────────────────────

export interface ReportKnowledge {
  /** action_id → 该动作的诊断规则 */
  rulesByAction: Record<string, RuleLite[]>;
}

/** 每百万 token 的价格；价格请自己填（eval/pricing.json），评测不内置任何价格 */
export type Pricing = Record<string, { inputPerMTok: number | null; outputPerMTok: number | null; currency?: string }>;

/** 高置信度（≥此值）仍然判错，视为「自信地错」 */
export const HIGH_CONFIDENCE = 0.75;

// ─── 指标结构 ────────────────────────────────────────────────────

export interface Stats { n: number; mean?: number; p50?: number; p95?: number; max?: number }

function statsOf(values: number[]): Stats {
  return {
    n: values.length,
    mean: mean(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : undefined,
  };
}

export interface HighConfWrong { videoId: string; gold: string; predicted: string; confidence: number }

export interface VideoRow {
  videoId: string;
  goldAction?: string;
  /** 各次运行的预测，例如 `bh_loop×2, fh_loop×1`；失败记为（失败） */
  predictions: string;
  correctRuns: number;
  runs: number;
  avgConfidence?: number;
  iouRaw?: number;
  diagnosisF1?: number;
  avgPassesSec?: number;
  note?: string;
}

export interface RunMetrics {
  label: string;
  config: EvalResults['config'];
  gitCommit?: string;
  startedAt: string;
  videosTotal: number;
  videosEvaluated: number;
  skipped: string[];
  runs: number;
  successRate?: number;
  errors: Record<string, number>;

  classification: {
    evaluatedRuns: number;
    accuracyAll?: number;
    answeredRuns: number;
    accuracyAnswered?: number;
    abstainedRuns: number;
    highConfWrong: HighConfWrong[];
    meanConfCorrect?: number;
    meanConfWrong?: number;
    confusion: Record<string, number>;
    /** 标注为 none 的视频：是否按预期被拒绝（NO_VALID_SEGMENTS）或降级为 unknown */
    noneRuns: number;
    noneCorrect: number;
  };
  segments: {
    evaluatedRuns: number;
    iouRaw?: number;
    iouValidated?: number;
    startMeanAbsError?: number;
    endMeanAbsError?: number;
    startBias?: number;
    endBias?: number;
    missedGold: number;
    extraPred: number;
  };
  diagnosis: {
    evaluatedRuns: number;
    precision?: number;
    recall?: number;
    f1?: number;
    /** 平均每次输出多少条没有对应到任何规则的问题（模型自由发挥的部分） */
    extraProblemsPerRun?: number;
    noIssueRuns: number;
    falseAlarmRuns: number;
  };
  schema: {
    pass1: { executed: number; passed: number };
    pass15: { executed: number; passed: number };
    pass2: { executed: number; passed: number };
    overall?: number;
  };
  stability: { videosWithRepeats: number; fullyAgreeVideos: number; meanAgreement?: number };
  latency: { pass1: Stats; pass15: Stats; pass2: Stats; passes: Stats; e2eEstimate: Stats; upload: Stats };
  tokens: { perRunInput?: number; perRunOutput?: number };
  cost: { perRun?: number; currency?: string; missingPrice: string[] };
  perVideo: VideoRow[];
}

// ─── 工具 ────────────────────────────────────────────────────────

const failed = (r: RunRecord) => !r.ok;

/**
 * 把错误归并成便于统计的键：`NO_VALID_SEGMENTS:not_table_tennis`、`REPORT_PARSE_FAILED:pass1` 保留后缀，
 * `MODEL_UNAVAILABLE: 一长串细节` 只保留错误码
 */
export function errorKey(error: string): string {
  return error.match(/^[A-Za-z0-9_]+(?::[A-Za-z0-9_]+)?/)?.[0] ?? error.slice(0, 40);
}

function passesOf(trace: AnalysisTrace): PassMeta[] {
  return [trace.pass1, trace.pass15, trace.pass2].filter((p): p is NonNullable<typeof p> => !!p);
}

function runCost(trace: AnalysisTrace, pricing: Pricing, missing: Set<string>): number | undefined {
  let total = 0;
  let complete = true;
  for (const p of passesOf(trace)) {
    const price = pricing[p.model];
    if (!price || price.inputPerMTok == null || price.outputPerMTok == null) {
      missing.add(p.model);
      complete = false;
      continue;
    }
    total += ((p.usage?.inputTokens ?? 0) * price.inputPerMTok + (p.usage?.outputTokens ?? 0) * price.outputPerMTok) / 1_000_000;
  }
  return complete ? total : undefined;
}

// ─── 主计算 ──────────────────────────────────────────────────────

export function computeMetrics(results: EvalResults, knowledge: ReportKnowledge, pricing: Pricing = {}): RunMetrics {
  const evaluated = results.videos.filter(v => !v.skipped && !v.uploadError);
  const allRuns: { video: VideoResult; run: RunRecord }[] = evaluated.flatMap(v => v.runs.map(run => ({ video: v, run })));

  const errors: Record<string, number> = {};
  for (const { run } of allRuns) {
    if (run.error) {
      const key = errorKey(run.error);
      errors[key] = (errors[key] ?? 0) + 1;
    }
  }

  // ── 动作分类（Pass 1.5）
  const cls: RunMetrics['classification'] = {
    evaluatedRuns: 0, answeredRuns: 0, abstainedRuns: 0, highConfWrong: [], confusion: {}, noneRuns: 0, noneCorrect: 0,
  };
  let correctRuns = 0;
  let correctAnswered = 0;
  const confCorrect: number[] = [];
  const confWrong: number[] = [];

  for (const { video, run } of allRuns) {
    const gold = video.gold.actionId;
    if (gold === undefined) continue;
    const p15 = run.trace.pass15;
    if (gold === 'none') {
      cls.noneRuns++;
      if ((run.error ?? '').startsWith('NO_VALID_SEGMENTS') || p15?.decision.status === 'unknown') cls.noneCorrect++;
      continue;
    }
    cls.evaluatedRuns++;
    if (!p15) {
      const key = `${gold} → （失败）`;
      cls.confusion[key] = (cls.confusion[key] ?? 0) + 1;
      continue;
    }
    const predicted = p15.result.primary_action_id;
    const abstained = p15.decision.status === 'unknown';
    if (abstained) cls.abstainedRuns++; else cls.answeredRuns++;

    if (predicted === gold) {
      correctRuns++;
      if (!abstained) correctAnswered++;
      confCorrect.push(p15.result.confidence);
    } else {
      confWrong.push(p15.result.confidence);
      const key = `${gold} → ${predicted}`;
      cls.confusion[key] = (cls.confusion[key] ?? 0) + 1;
      if (!abstained && p15.result.confidence >= HIGH_CONFIDENCE) {
        cls.highConfWrong.push({ videoId: video.videoId, gold, predicted, confidence: p15.result.confidence });
      }
    }
  }
  cls.accuracyAll = cls.evaluatedRuns ? correctRuns / cls.evaluatedRuns : undefined;
  cls.accuracyAnswered = cls.answeredRuns ? correctAnswered / cls.answeredRuns : undefined;
  cls.meanConfCorrect = mean(confCorrect);
  cls.meanConfWrong = mean(confWrong);

  // ── 片段（Pass 1）
  const seg: RunMetrics['segments'] = { evaluatedRuns: 0, missedGold: 0, extraPred: 0 };
  const iouRaw: number[] = [], iouVal: number[] = [], startErr: number[] = [], endErr: number[] = [];
  const iouByVideo = new Map<string, number[]>();
  for (const { video, run } of allRuns) {
    const gold = video.gold.segments;
    const p1 = run.trace.pass1;
    if (!gold || gold.length === 0 || !p1) continue;
    seg.evaluatedRuns++;
    const rawIntervals = parsePredictedSegments((p1.raw as any)?.segments);
    const valIntervals = parsePredictedSegments(p1.segments);
    const rawIou = intervalsIoU(rawIntervals, gold);
    iouRaw.push(rawIou);
    iouVal.push(intervalsIoU(valIntervals, gold));
    (iouByVideo.get(video.videoId) ?? iouByVideo.set(video.videoId, []).get(video.videoId)!).push(rawIou);
    const b = boundaryErrors(rawIntervals, gold);
    startErr.push(...b.startErrors);
    endErr.push(...b.endErrors);
    seg.missedGold += b.missedGold;
    seg.extraPred += b.extraPred;
  }
  seg.iouRaw = mean(iouRaw);
  seg.iouValidated = mean(iouVal);
  seg.startMeanAbsError = mean(startErr.map(Math.abs));
  seg.endMeanAbsError = mean(endErr.map(Math.abs));
  seg.startBias = mean(startErr);
  seg.endBias = mean(endErr);

  // ── 诊断（Pass 2）：只评「动作判对了」的运行，否则诊断的是另一个动作
  const dia: RunMetrics['diagnosis'] = { evaluatedRuns: 0, noIssueRuns: 0, falseAlarmRuns: 0 };
  const precisions: number[] = [], recalls: number[] = [], f1s: number[] = [], extras: number[] = [];
  const f1ByVideo = new Map<string, number[]>();
  for (const { video, run } of allRuns) {
    const gold = video.gold;
    const p15 = run.trace.pass15;
    const p2 = run.trace.pass2;
    if (!gold.issues || !gold.actionId || gold.actionId === 'none' || !p15 || !p2) continue;
    if (p15.result.primary_action_id !== gold.actionId) continue;
    const raw: any = p2.raw;
    if (!raw || Array.isArray(raw)) continue;

    const texts: string[] = (Array.isArray(raw.problems) ? raw.problems : []).map((x: any) => String(x?.text ?? '')).filter(Boolean);
    if (gold.issues.length === 0) {
      dia.noIssueRuns++;
      if (texts.length > 0) dia.falseAlarmRuns++;
      continue;
    }
    const { matched, unmatched } = matchProblemsToRules(texts, knowledge.rulesByAction[gold.actionId] ?? []);
    const prf = precisionRecallF1(matched, gold.issues);
    dia.evaluatedRuns++;
    precisions.push(prf.precision ?? 0);
    recalls.push(prf.recall ?? 0);
    f1s.push(prf.f1 ?? 0);
    extras.push(unmatched.length);
    (f1ByVideo.get(video.videoId) ?? f1ByVideo.set(video.videoId, []).get(video.videoId)!).push(prf.f1 ?? 0);
  }
  dia.precision = mean(precisions);
  dia.recall = mean(recalls);
  dia.f1 = mean(f1s);
  dia.extraProblemsPerRun = mean(extras);

  // ── Schema 通过率（各环节「被执行的次数」里，成功产出且 Schema 校验通过的比例）
  const sch: RunMetrics['schema'] = { pass1: { executed: 0, passed: 0 }, pass15: { executed: 0, passed: 0 }, pass2: { executed: 0, passed: 0 } };
  for (const { run } of allRuns) {
    const t = run.trace;
    sch.pass1.executed++;
    if (t.pass1 && !t.pass1.schemaErrors?.length) sch.pass1.passed++;

    const reached15 = !!t.pass1 && t.pass1.segments.length > 0;
    if (reached15) {
      sch.pass15.executed++;
      if (t.pass15 && !t.pass15.schemaErrors?.length) sch.pass15.passed++;
    }
    const reached2 = !!t.pass15 && t.pass15.decision.status !== 'unknown';
    if (reached2) {
      sch.pass2.executed++;
      if (t.pass2 && !t.pass2.schemaErrors?.length) sch.pass2.passed++;
    }
  }
  const execTotal = sch.pass1.executed + sch.pass15.executed + sch.pass2.executed;
  sch.overall = execTotal ? (sch.pass1.passed + sch.pass15.passed + sch.pass2.passed) / execTotal : undefined;

  // ── 稳定性（需要每个视频重复运行 ≥ 2 次）
  const stab: RunMetrics['stability'] = { videosWithRepeats: 0, fullyAgreeVideos: 0 };
  const agreements: number[] = [];
  for (const v of evaluated) {
    const labels = v.runs.map(r => r.trace.pass15?.result.primary_action_id ?? '（失败）');
    if (labels.length < 2) continue;
    stab.videosWithRepeats++;
    const a = agreement(labels)!;
    agreements.push(a);
    if (a === 1) stab.fullyAgreeVideos++;
  }
  stab.meanAgreement = mean(agreements);

  // ── 耗时
  const okRuns = allRuns.filter(x => x.run.ok);
  const upload = evaluated.filter(v => v.uploadMs !== undefined).map(v => (v.uploadMs ?? 0) + (v.readyMs ?? 0));
  const latency: RunMetrics['latency'] = {
    pass1: statsOf(allRuns.map(x => x.run.trace.pass1?.durationMs).filter((n): n is number => n !== undefined)),
    pass15: statsOf(allRuns.map(x => x.run.trace.pass15?.durationMs).filter((n): n is number => n !== undefined)),
    pass2: statsOf(allRuns.map(x => x.run.trace.pass2?.durationMs).filter((n): n is number => n !== undefined)),
    passes: statsOf(okRuns.map(x => x.run.trace.timingsMs.passes).filter((n): n is number => n !== undefined)),
    e2eEstimate: statsOf(okRuns.map(x => (x.run.trace.timingsMs.passes ?? 0) + (x.video.uploadMs ?? 0) + (x.video.readyMs ?? 0))),
    upload: statsOf(upload),
  };

  // ── token 与费用
  const inTok = okRuns.map(x => sum(passesOf(x.run.trace).map(p => p.usage?.inputTokens ?? 0)));
  const outTok = okRuns.map(x => sum(passesOf(x.run.trace).map(p => p.usage?.outputTokens ?? 0)));
  const missing = new Set<string>();
  const costs = okRuns.map(x => runCost(x.run.trace, pricing, missing)).filter((n): n is number => n !== undefined);
  const currency = Object.values(pricing).find(p => p.currency)?.currency;

  // ── 逐视频
  const perVideo: VideoRow[] = results.videos.map(v => {
    const row: VideoRow = {
      videoId: v.videoId, goldAction: v.gold.actionId, predictions: '', correctRuns: 0, runs: v.runs.length,
    };
    if (v.skipped) { row.note = `跳过：${v.skipped}`; return row; }
    if (v.uploadError) { row.note = `上传失败：${v.uploadError}`; return row; }

    const counts = new Map<string, number>();
    const confs: number[] = [];
    for (const r of v.runs) {
      const p = r.trace.pass15?.result.primary_action_id ?? '（失败）';
      counts.set(p, (counts.get(p) ?? 0) + 1);
      if (r.trace.pass15) confs.push(r.trace.pass15.result.confidence);
      if (v.gold.actionId && p === v.gold.actionId) row.correctRuns++;
    }
    row.predictions = [...counts.entries()].map(([k, n]) => (v.runs.length > 1 ? `${k}×${n}` : k)).join(', ');
    row.avgConfidence = mean(confs);
    row.iouRaw = mean(iouByVideo.get(v.videoId) ?? []);
    row.diagnosisF1 = mean(f1ByVideo.get(v.videoId) ?? []);
    row.avgPassesSec = mean(v.runs.map(r => r.trace.timingsMs.passes).filter((n): n is number => n !== undefined).map(n => n / 1000));
    const errs = [...new Set(v.runs.filter(failed).map(r => r.error))];
    if (errs.length) row.note = errs.join(' / ');
    return row;
  });

  return {
    label: results.label,
    config: results.config,
    gitCommit: results.gitCommit,
    startedAt: results.startedAt,
    videosTotal: results.videos.length,
    videosEvaluated: evaluated.length,
    skipped: results.videos.filter(v => v.skipped || v.uploadError).map(v => `${v.videoId}（${v.skipped ?? v.uploadError}）`),
    runs: allRuns.length,
    successRate: allRuns.length ? okRuns.length / allRuns.length : undefined,
    errors,
    classification: cls,
    segments: seg,
    diagnosis: dia,
    schema: sch,
    stability: stab,
    latency,
    tokens: { perRunInput: mean(inTok), perRunOutput: mean(outTok) },
    cost: { perRun: costs.length ? mean(costs) : undefined, currency, missingPrice: [...missing] },
    perVideo,
  };
}

// ─── 渲染 ────────────────────────────────────────────────────────

const pct = (x?: number, digits = 1) => (x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);
const sec = (ms?: number) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`);
/** 入参已经是秒 */
const secs = (x?: number) => (x === undefined ? '—' : `${x.toFixed(1)}s`);
const num = (x?: number, digits = 1) => (x === undefined ? '—' : x.toFixed(digits));
const signed = (x?: number) => (x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}s`);
const ratio = (a: number, b: number) => (b === 0 ? '—' : `${a}/${b}（${pct(a / b)}）`);
const statLine = (s: Stats) => (s.n === 0 ? '—' : `P50 ${sec(s.p50)} · P95 ${sec(s.p95)} · 均值 ${sec(s.mean)}（n=${s.n}）`);

export function renderReport(m: RunMetrics): string {
  const c = m.classification, s = m.segments, d = m.diagnosis, sc = m.schema, st = m.stability, l = m.latency;
  const L: string[] = [];

  L.push(`# 视频分析评测报告：${m.label}`);
  L.push('');
  L.push(`- 运行时间：${m.startedAt}`);
  if (m.gitCommit) L.push(`- 代码版本：\`${m.gitCommit}\``);
  L.push(`- 视频：共 ${m.videosTotal} 个，参与评测 ${m.videosEvaluated} 个；每个视频重复 ${m.config.repeat} 次，合计 ${m.runs} 次运行`);
  L.push(`- 部署区域：\`${m.config.region}\`；视频托管：\`${m.config.storage}\``);
  L.push('');
  L.push('| 环节 | 模型（降级链，靠前优先） |');
  L.push('|---|---|');
  L.push(`| Pass 1 片段切割 | ${m.config.pass1Models.map(x => `\`${x}\``).join(' → ') || '—'} |`);
  L.push(`| Pass 1.5 动作分类 | ${m.config.pass15Models.map(x => `\`${x}\``).join(' → ') || '—'} |`);
  L.push(`| Pass 2 动作诊断 | ${m.config.pass2Models.map(x => `\`${x}\``).join(' → ') || '—'} |`);
  if (m.skipped.length) {
    L.push('');
    L.push(`> [!WARNING]\n> 以下视频没有参与评测：${m.skipped.join('；')}`);
  }

  L.push('');
  L.push('## 1. 指标总览');
  L.push('');
  L.push('| 指标 | 结果 | 说明 |');
  L.push('|---|---|---|');
  L.push(`| 运行成功率 | ${pct(m.successRate)} | 整条链路没有报错的比例 |`);
  L.push(`| 动作分类准确率（失败和降级计错） | ${pct(c.accuracyAll)} | ${c.evaluatedRuns} 次运行 |`);
  L.push(`| 动作分类准确率（仅已回答的） | ${pct(c.accuracyAnswered)} | 已回答 ${c.answeredRuns} 次，降级为「无法判断」${c.abstainedRuns} 次 |`);
  L.push(`| 自信地错（置信度 ≥ ${HIGH_CONFIDENCE} 仍判错） | ${c.highConfWrong.length} 次 | 越少越好，比普通判错更危险 |`);
  L.push(`| 片段 IoU（模型原始输出） | ${pct(s.iouRaw)} | ${s.evaluatedRuns} 次运行有片段标注 |`);
  L.push(`| 诊断问题点 F1 | ${pct(d.f1)} | 精确率 ${pct(d.precision)} · 召回率 ${pct(d.recall)}（${d.evaluatedRuns} 次） |`);
  L.push(`| JSON Schema 通过率 | ${pct(sc.overall)} | 各环节被执行的次数里，成功产出且校验通过的比例 |`);
  L.push(`| 分类稳定性（重复结果一致） | ${st.videosWithRepeats ? `${st.fullyAgreeVideos}/${st.videosWithRepeats} 个视频完全一致` : '—'} | 需要 \`--repeat\` ≥ 2；平均一致度 ${pct(st.meanAgreement)} |`);
  L.push(`| 模型耗时（Pass 1+1.5+2，不含上传） | ${statLine(l.passes)} | 样本少时 P95 约等于最大值 |`);
  L.push(`| 端到端估算（含上传与就绪等待） | ${statLine(l.e2eEstimate)} | 上传在评测里每个视频只做一次 |`);
  L.push(`| 平均每次 token | 输入 ${num(m.tokens.perRunInput, 0)} · 输出 ${num(m.tokens.perRunOutput, 0)} | 三个环节合计 |`);
  L.push(`| 平均每次费用 | ${m.cost.perRun !== undefined ? `${m.cost.perRun.toFixed(4)} ${m.cost.currency ?? ''}` : '未计算'} | ${m.cost.missingPrice.length ? `缺少价格：${m.cost.missingPrice.join('、')}（在 eval/pricing.json 填写）` : '按 eval/pricing.json 的价格表'} |`);

  if (Object.keys(m.errors).length) {
    L.push('');
    L.push('### 失败分布');
    L.push('');
    L.push('| 错误 | 次数 |');
    L.push('|---|---|');
    for (const [k, n] of Object.entries(m.errors).sort((a, b) => b[1] - a[1])) L.push(`| \`${k}\` | ${n} |`);
  }

  L.push('');
  L.push('## 2. 动作分类（Pass 1.5）');
  L.push('');
  L.push(`- 判对时平均置信度 ${num(c.meanConfCorrect, 2)}，判错时 ${num(c.meanConfWrong, 2)}。两者越接近，说明置信度越不可靠。`);
  if (c.noneRuns) L.push(`- 标注为「无有效动作（none）」的视频：${c.noneCorrect}/${c.noneRuns} 次按预期被拒绝或降级。`);
  if (c.highConfWrong.length) {
    L.push('');
    L.push('**自信地错：**');
    L.push('');
    L.push('| 视频 | 标注 | 模型判断 | 置信度 |');
    L.push('|---|---|---|---|');
    for (const h of c.highConfWrong) L.push(`| ${h.videoId} | \`${h.gold}\` | \`${h.predicted}\` | ${h.confidence.toFixed(2)} |`);
  }
  if (Object.keys(c.confusion).length) {
    L.push('');
    L.push('**判错的去向（标注 → 模型判断）：**');
    L.push('');
    L.push('| 混淆 | 次数 |');
    L.push('|---|---|');
    for (const [k, n] of Object.entries(c.confusion).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${n} |`);
  }

  L.push('');
  L.push('## 3. 片段切割（Pass 1）');
  L.push('');
  if (s.evaluatedRuns === 0) {
    L.push('没有视频标注了 `segments`，这一项跳过。');
  } else {
    L.push('| 指标 | 结果 |');
    L.push('|---|---|');
    L.push(`| IoU（模型原始输出） | ${pct(s.iouRaw)} |`);
    L.push(`| IoU（系统校验后：含前 3 秒 / 后 1 秒缓冲与合并） | ${pct(s.iouValidated)} |`);
    L.push(`| 起点平均绝对误差 / 偏差 | ${secs(s.startMeanAbsError)} / ${signed(s.startBias)} |`);
    L.push(`| 终点平均绝对误差 / 偏差 | ${secs(s.endMeanAbsError)} / ${signed(s.endBias)} |`);
    L.push(`| 漏检的标注片段 / 多检的预测片段 | ${s.missedGold} / ${s.extraPred} |`);
    L.push('');
    L.push('偏差为正表示模型比标注晚（起点）或晚结束（终点）。');
  }

  L.push('');
  L.push('## 4. 动作诊断（Pass 2）');
  L.push('');
  if (d.evaluatedRuns === 0 && d.noIssueRuns === 0) {
    L.push('没有视频标注了 `issues`（或动作没判对），这一项跳过。');
  } else {
    L.push('只统计「动作判对」的运行；把模型给出的问题对应回诊断规则后，与标注的 `issues` 比较。');
    L.push('');
    L.push('| 指标 | 结果 |');
    L.push('|---|---|');
    L.push(`| 精确率 / 召回率 / F1 | ${pct(d.precision)} / ${pct(d.recall)} / ${pct(d.f1)}（${d.evaluatedRuns} 次） |`);
    L.push(`| 平均每次没对应到规则的问题数 | ${num(d.extraProblemsPerRun, 2)} |`);
    if (d.noIssueRuns) L.push(`| 标注「无问题」的视频：模型仍报问题的次数 | ${d.falseAlarmRuns}/${d.noIssueRuns} |`);
  }

  L.push('');
  L.push('## 5. 耗时');
  L.push('');
  L.push('| 环节 | 耗时 |');
  L.push('|---|---|');
  L.push(`| 上传 + 等待就绪（每视频一次） | ${statLine(l.upload)} |`);
  L.push(`| Pass 1 | ${statLine(l.pass1)} |`);
  L.push(`| Pass 1.5 | ${statLine(l.pass15)} |`);
  L.push(`| Pass 2 | ${statLine(l.pass2)} |`);

  L.push('');
  L.push('## 6. Schema 通过率明细');
  L.push('');
  L.push('| 环节 | 通过 / 被执行 |');
  L.push('|---|---|');
  L.push(`| Pass 1 | ${ratio(sc.pass1.passed, sc.pass1.executed)} |`);
  L.push(`| Pass 1.5 | ${ratio(sc.pass15.passed, sc.pass15.executed)} |`);
  L.push(`| Pass 2 | ${ratio(sc.pass2.passed, sc.pass2.executed)} |`);

  L.push('');
  L.push('## 7. 逐视频明细');
  L.push('');
  L.push('| 视频 | 标注动作 | 模型判断 | 判对 | 平均置信度 | 片段 IoU | 诊断 F1 | 模型耗时 | 备注 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const v of m.perVideo) {
    L.push(`| ${v.videoId} | ${v.goldAction ? `\`${v.goldAction}\`` : '未标注'} | ${v.predictions || '—'} | ${v.goldAction ? `${v.correctRuns}/${v.runs}` : '—'} | ${num(v.avgConfidence, 2)} | ${pct(v.iouRaw)} | ${pct(v.diagnosisF1)} | ${v.avgPassesSec !== undefined ? `${v.avgPassesSec.toFixed(1)}s` : '—'} | ${v.note ?? ''} |`);
  }
  L.push('');
  return L.join('\n');
}

export function renderCompare(list: RunMetrics[]): string {
  const L: string[] = [];
  const cols = list.map(m => m.label);
  const row = (name: string, f: (m: RunMetrics) => string) => `| ${name} | ${list.map(f).join(' | ')} |`;

  L.push(`# 评测对比：${cols.join(' vs ')}`);
  L.push('');
  L.push('> 各列分别来自对应的 `results.json`，对比本身不调用模型。**样本量太小时差异不能当结论**，请同时看下面的视频数和重复次数。');
  L.push('');
  L.push(`| 指标 | ${cols.join(' | ')} |`);
  L.push(`|---|${cols.map(() => '---').join('|')}|`);
  L.push(row('参与视频 × 重复', m => `${m.videosEvaluated} × ${m.config.repeat}`));
  L.push(row('Pass 1 模型', m => m.config.pass1Models[0] ?? '—'));
  L.push(row('Pass 1.5 模型', m => m.config.pass15Models[0] ?? '—'));
  L.push(row('Pass 2 模型', m => m.config.pass2Models[0] ?? '—'));
  L.push(row('运行成功率', m => pct(m.successRate)));
  L.push(row('动作分类准确率（失败和降级计错）', m => pct(m.classification.accuracyAll)));
  L.push(row('动作分类准确率（仅已回答）', m => pct(m.classification.accuracyAnswered)));
  L.push(row('自信地错（次）', m => String(m.classification.highConfWrong.length)));
  L.push(row('片段 IoU（原始输出）', m => pct(m.segments.iouRaw)));
  L.push(row('诊断问题点 F1', m => pct(m.diagnosis.f1)));
  L.push(row('JSON Schema 通过率', m => pct(m.schema.overall)));
  L.push(row('分类稳定性', m => (m.stability.videosWithRepeats ? `${m.stability.fullyAgreeVideos}/${m.stability.videosWithRepeats} 视频一致` : '—')));
  L.push(row('模型耗时 P50', m => sec(m.latency.passes.p50)));
  L.push(row('模型耗时 P95', m => sec(m.latency.passes.p95)));
  L.push(row('端到端估算 P50', m => sec(m.latency.e2eEstimate.p50)));
  L.push(row('平均每次 token（输入 / 输出）', m => `${num(m.tokens.perRunInput, 0)} / ${num(m.tokens.perRunOutput, 0)}`));
  L.push(row('平均每次费用', m => (m.cost.perRun !== undefined ? `${m.cost.perRun.toFixed(4)} ${m.cost.currency ?? ''}` : '未计算')));

  // 逐视频：各次运行的动作判断并排
  const ids = [...new Set(list.flatMap(m => m.perVideo.map(v => v.videoId)))];
  L.push('');
  L.push('## 逐视频动作判断');
  L.push('');
  L.push(`| 视频 | 标注 | ${cols.join(' | ')} |`);
  L.push(`|---|---|${cols.map(() => '---').join('|')}|`);
  for (const id of ids) {
    const rows = list.map(m => m.perVideo.find(v => v.videoId === id));
    const gold = rows.find(r => r?.goldAction)?.goldAction;
    const cells = rows.map(r => {
      if (!r) return '—';
      const mark = gold && r.runs > 0 ? (r.correctRuns === r.runs ? ' ✅' : r.correctRuns === 0 ? ' ❌' : ' ⚠️') : '';
      return `${r.predictions || r.note || '—'}${mark}`;
    });
    L.push(`| ${id} | ${gold ? `\`${gold}\`` : '未标注'} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push('✅ 全部判对 · ⚠️ 部分判对（多次重复结果不一致）· ❌ 全部判错');
  L.push('');
  return L.join('\n');
}
