/**
 * 视频分析管道 — Pass 1 → Pass 1.5 → Pass 2
 *
 * Pass 1：识别有效乒乓球动作片段（过滤捡球/休息等）
 * Pass 1.5：技术动作分类（techniqueClassifier）
 * Pass 2：聚焦分析有效片段，生成结构化诊断报告
 *
 * 本文件不依赖数据库：Worker（orchestrator/handleAnalysisJob.ts）和评测脚本（eval/）共用它。
 * 教程推荐等需要数据库的能力通过 PipelineDeps 由调用方注入。
 *
 * 参考：Phase 2-A 设计文档 §5.3 / Codex v6 §20
 */
import { generate, getVideoStorage, getPrimaryModel, isLLMError, errorMessage, type JSONSchema, type Usage, type VideoRef, type VideoStorage } from '../llm';
import { classifyTechniqueDetailed, type ClassificationResult } from './techniqueClassifier';
import { evaluateClassification, type DecisionAction } from './recognitionDecision';
import { getDiagnosisRules } from './analysisKnowledgeLoader';
import { VideoAnalysisLogger } from './videoAnalysisLogger';

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
// 错误码会落库（analysis_jobs.error），并由前端 ANALYSIS_ERROR_MAP 映射为提示文案。
// 与具体模型厂商无关：LLMError 的 message 本身就是 `CODE: 细节`（如 MODEL_UNAVAILABLE、
// QUOTA_EXHAUSTED），原样透传；这里只定义视频分析流程自己产生的错误码。
// 2026-11-06 起不再使用 GEMINI_* 前缀；历史任务里的旧码由前端兼容映射。

export const ERROR_CODES = {
  NO_VALID_SEGMENTS:       'NO_VALID_SEGMENTS',
  VIDEO_UPLOAD_FAILED:     'VIDEO_UPLOAD_FAILED',
  VIDEO_PROCESSING_FAILED: 'VIDEO_PROCESSING_FAILED',
  REPORT_PARSE_FAILED:     'REPORT_PARSE_FAILED',
  TIMEOUT:                 'TIMEOUT',
} as const;

/** 模型名、降级链、重试策略见 server/llm/config.ts（video_pass1 / video_pass15 / video_pass2） */

/** 分 Pass 视频帧率配置（可通过环境变量覆盖） */
const VIDEO_FPS_PASS1  = Number(process.env.VIDEO_FPS_PASS1)  || 2;
const VIDEO_FPS_PASS2  = Number(process.env.VIDEO_FPS_PASS2)  || 5;

// ─── Prompts ──────────────────────────────────────────────────────

const SEGMENT_IDENTIFICATION_PROMPT = `你是一名乒乓球视频片段切割专家。你的唯一任务是：仔细观察视频，找出所有包含有效击球动作的时间段，过滤掉无效内容。
你只负责"在哪些时间段有人在打球"，不需要分析技术动作、评价好坏。

【有效片段】
正式比赛回合、单球/多球对练、发球练习、任何有实际挥拍击球动作的连续训练。（重要：如果击球前有教练的口令、提示或准备动作，请务必将其包含在有效片段内，切勿过早截断！）

【无效内容】
捡球、休息擦汗、纯讲解/示范（无实际击球）、调整器材、回合间的停顿。

【description 填写规则】
只描述场景，必须且只能从以下选取：多球训练、单球对练、发球练习、比赛回合、综合练习。
禁止使用具体技术动作名词（如正手、反手、攻球、拉球等）。

【时间格式】
视频不足1小时用 mm:ss，超过1小时用 hh:mm:ss。

请按 JSON 格式输出：
{
  "segments": [{ "start": "...", "end": "...", "description": "..." }],
  "total_valid_seconds": 所有片段时长之和
}

如果完全非乒乓球视频，输出：{ "not_table_tennis": true, "total_valid_seconds": 0, "segments": [] }
如果视频质量极差（极度模糊/纯黑屏/纯音频）无法分析，输出：{ "unanalyzable": true, "reason": "具体原因", "total_valid_seconds": 0, "segments": [] }`;

