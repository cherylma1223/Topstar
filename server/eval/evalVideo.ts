/**
 * 视频分析评测 CLI
 *
 * 在 server/ 目录下运行（会读取 server/.env 里的 Key 和模型配置）：
 *
 *   npm run eval -- candidates                     列出可以拿来做评测集的已上传视频
 *   npm run eval -- add <jobId> <video_id>         把一个已上传视频加入评测集（复制文件并追加一行标注）
 *   npm run eval -- template                       生成空白标注模板
 *   npm run eval -- rules [action_id]              查看动作 ID 和每个动作的问题点 ID（标注时对照用）
 *   npm run eval -- validate                       检查标注文件
 *   npm run eval -- run --label <名字> [...]       跑评测（会调用模型，产生费用）
 *   npm run eval -- compare <运行目录> <运行目录>  对比多次评测（不调用模型）
 *   npm run eval -- report <运行目录>              用已保存的结果重新生成报告（不调用模型）
 *
 * 详细说明见 eval/README.md
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  COLUMNS, loadAnnotations, validateAnnotations,
  type Annotation, type Knowledge,
} from './lib/annotations';
import { toCsvLine } from './lib/csv';
import { annotationTemplate } from './lib/template';
import { computeMetrics, renderCompare, renderReport, type Pricing, type ReportKnowledge } from './lib/report';
import type { EvalResults } from './lib/types';

// 评测脚本不往线上任务日志里写（必须在使用日志的模块被调用前设置）
process.env.VIDEO_ANALYSIS_LOG_DISABLED = '1';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(REPO_ROOT, 'eval');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const DEFAULT_ANNOTATIONS = path.join(DATA_DIR, 'labels', 'annotations.csv');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const PRICING_FILE = path.join(DATA_DIR, 'pricing.json');
const DB_FILE = path.resolve(__dirname, '../data/topstar.db');

/** 超过这个运行次数（视频数 × 重复次数）必须显式加 --yes，避免误触发大额费用 */
const CONFIRM_THRESHOLD = 6;

// ─── 参数解析 ────────────────────────────────────────────────────

interface Args { command?: string; positional: string[]; flags: Record<string, string | true> }

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { command: positional.shift(), positional, flags };
}

const flagStr = (a: Args, k: string): string | undefined => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined);

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ─── 知识库 ──────────────────────────────────────────────────────

function loadKnowledge(): { knowledge: Knowledge; report: ReportKnowledge } {
  // 延迟引入：validate / candidates 等命令不需要加载模型相关模块
  const { loadAnalysisKnowledge, getActionIds, getDiagnosisRules } = require('../videoAnalysis/analysisKnowledgeLoader');
  loadAnalysisKnowledge();
  const rules = (getDiagnosisRules()?.rules ?? []) as { action_id: string; issue_id: string; problem: string; evidence: string }[];

  const issueIdsByAction: Record<string, string[]> = {};
  const rulesByAction: ReportKnowledge['rulesByAction'] = {};
  for (const r of rules) {
    (issueIdsByAction[r.action_id] ??= []).push(r.issue_id);
    (rulesByAction[r.action_id] ??= []).push({ issue_id: r.issue_id, problem: r.problem, evidence: r.evidence });
  }
  return { knowledge: { actionIds: getActionIds(), issueIdsByAction }, report: { rulesByAction } };
}

