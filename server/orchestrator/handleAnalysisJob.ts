/**
 * 视频分析 Job 处理器 — Two-Pass Pipeline
 *
 * Pass 1：识别有效乒乓球动作片段（过滤捡球/休息等）
 * Pass 2：聚焦分析有效片段，生成结构化诊断报告
 *
 * 参考：Phase 2-A 设计文档 §5.3 / Codex v6 §20
 */
import db from '../db';
import { getAI } from '../routes/v1';
import { recommendTutorials } from '../tutorials/recommendTutorials';

// ─── 类型定义 ─────────────────────────────────────────────────────

export interface VideoSegment {
  start: string;  // mm:ss 或 hh:mm:ss
  end: string;
  description?: string;
}

export interface TechniqueReport {
  techName: string;
  problems: { text: string; timestamp: string }[];
  improvements: string[];
  action_ids_detected?: string[];
  valid_segments?: VideoSegment[];
  summaryText?: string;
  videoLinks?: { title: string; url: string }[];
}

export interface AnalysisReportPayload {
  analysis_type: 'technique' | 'match_strategy';
  reports: TechniqueReport[];
  valid_segments?: VideoSegment[];
  schema_version: 'v1';
}

// ─── 错误码 ───────────────────────────────────────────────────────

const ERROR_CODES = {
  NO_VALID_SEGMENTS:        'NO_VALID_SEGMENTS',
  GEMINI_UPLOAD_FAILED:     'GEMINI_UPLOAD_FAILED',
  GEMINI_MODEL_UNAVAILABLE: 'GEMINI_MODEL_UNAVAILABLE',
  GEMINI_PROCESSING_FAILED: 'GEMINI_PROCESSING_FAILED',
  REPORT_PARSE_FAILED:      'REPORT_PARSE_FAILED',
  TIMEOUT:                  'TIMEOUT',
} as const;

const DEFAULT_VIDEO_MODEL = 'gemini-3.1-pro-preview';
const FALLBACK_VIDEO_MODELS = [
  DEFAULT_VIDEO_MODEL,
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

// ─── Prompts ──────────────────────────────────────────────────────

const SEGMENT_IDENTIFICATION_PROMPT = `你是一名专业乒乓球视频分析助手。请观看这段视频，识别出所有包含有效乒乓球动作的时间段。

有效片段包括：正式回合、练习击球、发球练习、多球训练等包含实际击球动作的片段。
需要过滤掉的无效片段：捡球、等待、休息、聊天、走动、调整器材、失误后的停顿等。

请严格按以下 JSON 格式输出（只输出 JSON，不要其他文字）：
{
  "segments": [
    { "start": "mm:ss", "end": "mm:ss", "description": "片段内容简述" }
  ],
  "total_valid_seconds": 数字
}

如果视频内容不是乒乓球相关，请输出：
{ "segments": [], "total_valid_seconds": 0, "not_table_tennis": true }`;

function buildPass2Prompt(analysisType: string, segments: VideoSegment[]): string {
  const segmentList = segments
    .map(s => `- ${s.start}-${s.end}：${s.description || '有效回合'}`)
    .join('\n');

  if (analysisType === 'technique') {
    return `你是一名专业乒乓球教练。请分析这段视频中以下时间段的技术动作：
${segmentList}

请忽略上述时间段以外的画面（捡球、休息等无关内容）。
对有效片段中的技术动作进行诊断，指出问题并给出改进建议。

请严格按以下 JSON 格式输出（只输出 JSON，不要其他文字）：
{
  "techName": "xxx技术诊断报告",
  "summaryText": "整体评价一句话",
  "problems": [{ "text": "问题描述", "timestamp": "mm:ss" }],
  "improvements": ["改进建议1", "改进建议2"],
  "action_ids_detected": ["bh_flick"]
}`;
  } else {
    return `你是一名专业乒乓球战术分析师。请分析这段比赛视频中以下有效回合时间段：
${segmentList}

请忽略回合之间的间歇画面。
为每位球员（标记为球员A和球员B）分别分析技战术特点。

请严格按以下 JSON 格式输出（只输出 JSON，不要其他文字）：
[
  {
    "techName": "球员 A",
    "summaryText": "球员A整体评价",
    "problems": [{ "text": "技术特点描述", "timestamp": "mm:ss" }],
    "improvements": ["战术指导建议"],
    "action_ids_detected": []
  },
  {
    "techName": "球员 B",
    "summaryText": "球员B整体评价",
    "problems": [{ "text": "技术特点描述", "timestamp": "mm:ss" }],
    "improvements": ["战术指导建议"],
    "action_ids_detected": []
  }
]`;
  }
}

// ─── Pass 1 Schema ────────────────────────────────────────────────

const PASS1_SCHEMA = {
  type: 'OBJECT',
  properties: {
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'STRING' },
          end:   { type: 'STRING' },
          description: { type: 'STRING' },
        },
        required: ['start', 'end'],
      },
    },
    total_valid_seconds: { type: 'NUMBER' },
    not_table_tennis: { type: 'BOOLEAN' },
  },
  required: ['segments', 'total_valid_seconds'],
};