function buildPass2Prompt(analysisType: string, segments: VideoSegment[], decision?: DecisionAction): string {
  const segmentList = segments
    .map(s => `- ${s.start}-${s.end}`)
    .join('\n');

  if (analysisType === 'technique') {
    let rulesText = '';
    let targetActionText = '技术动作';
    
    if (decision && decision.status !== 'unknown') {
      const diagRules = getDiagnosisRules();
      if (diagRules) {
        const rulesForAction = diagRules.rules.filter(r => r.action_id === decision.validated_action_id);
        rulesText = `\n【诊断规则约束】\n系统已认定该动作为【${decision.validated_action_id}】。请严格对照以下规则进行诊断：\n`;
        rulesForAction.forEach(r => {
          rulesText += `- 如果看到视觉证据: "${r.evidence}" -> 诊断为: "${r.problem}" -> 训练建议: "${r.advice}"\n`;
        });
        rulesText += `如果遇到规则以外的问题，可以补充，但必须优先匹配上述规则。`;
      }
      targetActionText = `【${decision.validated_action_id}】动作`;
    }

    return `你是一名专业乒乓球教练。请分析这段视频中以下时间段的${targetActionText}：
${segmentList}

请忽略上述时间段以外的画面（捡球、休息等无关内容）。
对有效片段中的技术动作进行诊断，指出问题并给出改进建议。
${rulesText}

请严格按以下 JSON 格式输出（只输出 JSON，不要其他文字）：
{
  "techName": "动作诊断报告标题",
  "summaryText": "${decision?.user_message || '整体评价一句话'}",
  "problems": [{ "text": "问题描述", "timestamp": "mm:ss" }],
  "improvements": ["改进建议1", "改进建议2"],
  "action_ids_detected": ["${decision?.validated_action_id || ''}"]
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

const PASS1_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'string' },
          end:   { type: 'string' },
          description: { type: 'string' },
        },
        required: ['start', 'end'],
      },
    },
    total_valid_seconds: { type: 'number' },
    not_table_tennis: { type: 'boolean' },
    unanalyzable: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['segments', 'total_valid_seconds'],
};

// ─── Pass 2 Schemas ───────────────────────────────────────────────

const PROBLEM_ITEM: JSONSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    timestamp: { type: 'string' },
  },
  required: ['text', 'timestamp'],
};

const TECH_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    techName: { type: 'string' },
    summaryText: { type: 'string' },
    problems: { type: 'array', items: PROBLEM_ITEM },
    improvements: { type: 'array', items: { type: 'string' } },
    action_ids_detected: { type: 'array', items: { type: 'string' } },
  },
  required: ['techName', 'problems', 'improvements'],
};

const MATCH_SCHEMA: JSONSchema = {
  type: 'array',
  items: TECH_SCHEMA,
};

// ─── 工具函数 ─────────────────────────────────────────────────────

/**
 * 把抽象层的中立错误转换为视频分析错误码（落库 / 前端映射用）
 * @param stage 'pass1' | 'pass2'，用于 REPORT_PARSE_FAILED 的细分
 */
export function toAnalysisError(err: unknown, stage: 'pass1' | 'pass2'): Error {
  if (isLLMError(err) && (err.code === 'PARSE_FAILED' || err.code === 'EMPTY_RESPONSE')) {
    return new Error(`${ERROR_CODES.REPORT_PARSE_FAILED}:${stage}`);
  }
  // 其余 LLMError（MODEL_UNAVAILABLE / QUOTA_EXHAUSTED / RATE_LIMITED …）message 已是 `CODE: 细节`
  return err instanceof Error ? err : new Error(errorMessage(err));
}

/**
 * 解析时间戳 mm:ss 或 hh:mm:ss → 秒数
 */
export function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map(Number);
  if (parts.some(isNaN)) return -1;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return -1;
}

/**
 * 校验 Pass 1 输出的 segments：过滤非法/过短/乱序片段
 */
export function validateSegments(segments: any[], videoDurationSec?: number): VideoSegment[] {
  if (!Array.isArray(segments)) return [];

  const valid: { startSec: number; endSec: number; description?: string }[] = [];

  for (const seg of segments) {
    if (!seg?.start || !seg?.end) continue;

    const startSec = parseTimestamp(String(seg.start));
    const endSec   = parseTimestamp(String(seg.end));

    if (startSec < 0 || endSec < 0) continue;
    if (endSec <= startSec) continue;                  // start >= end，跳过
    if ((endSec - startSec) < 1) continue;             // 不足 1 秒，跳过

    // 引入首尾缓冲：向前扩充 3 秒（以确保捕捉到击球前教练的“蹲/起”等口令），向后扩充 1 秒，避免截断
    let bufferedStart = Math.max(0, startSec - 3);
    let bufferedEnd   = endSec + 1;

    // 截断到视频时长
    if (videoDurationSec) {
      bufferedEnd = Math.min(bufferedEnd, videoDurationSec);
    }
    
    if (bufferedEnd <= bufferedStart) continue;

    valid.push({
      startSec: bufferedStart,
      endSec: bufferedEnd,
      description: typeof seg.description === 'string' ? seg.description : undefined,
    });
  }

  // 按起始时间升序排列
  valid.sort((a, b) => a.startSec - b.startSec);

  // 智能合并：如果两个片段间隔 <= 5 秒，则合并为一个片段
  const merged: { startSec: number; endSec: number; description?: string }[] = [];
  for (const seg of valid) {
    if (merged.length === 0) {
      merged.push(seg);
    } else {
      const last = merged[merged.length - 1];
      if (seg.startSec - last.endSec <= 5) {
        // 合并
        last.endSec = Math.max(last.endSec, seg.endSec);
        // 如果 description 不同且都不为空，可以简单拼接
        if (seg.description && last.description && !last.description.includes(seg.description)) {
          last.description = last.description + ' / ' + seg.description;
        } else if (!last.description && seg.description) {
          last.description = seg.description;
        }
      } else {
        merged.push(seg);
      }
    }
  }

  // 转换回 VideoSegment 格式，并最多保留 20 段（按时长降序）
  const result: VideoSegment[] = merged.map(seg => ({
    start: formatSeconds(seg.startSec),
    end: formatSeconds(seg.endSec),
    description: seg.description
  }));

  if (result.length > 20) {
    result.sort((a, b) => {
      const durA = parseTimestamp(b.end) - parseTimestamp(b.start);
      const durB = parseTimestamp(a.end) - parseTimestamp(a.start);
      return durA - durB;
    });
    return result.slice(0, 20);
  }

  return result;
}

export function formatSeconds(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
  const deduplicateProblems = (problems: any[]) => {
    if (!problems || !Array.isArray(problems)) return problems;
    
    const merged = new Map<string, { text: string; timestamps: string[] }>();
    for (const p of problems) {
      if (!p.text) continue;
      
      // Normalize text for deduplication to ignore markdown and trailing punctuation
      let key = p.text.trim();
      key = key.replace(/^(#{1,6}|[*+\->]|\d+\.)\s+/, '');
      key = key.replace(/(\*\*|__)(.*?)\1/g, '$2');
      key = key.replace(/([*_])(.*?)\1/g, '$2');
      key = key.replace(/`([^`]+)`/g, '$1');
      key = key.replace(/[。，！？,!?.\s]+$/, '');
      key = key.trim();
      
      if (!key) continue;

      if (!merged.has(key)) {
        // Keep the original text for the first occurrence
        let display_text = p.text.replace(/^(#{1,6}|[*+\->]|\d+\.)\s+/, '').trim();
        merged.set(key, { text: display_text, timestamps: [] });
      }
      if (p.timestamp && !merged.get(key)!.timestamps.includes(p.timestamp)) {
        merged.get(key)!.timestamps.push(p.timestamp);
      }
    }
    
    const result = [];
    for (const value of merged.values()) {
      result.push({
        text: value.text,
        timestamp: value.timestamps.length > 0 ? value.timestamps.join(', ') : ''
      });
    }
    return result;
  };

  const processReport = (report: TechniqueReport): TechniqueReport => {
    const ids: string[] = report.action_ids_detected || [];
    const links = ids.flatMap(id => tutorialsMap.get(id) || []);
    const processedReport = { ...report };
    if (processedReport.problems) {
      processedReport.problems = deduplicateProblems(processedReport.problems);
    }
    if (links.length > 0) {
      processedReport.videoLinks = links;
    }
    return processedReport;
  };

  if (analysisType === 'match_strategy') {
    const arr: TechniqueReport[] = Array.isArray(reportData) ? reportData : [reportData];
    return {
      analysis_type: 'match_strategy',
      reports: arr.map(r => ({ ...processReport(r), variant: arr.indexOf(r) === 0 ? 'blue' : 'gradient' } as any)),
      valid_segments: validSegments,
      schema_version: 'v1',
    };
  } else {
    const report: TechniqueReport = Array.isArray(reportData) ? reportData[0] : reportData;
    return {
      analysis_type: 'technique',
      reports: [{ ...processReport(report), variant: 'gradient' } as any],
      valid_segments: validSegments,
      schema_version: 'v1',
    };
  }
}

// ─── Trace：各环节的结构化输出（落库 + 评测用）───────────────────────
//
// 此前 Pass 1.5 的分类结果只写在日志里。trace 把三个环节的原始输出、命中的模型、
// 耗时、token 用量和 Schema 校验问题结构化保存，既写入 analysis_jobs.trace，
// 也是评测脚本的数据来源。不包含 prompt 和视频本身，体积很小。

export interface PassMeta {
  /** 实际命中的模型（发生降级时与首选不同） */
  model: string;
  durationMs: number;
  usage?: Usage;
  /** Schema 校验未通过的字段说明；为空表示通过 */
  schemaErrors?: string[];
}

export interface AnalysisTrace {
  analysisType: string;
  /** 视频托管实现名（gemini_files / 后续 aliyun_oss） */
  storage?: string;
  videoDurationSec?: number;
  timingsMs: {
    upload?: number;
    ready?: number;
    /** Pass 1 + 1.5 + 2 合计（不含上传） */
    passes?: number;
    /** 端到端：上传 + 等待就绪 + 各环节 + 清理 */
    total?: number;
  };
  pass1?: PassMeta & { raw: unknown; segments: VideoSegment[] };
  pass15?: PassMeta & { result: ClassificationResult; decision: DecisionAction };
  pass2?: PassMeta & { raw: unknown };
  /** 失败时的错误（`错误码: 细节`），成功时为空 */
  error?: string;
}

export function createTrace(analysisType: string, videoDurationSec?: number): AnalysisTrace {
  return { analysisType, videoDurationSec, timingsMs: {} };
}

/** 管道的外部依赖。教程推荐依赖数据库，所以由调用方注入；评测等不需要时不传即可 */
export interface PipelineDeps {
  recommendTutorials?: (actionId: string, tags: string[], limit: number) => { title: string; url: string }[];
}

// ─── 视频上传 / 清理（可复用：评测的多次重复运行只需上传一次）──────────

/** 上传最多尝试 3 次（首次 + 2 次重试），退避 2s、4s */
const UPLOAD_RETRY_DELAYS_MS = [2000, 4000];

/**
 * 判断上传失败是否可能是临时性的（网络抖动、限流、服务端 5xx）。
 * 文件本身有问题（格式不对、太大、不存在）的错误不重试，重试也不会好。
 */
export function isTransientUploadError(message: string): boolean {
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket|network|timeout|timed out|UNAVAILABLE|overloaded|\b(429|500|502|503|504)\b/i.test(message);
}

/** 带重试的上传：只对临时性错误重试；最后一次仍失败则抛出最后一次的错误 */
export async function uploadWithRetry(
  storage: VideoStorage,
  videoPath: string,
  mimeType: string,
  onRetry?: (attempt: number, delayMs: number, message: string) => void,
  delaysMs: number[] = UPLOAD_RETRY_DELAYS_MS,
): Promise<VideoRef> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await storage.upload(videoPath, mimeType);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (attempt < delaysMs.length && isTransientUploadError(message)) {
        onRetry?.(attempt + 1, delaysMs[attempt], message);
        await new Promise(resolve => setTimeout(resolve, delaysMs[attempt]));
        continue;
      }
      throw err;
    }
  }
}

