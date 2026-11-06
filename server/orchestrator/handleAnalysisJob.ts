/**
 * 视频分析 Job 处理器 — Two-Pass Pipeline
 *
 * Pass 1：识别有效乒乓球动作片段（过滤捡球/休息等）
 * Pass 2：聚焦分析有效片段，生成结构化诊断报告
 *
 * 参考：Phase 2-A 设计文档 §5.3 / Codex v6 §20
 */
import db from '../db';
import { generate, getVideoStorage, getPrimaryModel, isLLMError, errorMessage, type JSONSchema, type VideoRef } from '../llm';
import { probeVideoDuration } from '../video/probe';
import { recommendTutorials } from '../tutorials/recommendTutorials';
import { classifyTechnique } from '../videoAnalysis/techniqueClassifier';
import { evaluateClassification, DecisionAction } from '../videoAnalysis/recognitionDecision';
import { getDiagnosisRules } from '../videoAnalysis/analysisKnowledgeLoader';
import { VideoAnalysisLogger } from '../videoAnalysis/videoAnalysisLogger';

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

const ERROR_CODES = {
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
function toAnalysisError(err: unknown, stage: 'pass1' | 'pass2'): Error {
  if (isLLMError(err) && (err.code === 'PARSE_FAILED' || err.code === 'EMPTY_RESPONSE')) {
    return new Error(`${ERROR_CODES.REPORT_PARSE_FAILED}:${stage}`);
  }
  // 其余 LLMError（MODEL_UNAVAILABLE / QUOTA_EXHAUSTED / RATE_LIMITED …）message 已是 `CODE: 细节`
  return err instanceof Error ? err : new Error(errorMessage(err));
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

function formatSeconds(totalSec: number): string {
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

// ─── 主分析函数 ───────────────────────────────────────────────────

async function uploadAndAnalyzeVideo(
  jobId: string,
  videoPath: string,
  mimeType: string,
  analysisType: string,
  videoDurationSec?: number
): Promise<{ payload: AnalysisReportPayload; storage: string; fileRef: string; model: string }> {
  const storage = getVideoStorage();

  // 1. 上传视频到托管存储（海外版：Gemini Files API；国内版：OSS）
  VideoAnalysisLogger.info(jobId, 'VIDEO_UPLOAD_START', `Uploading video to ${storage.name}`, {
    videoPath,
    mimeType,
    analysisType,
    videoDurationSec
  });

  let video: VideoRef;
  try {
    video = await storage.upload(videoPath, mimeType);
  } catch (err: any) {
    const errMsg = ERROR_CODES.VIDEO_UPLOAD_FAILED + ': ' + err.message;
    VideoAnalysisLogger.error(jobId, 'VIDEO_UPLOAD_FAILED', errMsg);
    throw new Error(errMsg);
  }

  const fileRef = video.fileRef;
  VideoAnalysisLogger.info(jobId, 'VIDEO_UPLOAD_SUCCESS', `Successfully uploaded. File ref: ${fileRef}. Waiting for ready state.`);

  // 2. 等待托管侧处理完毕 (processing → ready)
  try {
    video = await storage.waitReady(video, state => {
      VideoAnalysisLogger.info(jobId, 'VIDEO_PROCESSING_POLL', `File state: ${state}`);
    });
  } catch (err: any) {
    VideoAnalysisLogger.error(jobId, 'VIDEO_PROCESSING_FAILED', `Video processing failed: ${err.message}`);
    throw new Error(ERROR_CODES.VIDEO_PROCESSING_FAILED);
  }

  VideoAnalysisLogger.info(jobId, 'VIDEO_READY', `Video is active and ready for analysis`, { uri: video.uri });

  try {
    // ───── Pass 1：有效片段识别 ─────────────────────────────────
    VideoAnalysisLogger.info(jobId, 'PASS1_START', 'Starting Pass 1 segment identification', {
      fps: VIDEO_FPS_PASS1,
      prompt: SEGMENT_IDENTIFICATION_PROMPT
    });

    let rawPass1: any;
    let model: string;
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
      const classResult = await classifyTechnique(video, validSegments, jobId);
      decision = evaluateClassification(classResult);
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

    // ───── 教程关联 ──────────────────────────────────────────────
    const allActionIds: string[] = [];
    const reportsArr: TechniqueReport[] = Array.isArray(finalPayload) ? finalPayload : [finalPayload];
    for (const r of reportsArr) {
      if (Array.isArray(r.action_ids_detected)) {
        allActionIds.push(...r.action_ids_detected);
      }
    }

    const tutorialsMap = new Map<string, { title: string; url: string }[]>();
    for (const actionId of [...new Set(allActionIds)]) {
      const tutorials = recommendTutorials(actionId, [], 2);
      if (tutorials.length > 0) {
        const mapped = tutorials.map(t => ({ title: t.title, url: t.url }));
        tutorialsMap.set(actionId, mapped);
        VideoAnalysisLogger.info(jobId, 'TUTORIALS_RECOMMENDED', `Recommended tutorials for action_id: ${actionId}`, mapped);
      }
    }

    const payload = wrapReportPayload(analysisType, finalPayload, validSegments, tutorialsMap);
    VideoAnalysisLogger.info(jobId, 'PAYLOAD_WRAPPED', 'Analysis report payload wrapped successfully', payload);
    return { payload, storage: storage.name, fileRef, model: finalModel };

  } finally {
    // 清理托管存储中的视频文件
    VideoAnalysisLogger.info(jobId, 'CLEANUP', `Deleting ${storage.name} file: ${fileRef}`);
    await storage.cleanup(video).catch((err: any) => {
      VideoAnalysisLogger.warn(jobId, 'CLEANUP_WARN', `Failed to delete ${storage.name} file ${fileRef}: ${err.message}`);
    });
  }
}

// ─── Job 处理入口（Worker 调用）───────────────────────────────────

export async function processAnalysisJob(jobId: string): Promise<void> {
  // 原子地标记为 running，防止多个进程/线程并发抢占同一个 Job
  const updateResult = db.prepare(
    `UPDATE analysis_jobs SET status = 'running', started_at = ?, attempt_count = attempt_count + 1 WHERE id = ? AND status = 'queued'`
  ).run(new Date().toISOString(), jobId);

  if (updateResult.changes === 0) {
    VideoAnalysisLogger.warn(jobId, 'JOB_SKIP', `Job is not in queued state (already running by another worker), skipping.`);
    return;
  }

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
    VideoAnalysisLogger.error(jobId, 'JOB_LOAD_FAILED', `Job not found in database: ${jobId}`);
    return;
  }

  try {
    // 上传时没探测到时长（或历史任务）则在这里补测一次，用于片段截断
    let videoDuration = job.video_duration;
    if (videoDuration == null) {
      const probed = await probeVideoDuration(job.video_path);
      if (probed !== undefined) {
        videoDuration = probed;
        db.prepare(`UPDATE analysis_jobs SET video_duration = ? WHERE id = ?`).run(probed, jobId);
      }
    }

    VideoAnalysisLogger.info(jobId, 'JOB_START', `Processing video analysis job (${job.analysis_type})`, {
      jobId: job.id,
      videoPath: job.video_path,
      mimeType: job.mime_type,
      videoDuration
    });

    const { payload, storage, fileRef, model } = await uploadAndAnalyzeVideo(
      jobId,
      job.video_path,
      job.mime_type || 'video/mp4',
      job.analysis_type,
      videoDuration ?? undefined
    );

    // 存储报告，标记完成（gemini_file_name 已废弃，改写 provider + file_ref）
    db.prepare(
      `UPDATE analysis_jobs
       SET status = 'done',
           report = ?,
           model = ?,
           provider = ?,
           file_ref = ?,
           completed_at = ?
       WHERE id = ?`
    ).run(
      JSON.stringify(payload),
      model,
      storage,
      fileRef,
      new Date().toISOString(),
      jobId
    );

    VideoAnalysisLogger.info(jobId, 'JOB_SUCCESS', `Job completed successfully`);

  } catch (err: any) {
    const errorCode = errorMessage(err) || 'UNKNOWN_ERROR';
    VideoAnalysisLogger.error(jobId, 'JOB_FAILED', `Job failed with error: ${errorCode}`);

    db.prepare(
      `UPDATE analysis_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`
    ).run(errorCode, new Date().toISOString(), jobId);
  }
}