// ─── Pass 2 Schemas ───────────────────────────────────────────────

const PROBLEM_ITEM = {
  type: 'OBJECT',
  properties: {
    text: { type: 'STRING' },
    timestamp: { type: 'STRING' },
  },
  required: ['text', 'timestamp'],
};

const TECH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    techName: { type: 'STRING' },
    summaryText: { type: 'STRING' },
    problems: { type: 'ARRAY', items: PROBLEM_ITEM },
    improvements: { type: 'ARRAY', items: { type: 'STRING' } },
    action_ids_detected: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['techName', 'problems', 'improvements'],
};

const MATCH_SCHEMA = {
  type: 'ARRAY',
  items: TECH_SCHEMA,
};

// ─── 工具函数 ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorMessage(err: any): string {
  if (typeof err?.message === 'string') return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isModelUnavailableError(err: any): boolean {
  const msg = getErrorMessage(err);
  return (
    msg.includes('"code":404') ||
    msg.includes('code: 404') ||
    msg.includes('NOT_FOUND') ||
    msg.includes(' is not found for API version ') ||
    msg.includes(' is not supported for generateContent')
  );
}

function getVideoModelCandidates(preferredModel?: string): string[] {
  const configuredModel = preferredModel || process.env.GEMINI_VIDEO_MODEL || '';
  return [...new Set([configuredModel.trim(), ...FALLBACK_VIDEO_MODELS].filter(Boolean))];
}

async function generateContentWithModelFallback(
  ai: any,
  params: Record<string, any>,
  preferredModel?: string
): Promise<{ response: any; model: string }> {
  const candidates = getVideoModelCandidates(preferredModel);
  let lastModelError: any;

  for (const model of candidates) {
    try {
      const response = await ai.models.generateContent({ ...params, model });
      return { response, model };
    } catch (err: any) {
      if (!isModelUnavailableError(err)) throw err;

      lastModelError = err;
      const nextModel = candidates[candidates.indexOf(model) + 1];
      if (nextModel) {
        console.warn(
          `[handleAnalysisJob] Gemini video model unavailable: ${model}; retrying with ${nextModel}`
        );
        continue;
      }
    }
  }

  throw new Error(`${ERROR_CODES.GEMINI_MODEL_UNAVAILABLE}: ${getErrorMessage(lastModelError)}`);
}

/**
 * 解析时间戳 mm:ss 或 hh:mm:ss → 秒数
 */
function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map(Number);
  if (parts.some(isNaN)) return -1;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return -1;
}

/**
 * 校验 Pass 1 输出的 segments：过滤非法/过短/乱序片段
 */
function validateSegments(segments: any[], videoDurationSec?: number): VideoSegment[] {
  if (!Array.isArray(segments)) return [];

  const valid: VideoSegment[] = [];

  for (const seg of segments) {
    if (!seg?.start || !seg?.end) continue;

    const startSec = parseTimestamp(String(seg.start));
    const endSec   = parseTimestamp(String(seg.end));

    if (startSec < 0 || endSec < 0) continue;
    if (endSec <= startSec) continue;                  // start >= end，跳过
    if ((endSec - startSec) < 1) continue;             // 不足 1 秒，跳过

    // 截断到视频时长
    const clampedEnd = videoDurationSec
      ? Math.min(endSec, videoDurationSec)
      : endSec;
    if (clampedEnd <= startSec) continue;

    valid.push({
      start: seg.start,
      end:   videoDurationSec ? formatSeconds(clampedEnd) : seg.end,
      description: typeof seg.description === 'string' ? seg.description : undefined,
    });
  }

  // 最多保留 20 段（按时长降序）
  if (valid.length > 20) {
    valid.sort((a, b) => {
      const durA = parseTimestamp(b.end) - parseTimestamp(b.start);
      const durB = parseTimestamp(a.end) - parseTimestamp(a.start);
      return durA - durB;
    });
    return valid.slice(0, 20);
  }

  return valid;
}