export async function uploadVideoForAnalysis(
  jobId: string,
  videoPath: string,
  mimeType: string,
  info: { analysisType: string; videoDurationSec?: number },
  trace?: AnalysisTrace,
): Promise<{ storage: VideoStorage; video: VideoRef }> {
  const storage = getVideoStorage();

  // 1. 上传视频到托管存储（海外版：Gemini Files API；国内版：OSS）
  VideoAnalysisLogger.info(jobId, 'VIDEO_UPLOAD_START', `Uploading video to ${storage.name}`, {
    videoPath,
    mimeType,
    analysisType: info.analysisType,
    videoDurationSec: info.videoDurationSec
  });

  const uploadStart = Date.now();
  let video: VideoRef;
  try {
    video = await uploadWithRetry(storage, videoPath, mimeType, (attempt, delayMs, message) => {
      VideoAnalysisLogger.warn(jobId, 'VIDEO_UPLOAD_RETRY', `Upload attempt ${attempt} failed (${message}); retrying in ${delayMs}ms`);
    });
  } catch (err: any) {
    const errMsg = ERROR_CODES.VIDEO_UPLOAD_FAILED + ': ' + err.message;
    VideoAnalysisLogger.error(jobId, 'VIDEO_UPLOAD_FAILED', errMsg);
    throw new Error(errMsg);
  }
  const uploadMs = Date.now() - uploadStart;

  VideoAnalysisLogger.info(jobId, 'VIDEO_UPLOAD_SUCCESS', `Successfully uploaded. File ref: ${video.fileRef}. Waiting for ready state.`);

  // 2. 等待托管侧处理完毕 (processing → ready)
  const readyStart = Date.now();
  try {
    video = await storage.waitReady(video, state => {
      VideoAnalysisLogger.info(jobId, 'VIDEO_PROCESSING_POLL', `File state: ${state}`);
    });
  } catch (err: any) {
    VideoAnalysisLogger.error(jobId, 'VIDEO_PROCESSING_FAILED', `Video processing failed: ${err.message}`);
    await storage.cleanup(video).catch(() => {}); // 尽力清理，避免托管侧残留
    throw new Error(ERROR_CODES.VIDEO_PROCESSING_FAILED);
  }

  VideoAnalysisLogger.info(jobId, 'VIDEO_READY', `Video is active and ready for analysis`, { uri: video.uri });

  if (trace) {
    trace.storage = storage.name;
    trace.timingsMs.upload = uploadMs;
    trace.timingsMs.ready = Date.now() - readyStart;
  }
  return { storage, video };
}

