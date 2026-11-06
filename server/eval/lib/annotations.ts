/**
 * 评测集标注：解析与校验
 *
 * 一行 = 一个视频。列定义见 eval/README.md。留空表示「没标注」，对应指标会自动跳过；
 * 填 `none` 表示「明确没有」（如视频里没有有效击球 / 没有问题）。
 */
import fs from 'fs';
import path from 'path';
import { parseCsv } from './csv';

export interface Interval { start: number; end: number }

export interface Annotation {
  /** 在原表里的行号（含表头，从 1 开始），用于报错定位 */
  rowNumber: number;
  videoId: string;
  videoFile: string;
  /** 动作 ID；'none' = 无有效技术动作；undefined = 没标注 */
  actionId?: string;
  /** 有效片段（秒）；[] = 明确没有；undefined = 没标注 */
  segments?: Interval[];
  hasVoice?: boolean;
  /** 主要问题点（诊断规则的 issue_id）；[] = 明确没有问题；undefined = 没标注 */
  issues?: string[];
  tags: string[];
  notes?: string;
  sourceJob?: string;
}

export const COLUMNS = ['video_id', 'video_file', 'action_id', 'segments', 'has_voice', 'issues', 'tags', 'notes', 'source_job'] as const;

// ─── 单元格解析 ───────────────────────────────────────────────────

const LIST_SPLIT = /[;；、|]/;
const SEGMENT_SPLIT = /\s*[-–—~～至]\s*/;

/** 支持 mm:ss、hh:mm:ss、纯秒数（可带小数）；解析失败返回 null */
export function parseTimeToSeconds(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p.trim()))) return null;
  const nums = parts.map(p => Number(p.trim()));
  return nums.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2];
}

/** `00:00-00:19; 00:25-00:40` → 区间数组；`none` → []；空串 → undefined */
export function parseSegments(raw: string): { value?: Interval[]; error?: string } {
  const s = raw.trim();
  if (!s) return {};
  if (s.toLowerCase() === 'none') return { value: [] };

  const out: Interval[] = [];
  for (const piece of s.split(LIST_SPLIT).map(p => p.trim()).filter(Boolean)) {
    const [a, b, ...rest] = piece.split(SEGMENT_SPLIT);
    const start = a !== undefined ? parseTimeToSeconds(a) : null;
    const end = b !== undefined ? parseTimeToSeconds(b) : null;
    if (rest.length > 0 || start === null || end === null) {
      return { error: `片段「${piece}」格式不对，应为 mm:ss-mm:ss，例如 00:00-00:19` };
    }
    if (end <= start) return { error: `片段「${piece}」的结束时间必须大于开始时间` };
    out.push({ start, end });
  }
  return { value: out };
}

function parseList(raw: string): string[] {
  return raw.split(LIST_SPLIT).map(p => p.trim()).filter(Boolean);
}

function parseBool(raw: string): boolean | undefined | 'invalid' {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (['yes', 'y', 'true', '1', '是', '有'].includes(s)) return true;
  if (['no', 'n', 'false', '0', '否', '无', '没有'].includes(s)) return false;
  return 'invalid';
}

// ─── 表格 → 标注 ─────────────────────────────────────────────────

export interface ParseResult {
  annotations: Annotation[];
  /** 格式错误：必须修正后才能运行 */
  errors: string[];
}