function formatSeconds(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 尝试从字符串中提取第一个 JSON 块（正则提取降级）
 */
function extractJson(text: string): any {
  // 首先尝试直接解析
  try { return JSON.parse(text); } catch { /* continue */ }

  // 提取 [...] 或 {...}
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch { /* continue */ }
  }
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { /* continue */ }
  }

  return null;
}

/**
 * 统一封装报告为 AnalysisReportPayload
 */
function wrapReportPayload(
  analysisType: string,
  reportData: any,
  validSegments: VideoSegment[],
  tutorialsMap: Map<string, { title: string; url: string }[]>
): AnalysisReportPayload {
  const injectTutorials = (report: TechniqueReport): TechniqueReport => {
    const ids: string[] = report.action_ids_detected || [];
    const links = ids.flatMap(id => tutorialsMap.get(id) || []);
    return links.length > 0 ? { ...report, videoLinks: links } : report;
  };

  if (analysisType === 'match_strategy') {
    const arr: TechniqueReport[] = Array.isArray(reportData) ? reportData : [reportData];
    return {
      analysis_type: 'match_strategy',
      reports: arr.map(r => ({ ...injectTutorials(r), variant: arr.indexOf(r) === 0 ? 'blue' : 'gradient' } as any)),
      valid_segments: validSegments,
      schema_version: 'v1',
    };
  } else {
    const report: TechniqueReport = Array.isArray(reportData) ? reportData[0] : reportData;
    return {
      analysis_type: 'technique',
      reports: [{ ...injectTutorials(report), variant: 'gradient' } as any],
      valid_segments: validSegments,
      schema_version: 'v1',
    };
  }
}

// ─── 主分析函数 ───────────────────────────────────────────────────