function loadPricing(): Pricing {
  if (!fs.existsSync(PRICING_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8')); }
  catch (e: any) { console.warn(`⚠ 价格表 ${PRICING_FILE} 解析失败，费用将不计算：${e.message}`); return {}; }
}

// ─── 模板 ────────────────────────────────────────────────────────

function ensureAnnotationsFile(file: string): void {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, annotationTemplate(), 'utf8');
  console.log(`已创建标注模板：${path.relative(REPO_ROOT, file)}`);
}

// ─── 命令：template / validate ──────────────────────────────────

function cmdTemplate(args: Args) {
  const file = flagStr(args, 'annotations') ?? DEFAULT_ANNOTATIONS;
  if (fs.existsSync(file)) fail(`${path.relative(REPO_ROOT, file)} 已经存在，不会覆盖。要重新生成请先删除或改名。`);
  ensureAnnotationsFile(file);
}

function cmdValidate(args: Args): boolean {
  const file = flagStr(args, 'annotations') ?? DEFAULT_ANNOTATIONS;
  const { annotations, errors } = loadAnnotations(file);
  const { knowledge } = loadKnowledge();
  const v = validateAnnotations(annotations, knowledge, { videosDir: VIDEOS_DIR });
  const allErrors = [...errors, ...v.errors];

  console.log(`\n标注文件：${path.relative(REPO_ROOT, file)}`);
  console.log(`视频 ${annotations.length} 个；已填 action_id ${annotations.filter(a => a.actionId !== undefined).length}、segments ${annotations.filter(a => a.segments).length}、issues ${annotations.filter(a => a.issues).length}`);
  console.log(`可选的 action_id：${knowledge.actionIds.join(', ')}`);

  if (v.warnings.length) { console.log('\n⚠ 提示（不影响运行）：'); v.warnings.forEach(w => console.log(`  - ${w}`)); }
  if (allErrors.length) { console.log('\n✗ 需要修正的错误：'); allErrors.forEach(e => console.log(`  - ${e}`)); console.log(''); return false; }
  console.log('\n✓ 标注文件格式没有问题\n');
  return true;
}

// ─── 命令：candidates / add（需要读数据库）────────────────────────

interface JobRow {
  id: string; video_filename: string | null; video_size: number | null; video_duration: number | null;
  status: string; model: string | null; report: string | null; created_at: string; video_path: string | null;
}

function openDb() {
  if (!fs.existsSync(DB_FILE)) fail(`找不到数据库 ${DB_FILE}（这个命令要读已上传视频的记录）`);
  const Database = require('better-sqlite3');
  return new Database(DB_FILE, { readonly: true, fileMustExist: true });
}

function actionOfReport(report: string | null): string {
  try {
    const r = JSON.parse(report ?? '');
    return r?.reports?.[0]?.action_ids_detected?.[0] ?? '—';
  } catch { return '—'; }
}

function cmdCandidates(args: Args) {
  const db = openDb();
  const rows = db.prepare(
    `SELECT id, video_filename, video_size, video_duration, status, model, report, created_at, video_path
       FROM analysis_jobs WHERE status = 'done' AND analysis_type = 'technique' ORDER BY created_at DESC`
  ).all() as JobRow[];
  db.close();

  const annotated = new Set<string>();
  const annFile = flagStr(args, 'annotations') ?? DEFAULT_ANNOTATIONS;
  if (fs.existsSync(annFile)) for (const a of loadAnnotations(annFile).annotations) if (a.sourceJob) annotated.add(a.sourceJob);

  // 同一个文件名通常被反复上传测试，默认每个文件名只列最新的一条
  const showAll = args.flags.all === true;
  const seen = new Set<string>();
  const list = rows.filter(r => {
    if (showAll) return true;
    const key = r.video_filename ?? r.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n已完成的技术分析任务共 ${rows.length} 条，列出 ${list.length} 条${showAll ? '' : '（同名文件只列最新；加 --all 显示全部）'}：\n`);
  console.log('任务 ID（用于 add 命令）                  | 原文件名                | 时长  | 大小   | 视频文件 | 当时的判断 | 已入集');
  console.log('-'.repeat(125));
  for (const r of list) {
    const exists = r.video_path && fs.existsSync(r.video_path);
    console.log([
      r.id.padEnd(36),
      (r.video_filename ?? '—').padEnd(22),
      (r.video_duration != null ? `${r.video_duration}s` : '—').padEnd(5),
      (r.video_size != null ? `${(r.video_size / 1048576).toFixed(1)}MB` : '—').padEnd(6),
      (exists ? '在' : '已丢失').padEnd(7),
      actionOfReport(r.report).padEnd(10),
      annotated.has(r.id) ? '✓' : '',
    ].join(' | '));
  }
  console.log('\n提醒：「当时的判断」是模型的输出，只用来帮你挑视频；标注时请你自己看视频判断，不要照抄，否则评测会偏向这个模型。\n');
}

function cmdAdd(args: Args) {
  const [jobArg, videoId] = args.positional;
  if (!jobArg || !videoId) fail('用法：npm run eval -- add <任务ID或前缀> <video_id> [--action bh_loop] [--notes 备注]');
  if (!/^[A-Za-z0-9_.-]+$/.test(videoId)) fail('video_id 只能用英文字母、数字、下划线、点和连字符（建议用拼音或英文短名）');

  const annFile = flagStr(args, 'annotations') ?? DEFAULT_ANNOTATIONS;
  if (/\.xlsx?$/i.test(annFile)) fail('add 命令只支持 CSV 标注文件；xlsx 请手工填写');
  ensureAnnotationsFile(annFile);

  const existing = loadAnnotations(annFile);
  if (existing.errors.length) fail(`标注文件有错误，先修正再添加：\n  - ${existing.errors.join('\n  - ')}`);
  if (existing.annotations.some(a => a.videoId === videoId)) fail(`video_id「${videoId}」已经存在`);

  const db = openDb();
  const matches = db.prepare(`SELECT id, video_filename, video_path FROM analysis_jobs WHERE id LIKE ? || '%'`).all(jobArg) as JobRow[];
  db.close();
  if (matches.length === 0) fail(`找不到任务「${jobArg}」`);
  if (matches.length > 1) fail(`「${jobArg}」匹配到 ${matches.length} 个任务，请多写几位 ID`);
  const job = matches[0];
  if (!job.video_path || !fs.existsSync(job.video_path)) fail(`任务 ${job.id} 的视频文件已经不在了（${job.video_path}）`);
  if (existing.annotations.some(a => a.sourceJob === job.id)) fail(`任务 ${job.id} 已经加入过评测集`);

  const ext = path.extname(job.video_path).toLowerCase() || '.mp4';
  const videoFile = `${videoId}${ext}`;
  const dest = path.join(VIDEOS_DIR, videoFile);
  if (fs.existsSync(dest)) fail(`${path.relative(REPO_ROOT, dest)} 已经存在`);
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  fs.copyFileSync(job.video_path, dest);

  const action = flagStr(args, 'action');
  const notes = flagStr(args, 'notes') ?? (job.video_filename ? `原文件名：${job.video_filename}` : '');
  const row: Record<(typeof COLUMNS)[number], string> = {
    video_id: videoId, video_file: videoFile, action_id: action ?? '', segments: '', has_voice: '',
    issues: '', tags: '', notes, source_job: job.id,
  };
  const prev = fs.readFileSync(annFile, 'utf8');
  fs.appendFileSync(annFile, (prev.endsWith('\n') ? '' : '\n') + toCsvLine(COLUMNS.map(c => row[c])) + '\n', 'utf8');

  console.log(`\n✓ 已加入评测集：${videoId}`);
  console.log(`  视频：${path.relative(REPO_ROOT, dest)}（复制自任务 ${job.id}）`);
  console.log(`  标注：已在 ${path.relative(REPO_ROOT, annFile)} 末尾追加一行${action ? '' : '，请打开文件填写 action_id'}；segments / issues 等列可以按需补充（留空的列对应的指标会自动跳过）\n`);
}

// ─── 命令：run ───────────────────────────────────────────────────

function gitCommit(): string | undefined {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return dirty ? `${hash}+未提交改动` : hash;
  } catch { return undefined; }
}

function uniqueRunDir(label: string): string {
  const date = new Date();
  const ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const base = path.join(RUNS_DIR, `${ymd}-${label}`);
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}

async function cmdRun(args: Args) {
  const rawLabel = flagStr(args, 'label');
  if (!rawLabel) fail('必须用 --label 给这次评测起个名字，例如 --label gemini-baseline');
  const label = rawLabel.replace(/[^A-Za-z0-9._-]+/g, '-');

  const repeat = Math.max(1, Number(flagStr(args, 'repeat') ?? 1) || 1);

  // 模型配置：命令行优先于 .env（配置每次调用时实时读取，所以这里改 process.env 即可）
  const all = flagStr(args, 'all');
  if (all) for (const k of ['PASS1', 'PASS15', 'PASS2']) process.env[`LLM_VIDEO_${k}_MODELS`] = all;
  for (const [flag, key] of [['pass1', 'PASS1'], ['pass15', 'PASS15'], ['pass2', 'PASS2']] as const) {
    const v = flagStr(args, flag);
    if (v) process.env[`LLM_VIDEO_${key}_MODELS`] = v;
  }

  const annFile = flagStr(args, 'annotations') ?? DEFAULT_ANNOTATIONS;
  const loaded = loadAnnotations(annFile);
  const { knowledge, report: reportKnowledge } = loadKnowledge();
  const v = validateAnnotations(loaded.annotations, knowledge, { videosDir: VIDEOS_DIR });
  const problems = [...loaded.errors, ...v.errors];
  if (problems.length) fail(`标注文件有错误，先运行 npm run eval -- validate 查看并修正：\n  - ${problems.join('\n  - ')}`);

  let annotations: Annotation[] = loaded.annotations;
  const only = flagStr(args, 'only');
  if (only) {
    const ids = only.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = ids.filter(id => !annotations.some(a => a.videoId === id));
    if (unknown.length) fail(`--only 里有不存在的 video_id：${unknown.join(', ')}`);
    annotations = annotations.filter(a => ids.includes(a.videoId));
  }
  if (args.flags['only-annotated'] === true) annotations = annotations.filter(a => a.actionId !== undefined);

  const runnable = annotations.filter(a => fs.existsSync(path.join(VIDEOS_DIR, a.videoFile)));
  if (runnable.length === 0) fail('没有可以运行的视频（标注表是空的，或视频文件不在 eval/videos/ 下）');

  const { currentRunConfig } = require('./lib/runner') as typeof import('./lib/runner');
  const cfg = currentRunConfig(repeat);
  const totalRuns = runnable.length * repeat;

  console.log('\n评测计划');
  console.log(`  标签：${label}`);
  console.log(`  视频：${runnable.length} 个（标注表共 ${annotations.length} 行，${annotations.length - runnable.length} 个因视频文件缺失被跳过）`);
  console.log(`  重复：每个视频 ${repeat} 次 → 共 ${totalRuns} 次完整分析（每次调用 3 个模型环节，会产生费用）`);
  console.log(`  Pass 1   : ${cfg.pass1Models.join(' → ')}`);
  console.log(`  Pass 1.5 : ${cfg.pass15Models.join(' → ')}`);
  console.log(`  Pass 2   : ${cfg.pass2Models.join(' → ')}`);
  console.log(`  区域/托管：${cfg.region} / ${cfg.storage}\n`);

  if (totalRuns > CONFIRM_THRESHOLD && args.flags.yes !== true) {
    fail(`这次会做 ${totalRuns} 次完整分析（超过 ${CONFIRM_THRESHOLD} 次），确认无误后请加 --yes 再运行。\n  想先小范围试跑可以用 --only <video_id> 或 --repeat 1。`);
  }

  const { runEvaluation } = require('./lib/runner') as typeof import('./lib/runner');
  const results = await runEvaluation({
    label, videosDir: VIDEOS_DIR, annotations, repeat, gitCommit: gitCommit(),
    log: msg => console.log(msg),
  });

  const dir = uniqueRunDir(label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
  const metrics = computeMetrics(results, reportKnowledge, loadPricing());
  fs.writeFileSync(path.join(dir, 'report.md'), renderReport(metrics), 'utf8');

  console.log(`\n✓ 评测完成`);
  console.log(`  报告：${path.relative(REPO_ROOT, path.join(dir, 'report.md'))}`);
  console.log(`  原始结果：${path.relative(REPO_ROOT, path.join(dir, 'results.json'))}\n`);
}

// ─── 命令：compare / report（不调用模型）─────────────────────────

function resolveResultsFile(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const candidates = [abs, path.join(abs, 'results.json'), path.resolve(REPO_ROOT, p), path.join(path.resolve(REPO_ROOT, p), 'results.json')];
  const found = candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile());
  if (!found) fail(`找不到评测结果：${p}（应是 eval/runs/ 下的某个目录，或其中的 results.json）`);
  return found;
}

const readResults = (p: string): EvalResults => JSON.parse(fs.readFileSync(resolveResultsFile(p), 'utf8'));

function cmdCompare(args: Args) {
  if (args.positional.length < 2) fail('用法：npm run eval -- compare <运行目录A> <运行目录B> [...]');
  const { report: reportKnowledge } = loadKnowledge();
  const pricing = loadPricing();
  const metrics = args.positional.map(p => computeMetrics(readResults(p), reportKnowledge, pricing));
  const text = renderCompare(metrics);

  const out = flagStr(args, 'out') ?? path.join(RUNS_DIR, `compare-${metrics.map(m => m.label).join('_vs_')}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, 'utf8');
  console.log(text);
  console.log(`\n✓ 对比已保存：${path.relative(REPO_ROOT, out)}\n`);
}

function cmdReport(args: Args) {
  const [p] = args.positional;
  if (!p) fail('用法：npm run eval -- report <运行目录>');
  const file = resolveResultsFile(p);
  const { report: reportKnowledge } = loadKnowledge();
  const metrics = computeMetrics(JSON.parse(fs.readFileSync(file, 'utf8')), reportKnowledge, loadPricing());
  const out = path.join(path.dirname(file), 'report.md');
  fs.writeFileSync(out, renderReport(metrics), 'utf8');
  console.log(`\n✓ 报告已重新生成：${path.relative(REPO_ROOT, out)}\n`);
}

// ─── 命令：rules（查看动作 ID 和问题点 ID，标注时对照用）──────────

function cmdRules(args: Args) {
  const { loadAnalysisKnowledge, getRecognitionRules, getDiagnosisRules } = require('../videoAnalysis/analysisKnowledgeLoader');
  loadAnalysisKnowledge();
  const actions = (getRecognitionRules()?.actions ?? []) as { id: string; title: string }[];
  const rules = (getDiagnosisRules()?.rules ?? []) as { action_id: string; issue_id: string; evidence: string; problem: string }[];
  const only = args.positional[0];

  const list = only ? actions.filter(a => a.id === only) : actions;
  if (list.length === 0) fail(`没有这个动作：${only}。可选：${actions.map(a => a.id).join(', ')}`);

  console.log('\n标注时 action_id 填左边的 ID；issues 填 issue_id（多个用分号分隔）。\n');
  for (const a of list) {
    console.log(`■ ${a.id}  ${a.title}`);
    const rs = rules.filter(r => r.action_id === a.id);
    if (rs.length === 0) console.log('    （这个动作目前没有诊断规则，issues 只能填 none 或留空）');
    for (const r of rs) {
      console.log(`    ${r.issue_id}`);
      console.log(`        看到的现象：${r.evidence}`);
      console.log(`        对应的问题：${r.problem}`);
    }
    console.log('');
  }
}

// ─── 入口 ────────────────────────────────────────────────────────

function help() {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'template': return cmdTemplate(args);
    case 'validate': return process.exit(cmdValidate(args) ? 0 : 1);
    case 'rules': return cmdRules(args);
    case 'candidates': return cmdCandidates(args);
    case 'add': return cmdAdd(args);
    case 'run': return cmdRun(args);
    case 'compare': return cmdCompare(args);
    case 'report': return cmdReport(args);
    default: return help();
  }
}

main().catch(err => {
  console.error('\n✗ 评测失败：', err?.stack ?? err);
  process.exit(1);
});