export function parseAnnotationRows(rows: string[][]): ParseResult {
  const errors: string[] = [];
  if (rows.length === 0) return { annotations: [], errors: ['标注文件是空的（没有找到表头行）'] };

  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  for (const required of ['video_id', 'video_file']) {
    if (idx(required) < 0) errors.push(`表头缺少必填列「${required}」（当前表头：${rows[0].join(', ')}）`);
  }
  if (errors.length > 0) return { annotations: [], errors };

  const get = (r: string[], name: string) => (idx(name) >= 0 ? (r[idx(name)] ?? '').trim() : '');
  const annotations: Annotation[] = [];
  const seen = new Set<string>();

  rows.slice(1).forEach((r, i) => {
    const rowNumber = i + 2;
    const where = `第 ${rowNumber} 行`;
    const videoId = get(r, 'video_id');
    const videoFile = get(r, 'video_file');

    if (!videoId) { errors.push(`${where}：video_id 不能为空`); return; }
    if (!/^[A-Za-z0-9_.-]+$/.test(videoId)) errors.push(`${where}：video_id「${videoId}」只能用英文字母、数字、下划线、点和连字符（建议用拼音或英文短名）`);
    if (seen.has(videoId)) errors.push(`${where}：video_id「${videoId}」重复`);
    seen.add(videoId);
    if (!videoFile) errors.push(`${where}（${videoId}）：video_file 不能为空`);

    const ann: Annotation = { rowNumber, videoId, videoFile, tags: parseList(get(r, 'tags')) };

    const actionId = get(r, 'action_id');
    if (actionId) ann.actionId = actionId.toLowerCase() === 'none' ? 'none' : actionId;

    const seg = parseSegments(get(r, 'segments'));
    if (seg.error) errors.push(`${where}（${videoId}）segments：${seg.error}`);
    else if (seg.value) ann.segments = seg.value;

    const voice = parseBool(get(r, 'has_voice'));
    if (voice === 'invalid') errors.push(`${where}（${videoId}）has_voice：只能填 yes / no（或 是 / 否），当前是「${get(r, 'has_voice')}」`);
    else if (voice !== undefined) ann.hasVoice = voice;

    const issuesRaw = get(r, 'issues');
    if (issuesRaw) ann.issues = issuesRaw.toLowerCase() === 'none' ? [] : parseList(issuesRaw);

    const notes = get(r, 'notes');
    if (notes) ann.notes = notes;
    const sourceJob = get(r, 'source_job');
    if (sourceJob) ann.sourceJob = sourceJob;

    annotations.push(ann);
  });

  return { annotations, errors };
}

// ─── 读文件（CSV / XLSX）────────────────────────────────────────

export function readAnnotationRows(file: string): string[][] {
  if (/\.xlsx?$/i.test(file)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(file);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    return rows
      .map(r => r.map(c => String(c ?? '')))
      .filter(r => !r.every(c => c.trim() === '') && !(r[0] && r[0].trimStart().startsWith('#')));
  }
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

export function loadAnnotations(file: string): ParseResult {
  if (!fs.existsSync(file)) {
    return { annotations: [], errors: [`找不到标注文件：${file}（可以用 \`npm run eval -- template\` 生成模板）`] };
  }
  return parseAnnotationRows(readAnnotationRows(file));
}

// ─── 对照知识库校验 ──────────────────────────────────────────────

export interface Knowledge {
  actionIds: string[];
  /** action_id → 该动作所有诊断规则的 issue_id */
  issueIdsByAction: Record<string, string[]>;
}

export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

export function validateAnnotations(
  annotations: Annotation[],
  knowledge: Knowledge,
  opts: { videosDir?: string } = {},
): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const a of annotations) {
    const where = `第 ${a.rowNumber} 行（${a.videoId}）`;

    if (a.actionId === undefined) {
      warnings.push(`${where}：action_id 还没填，动作分类指标会跳过这个视频`);
    } else if (a.actionId !== 'none' && !knowledge.actionIds.includes(a.actionId)) {
      errors.push(`${where}：action_id「${a.actionId}」不在知识库里。可选值：${knowledge.actionIds.join(', ')}，或 none`);
    }

    if (a.issues && a.issues.length > 0) {
      if (!a.actionId || a.actionId === 'none') {
        errors.push(`${where}：填了 issues，就必须同时填 action_id（问题点是按动作区分的）`);
      } else {
        const valid = knowledge.issueIdsByAction[a.actionId] ?? [];
        for (const id of a.issues) {
          if (!valid.includes(id)) {
            errors.push(`${where}：issue_id「${id}」不是 ${a.actionId} 的诊断规则。该动作可选：${valid.join(', ') || '（无）'}，或 none`);
          }
        }
      }
    }

    if (opts.videosDir && a.videoFile) {
      const p = path.join(opts.videosDir, a.videoFile);
      if (!fs.existsSync(p)) warnings.push(`${where}：视频文件不存在（${p}），运行时会跳过`);
    }
  }
  return { errors, warnings };
}