async function uploadAndAnalyzeVideo(
  videoPath: string,
  mimeType: string,
  analysisType: string,
  videoDurationSec?: number
): Promise<{ payload: AnalysisReportPayload; geminiFileName: string; model: string }> {
  const ai = getAI();

  // 1. 上传视频到 Gemini Files API
  let uploadResult: any;
  try {
    uploadResult = await ai.files.upload({
      file: videoPath,
      config: { mimeType },
    });
  } catch (err: any) {
    throw new Error(ERROR_CODES.GEMINI_UPLOAD_FAILED + ': ' + err.message);
  }

  const geminiFileName: string = uploadResult.name;

  // 2. 轮询等待处理完毕 (PROCESSING → ACTIVE)
  let file = uploadResult;
  let waitMs = 3000;
  while (file.state === 'PROCESSING') {
    await sleep(waitMs);
    waitMs = Math.min(waitMs * 1.5, 10000); // 指数退避，最长 10s
    file = await ai.files.get({ name: geminiFileName });
  }
  if (file.state === 'FAILED') {
    await ai.files.delete({ name: geminiFileName }).catch(() => {});
    throw new Error(ERROR_CODES.GEMINI_PROCESSING_FAILED);
  }

  const fileData = { fileUri: file.uri, mimeType: file.mimeType || mimeType };

  try {
    // ───── Pass 1：有效片段识别 ─────────────────────────────────
    const pass1Result = await generateContentWithModelFallback(ai, {
      contents: [{ role: 'user', parts: [
        { fileData },
        { text: SEGMENT_IDENTIFICATION_PROMPT },
      ]}],
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: PASS1_SCHEMA,
      },
    });
    const pass1Response = pass1Result.response;
    const model = pass1Result.model;

    const rawPass1 = extractJson(pass1Response.text || '');
    if (!rawPass1) {
      throw new Error(ERROR_CODES.REPORT_PARSE_FAILED + ':pass1');
    }

    if (rawPass1.not_table_tennis) {
      throw new Error(ERROR_CODES.NO_VALID_SEGMENTS + ':not_table_tennis');
    }

    const validSegments = validateSegments(rawPass1.segments || [], videoDurationSec);
    if (validSegments.length === 0) {
      throw new Error(ERROR_CODES.NO_VALID_SEGMENTS);
    }

    // ───── Pass 2：聚焦分析 ──────────────────────────────────────
    const pass2Prompt = buildPass2Prompt(analysisType, validSegments);
    const pass2Schema = analysisType === 'technique' ? TECH_SCHEMA : MATCH_SCHEMA;

    const pass2Result = await generateContentWithModelFallback(ai, {
      contents: [{ role: 'user', parts: [
        { fileData },
        { text: pass2Prompt },
      ]}],
      config: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: pass2Schema,
      },
    }, model);
    const pass2Response = pass2Result.response;
    const finalModel = pass2Result.model;

    const rawPass2 = extractJson(pass2Response.text || '');
    if (!rawPass2) {
      throw new Error(ERROR_CODES.REPORT_PARSE_FAILED + ':pass2');
    }

    // ───── 教程关联 ──────────────────────────────────────────────
    const allActionIds: string[] = [];
    const reportsArr: TechniqueReport[] = Array.isArray(rawPass2) ? rawPass2 : [rawPass2];
    for (const r of reportsArr) {
      if (Array.isArray(r.action_ids_detected)) {
        allActionIds.push(...r.action_ids_detected);
      }
    }

    const tutorialsMap = new Map<string, { title: string; url: string }[]>();
    for (const actionId of [...new Set(allActionIds)]) {
      const tutorials = recommendTutorials(actionId, [], 2);
      if (tutorials.length > 0) {
        tutorialsMap.set(actionId, tutorials.map(t => ({ title: t.title, url: t.url })));
      }
    }

    const payload = wrapReportPayload(analysisType, rawPass2, validSegments, tutorialsMap);
    return { payload, geminiFileName, model: finalModel };

  } finally {
    // 清理 Gemini Files API 文件
    await ai.files.delete({ name: geminiFileName }).catch((err: any) => {
      console.warn(`[handleAnalysisJob] Failed to delete Gemini file ${geminiFileName}:`, err.message);
    });
  }
}

// ─── Job 处理入口（Worker 调用）───────────────────────────────────

export async function processAnalysisJob(jobId: string): Promise<void> {
  // 标记为 running
  db.prepare(
    `UPDATE analysis_jobs SET status = 'running', started_at = ?, attempt_count = attempt_count + 1 WHERE id = ?`
  ).run(new Date().toISOString(), jobId);

  // 读取 job 信息
  const job = db.prepare(
    `SELECT id, video_path, mime_type, analysis_type, video_duration FROM analysis_jobs WHERE id = ?`
  ).get(jobId) as {
    id: string;
    video_path: string;
    mime_type: string;
    analysis_type: string;
    video_duration: number | null;
  } | undefined;

  if (!job) {
    console.error(`[handleAnalysisJob] Job not found: ${jobId}`);
    return;
  }

  try {
    console.log(`[handleAnalysisJob] Processing job ${jobId} (${job.analysis_type})`);

    const { payload, geminiFileName, model } = await uploadAndAnalyzeVideo(
      job.video_path,
      job.mime_type || 'video/mp4',
      job.analysis_type,
      job.video_duration ?? undefined
    );

    // 存储报告，标记完成
    db.prepare(
      `UPDATE analysis_jobs
       SET status = 'done',
           report = ?,
           model = ?,
           gemini_file_name = ?,
           completed_at = ?
       WHERE id = ?`
    ).run(
      JSON.stringify(payload),
      model,
      geminiFileName,
      new Date().toISOString(),
      jobId
    );

    console.log(`[handleAnalysisJob] Job ${jobId} completed successfully`);

  } catch (err: any) {
    const errorCode = getErrorMessage(err) || 'UNKNOWN_ERROR';
    console.error(`[handleAnalysisJob] Job ${jobId} failed:`, errorCode);

    db.prepare(
      `UPDATE analysis_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`
    ).run(errorCode, new Date().toISOString(), jobId);
  }
}