/** 清理托管存储中的视频文件（失败只告警，不抛错） */
export async function cleanupAnalysisVideo(jobId: string, storage: VideoStorage, video: VideoRef): Promise<void> {
  VideoAnalysisLogger.info(jobId, 'CLEANUP', `Deleting ${storage.name} file: ${video.fileRef}`);
  await storage.cleanup(video).catch((err: any) => {
    VideoAnalysisLogger.warn(jobId, 'CLEANUP_WARN', `Failed to delete ${storage.name} file ${video.fileRef}: ${err.message}`);
  });
}

// ─── 分析主流程：Pass 1 → Pass 1.5 → Pass 2（视频已上传就绪）─────────────

export async function runAnalysisPasses(args: {
  jobId: string;
  video: VideoRef;
  analysisType: string;
  videoDurationSec?: number;
  /** 由调用方创建并传入；流程中逐步填充，失败时调用方仍能拿到已完成环节的输出 */
  trace: AnalysisTrace;
  deps?: PipelineDeps;
}): Promise<{ payload: AnalysisReportPayload; model: string }> {
  const { jobId, video, analysisType, videoDurationSec, trace, deps } = args;
  const passesStart = Date.now();

  try {
    // ───── Pass 1：有效片段识别 ─────────────────────────────────
    VideoAnalysisLogger.info(jobId, 'PASS1_START', 'Starting Pass 1 segment identification', {
      fps: VIDEO_FPS_PASS1,
      prompt: SEGMENT_IDENTIFICATION_PROMPT
    });

    let rawPass1: any;
    let model: string;
    const pass1Start = Date.now();
    try {
      const pass1Result = await generate({
        capability: 'video_pass1',
        messages: [{ role: 'user', parts: [
          { type: 'video', ref: video, fps: VIDEO_FPS_PASS1 },
          { type: 'text', text: SEGMENT_IDENTIFICATION_PROMPT },
        ]}],
        temperature: 0.1,
        responseSchema: PASS1_SCHEMA,
        traceId: jobId,
      });
      rawPass1 = pass1Result.json;
      model = pass1Result.model;
      trace.pass1 = {
        model,
        durationMs: Date.now() - pass1Start,
        usage: pass1Result.usage,
        schemaErrors: pass1Result.schemaErrors,
        raw: rawPass1,
        segments: [],
      };
      VideoAnalysisLogger.info(jobId, 'PASS1_OUTPUT', 'Pass 1 raw output received', {
        model,
        rawPass1,
        schemaErrors: pass1Result.schemaErrors,
      });
    } catch (err) {
      const mapped = toAnalysisError(err, 'pass1');
      VideoAnalysisLogger.error(jobId, 'PASS1_FAILED', mapped.message);
      throw mapped;
    }

    if (!rawPass1) {
      const errMsg = ERROR_CODES.REPORT_PARSE_FAILED + ':pass1';
      VideoAnalysisLogger.error(jobId, 'PASS1_FAILED', errMsg);
      throw new Error(errMsg);
    }

    if (rawPass1.not_table_tennis) {
      const errMsg = ERROR_CODES.NO_VALID_SEGMENTS + ':not_table_tennis';
      VideoAnalysisLogger.warn(jobId, 'PASS1_FAILED', errMsg);
      throw new Error(errMsg);
    }

    if (rawPass1.unanalyzable) {
      const errMsg = ERROR_CODES.NO_VALID_SEGMENTS + ':unanalyzable (' + (rawPass1.reason || 'unknown reason') + ')';
      VideoAnalysisLogger.warn(jobId, 'PASS1_FAILED', errMsg);
      throw new Error(errMsg);
    }

    const validSegments = validateSegments(rawPass1.segments || [], videoDurationSec);
    trace.pass1!.segments = validSegments;
    VideoAnalysisLogger.info(jobId, 'PASS1_VALIDATED', 'Segments validated successfully', {
      rawSegmentsCount: rawPass1.segments?.length || 0,
      validatedSegmentsCount: validSegments.length,
      validSegments
    });

    if (validSegments.length === 0) {
      const errMsg = ERROR_CODES.NO_VALID_SEGMENTS;
      VideoAnalysisLogger.warn(jobId, 'PASS1_FAILED', errMsg);
      throw new Error(errMsg);
    }

    // ───── Pass 1.5 & Pass 2 ──────────────────────────────────────
    let finalPayload: any;
    let finalModel = model;
    let decision: DecisionAction | undefined;

    if (analysisType === 'technique') {
      // 独立分类环节 Pass 1.5（模型与降级链见 video_pass15 能力配置）
      const pass15Start = Date.now();
      const outcome = await classifyTechniqueDetailed(video, validSegments, jobId);
      const classResult = outcome.result;
      decision = evaluateClassification(classResult);
      trace.pass15 = {
        model: outcome.model,
        durationMs: Date.now() - pass15Start,
        usage: outcome.usage,
        schemaErrors: outcome.schemaErrors,
        result: classResult,
        decision,
      };
      VideoAnalysisLogger.info(jobId, 'DECISION', 'Evaluation decision calculated', decision);

      if (decision.status === 'unknown') {
        // 直接降级，跳过 Pass 2 诊断
        VideoAnalysisLogger.info(jobId, 'DECISION_DOWNGRADE', 'Decision status is unknown, bypassing Pass 2 diagnosis');
        finalPayload = {
          techName: '未识别技术动作',
          summaryText: decision.user_message,
          problems: [],
          improvements: [],
          action_ids_detected: []
        };
      }
    }

    if (!finalPayload) {
      // 进入正常诊断环节 Pass 2
      const pass2Prompt = buildPass2Prompt(analysisType, validSegments, decision);
      const pass2Schema = analysisType === 'technique' ? TECH_SCHEMA : MATCH_SCHEMA;

      VideoAnalysisLogger.info(jobId, 'PASS2_START', 'Starting Pass 2 diagnosis', {
        analysisType,
        fps: VIDEO_FPS_PASS2,
        model: getPrimaryModel('video_pass2') ?? finalModel, // 首选模型；实际命中的模型见 PASS2_OUTPUT
        prompt: pass2Prompt
      });

      let rawPass2: any;
      const pass2Start = Date.now();
      try {
        const pass2Result = await generate({
          capability: 'video_pass2',
          messages: [{ role: 'user', parts: [
            { type: 'video', ref: video, fps: VIDEO_FPS_PASS2 },
            { type: 'text', text: pass2Prompt },
          ]}],
          temperature: 0.2,
          responseSchema: pass2Schema,
          traceId: jobId,
        });
        rawPass2 = pass2Result.json;
        finalModel = pass2Result.model;
        trace.pass2 = {
          model: finalModel,
          durationMs: Date.now() - pass2Start,
          usage: pass2Result.usage,
          schemaErrors: pass2Result.schemaErrors,
          raw: rawPass2,
        };
        VideoAnalysisLogger.info(jobId, 'PASS2_OUTPUT', 'Pass 2 raw output received', {
          model: finalModel,
          rawPass2,
          schemaErrors: pass2Result.schemaErrors,
        });
      } catch (err) {
        const mapped = toAnalysisError(err, 'pass2');
        VideoAnalysisLogger.error(jobId, 'PASS2_FAILED', mapped.message);
        throw mapped;
      }

      if (!rawPass2) {
        const errMsg = ERROR_CODES.REPORT_PARSE_FAILED + ':pass2';
        VideoAnalysisLogger.error(jobId, 'PASS2_FAILED', errMsg);
        throw new Error(errMsg);
      }
      finalPayload = rawPass2;
    }

    // 确保强行写入受信任的 action_id
    if (analysisType === 'technique' && decision && decision.validated_action_id !== 'unknown') {
      if (!Array.isArray(finalPayload)) {
        finalPayload.action_ids_detected = [decision.validated_action_id];
      }
    }

    // ───── 教程关联（可选依赖）─────────────────────────────────────
    const allActionIds: string[] = [];
    const reportsArr: TechniqueReport[] = Array.isArray(finalPayload) ? finalPayload : [finalPayload];
    for (const r of reportsArr) {
      if (Array.isArray(r.action_ids_detected)) {
        allActionIds.push(...r.action_ids_detected);
      }
    }

    const tutorialsMap = new Map<string, { title: string; url: string }[]>();
    if (deps?.recommendTutorials) {
      for (const actionId of [...new Set(allActionIds)]) {
        const tutorials = deps.recommendTutorials(actionId, [], 2);
        if (tutorials.length > 0) {
          const mapped = tutorials.map(t => ({ title: t.title, url: t.url }));
          tutorialsMap.set(actionId, mapped);
          VideoAnalysisLogger.info(jobId, 'TUTORIALS_RECOMMENDED', `Recommended tutorials for action_id: ${actionId}`, mapped);
        }
      }
    }

    const payload = wrapReportPayload(analysisType, finalPayload, validSegments, tutorialsMap);
    VideoAnalysisLogger.info(jobId, 'PAYLOAD_WRAPPED', 'Analysis report payload wrapped successfully', payload);
    return { payload, model: finalModel };
  } finally {
    trace.timingsMs.passes = Date.now() - passesStart;
  }
}

// ─── 上传 + 分析 + 清理（Worker 使用）────────────────────────────────

export async function uploadAndAnalyzeVideo(args: {
  jobId: string;
  videoPath: string;
  mimeType: string;
  analysisType: string;
  videoDurationSec?: number;
  trace: AnalysisTrace;
  deps?: PipelineDeps;
}): Promise<{ payload: AnalysisReportPayload; storage: string; fileRef: string; model: string }> {
  const { jobId, videoPath, mimeType, analysisType, videoDurationSec, trace, deps } = args;
  const start = Date.now();

  try {
    const { storage, video } = await uploadVideoForAnalysis(
      jobId, videoPath, mimeType, { analysisType, videoDurationSec }, trace
    );
    try {
      const { payload, model } = await runAnalysisPasses({ jobId, video, analysisType, videoDurationSec, trace, deps });
      return { payload, storage: storage.name, fileRef: video.fileRef, model };
    } finally {
      await cleanupAnalysisVideo(jobId, storage, video);
    }
  } finally {
    trace.timingsMs.total = Date.now() - start;
  }
}

