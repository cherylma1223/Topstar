
import type { AnalysisReport } from './types.ts';

/**
 * Gemini Service — 通过后端代理访问 AI 能力
 * 所有 API Key 仅存在于服务端，前端不持有任何密钥
 */

const OFF_TOP_REPLY = "抱歉，我只能回答乒乓球相关的问题。您可以尝试上传您的训练或比赛视频，让我为您进行深度分析，也可以根据您的打法推荐器材。";


/**
 * 通用的指数退避重试包装函数
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const isRetryable =
        error?.message?.includes('overloaded') ||
        error?.message?.includes('503') ||
        error?.message?.includes('429') ||
        error?.message?.includes('fetch');

      if (i < maxRetries && isRetryable) {
        const delay = initialDelay * Math.pow(2, i);
        console.warn(`API request failed. Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export interface RecommendedTutorial {
  tutorial_id: string;
  title: string;
  url: string;
  platform: string;
  author?: string;
  _score?: number;
  _warn?: string;
}

export interface ChatResponseV2 {
  success: boolean;
  answerText: string;
  intent: string;
  references: { type: string; id: string; title: string }[];
  tutorialVideos: RecommendedTutorial[];
  report?: any;
}

/**
 * AI 聊天 — 通过后端代理 V2 (结构化返回)
 */
export const getAIResponseV2 = async (
  message: string, 
  history: { sender: string, content: string }[] = [], 
  event?: string
): Promise<ChatResponseV2> => {
  try {
    const data = await withRetry(async () => {
      const res = await fetch('/api/v2/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, event }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error?.message || err.error || `HTTP ${res.status}`);
      }
      return res.json();
    });

    return data;
  } catch (error) {
    console.error("Gemini Service V2 Error:", error);
    let fallbackMsg = "AI 助手目前正忙（服务过载），请稍后重试。";
    if (error instanceof TypeError && error.message.includes('fetch')) {
      fallbackMsg = "网络连接失败，请检查您的网络环境。";
    }
    
    // 构造降级的 V2 返回结构
    return {
      success: false,
      answerText: fallbackMsg,
      intent: 'OFF_TOPIC',
      references: [],
      tutorialVideos: []
    };
  }
};

/**
 * TTS
 */
export interface TTSRequest {
  contentType: 'text' | 'report';
  text?: string;
  report?: AnalysisReport;
  isFieldGuidance?: boolean;
  voice?: string;
  locale?: string;
}

export interface TTSSegment {
  segment_id: string;
  order: number;
  text: string;
  audio: {
    mime_type: string;
    sample_rate: number;
    data: string;
  };
}

export interface TTSResponse {
  success: boolean;
  request_id: string;
  cache_hit: boolean;
  voice: string;
  segments: TTSSegment[];
  metrics?: {
    provider_model?: string;
    generation_ms?: number;
  };
}

const speechPlanCache = new Map<string, Promise<TTSResponse | null>>();
const decodedSpeechCache = new Map<string, Promise<AudioBuffer[] | null>>();
let sharedAudioContext: AudioContext | null = null;

function sanitizeTextForTTS(text: string): string {
  return text
    .replace(/\[LOCKED_VIP_CONTENT\]/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_>#~-]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stripVipSections(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let insideVip = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const headerMatch = line.match(/【([^】]+)】/);

    if (headerMatch) {
      const title = headerMatch[1];
      insideVip = title.includes('VIP') || title.includes('秘诀');
      if (insideVip) continue;
    }

    if (!insideVip) {
      kept.push(rawLine);
    }
  }

  return kept.join('\n');
}

function buildTextSegments(answerText: string): { segment_id: string; order: number; text: string }[] {
  const stripped = sanitizeTextForTTS(stripVipSections(answerText));
  const lines = stripped.split('\n').map(line => line.trim()).filter(Boolean);
  const segments: { segment_id: string; order: number; text: string }[] = [];
  const introLines: string[] = [];
  let currentTitle = '';
  let currentLines: string[] = [];
  let skipSection = false;

  const flushCurrent = () => {
    const content = sanitizeTextForTTS(currentLines.join(' '));
    if (!content) return;

    segments.push({
      segment_id: currentTitle || `segment_${segments.length}`,
      order: segments.length,
      text: currentTitle ? `${currentTitle}：${content}` : content,
    });
  };

  for (const line of lines) {
    const headerMatch = line.match(/^【([^】]+)】$/);
    if (headerMatch) {
      if (!skipSection) flushCurrent();
      currentTitle = '';
      currentLines = [];

      const title = headerMatch[1];
      skipSection = title.includes('视频') || title.includes('VIP') || title.includes('秘诀');
      if (!skipSection) currentTitle = title;
      continue;
    }

    if (skipSection) continue;

    if (!currentTitle && segments.length === 0) {
      introLines.push(line);
      continue;
    }

    currentLines.push(line);
  }

  const intro = sanitizeTextForTTS(introLines.join(' '));
  if (intro) {
    segments.unshift({
      segment_id: 'summary',
      order: 0,
      text: intro,
    });
  }

  if (!skipSection) flushCurrent();

  return segments
    .map((segment, index) => ({ ...segment, order: index }))
    .filter(segment => Boolean(segment.text));
}

function buildReportSegments(report?: AnalysisReport, isFieldGuidance?: boolean): { segment_id: string; order: number; text: string }[] {
  const segments: { segment_id: string; order: number; text: string }[] = [];
  const summary = sanitizeTextForTTS(stripVipSections(report?.summaryText || ''));
  const techName = sanitizeTextForTTS(report?.techName || '');
  const problemTitle = isFieldGuidance ? '技术特点' : '技术问题';
  const improvementTitle = isFieldGuidance ? '战术指导' : '训练建议';
  const problems = Array.isArray(report?.problems) ? report.problems.map(item => item?.text).filter(Boolean) : [];
  const improvements = Array.isArray(report?.improvements) ? report.improvements.filter(Boolean) : [];

  const summaryParts = [techName, summary].filter(Boolean);
  if (summaryParts.length > 0) {
    segments.push({
      segment_id: 'summary',
      order: segments.length,
      text: sanitizeTextForTTS(summaryParts.join('。')),
    });
  }

  if (problems.length > 0) {
    segments.push({
      segment_id: 'problems',
      order: segments.length,
      text: sanitizeTextForTTS(`${problemTitle}：${problems.join('。')}`),
    });
  }

  if (improvements.length > 0) {
    segments.push({
      segment_id: 'improvements',
      order: segments.length,
      text: sanitizeTextForTTS(`${improvementTitle}：${improvements.join('。')}`),
    });
  }

  return segments.filter(segment => Boolean(segment.text));
}

export function getSharedAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  }
  return sharedAudioContext;
}

export function getTTSRequestKey(request: TTSRequest): string {
  if (request.contentType === 'report') {
    return JSON.stringify({
      contentType: 'report',
      techName: request.report?.techName || '',
      summaryText: request.report?.summaryText || '',
      problems: request.report?.problems?.map(item => item.text) || [],
      improvements: request.report?.improvements || [],
      isFieldGuidance: Boolean(request.isFieldGuidance),
      voice: request.voice || 'Kore',
      locale: request.locale || 'zh-CN',
    });
  }

  return JSON.stringify({
    contentType: 'text',
    text: request.text || '',
    voice: request.voice || 'Kore',
    locale: request.locale || 'zh-CN',
  });
}

async function fetchSpeechPlan(request: TTSRequest): Promise<TTSResponse | null> {
  const cacheKey = getTTSRequestKey(request);
  const cached = speechPlanCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const data = await withRetry(async () => {
        const res = await fetch('/api/v2/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...request,
            voice: request.voice || 'Kore',
            locale: request.locale || 'zh-CN',
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error?.message || err.error || `HTTP ${res.status}`);
        }
        return res.json();
      }, 1, 300);

      return data;
    } catch (error) {
      console.error('TTS API Error Details:', error);
      speechPlanCache.delete(cacheKey);
      return null;
    }
  })();

  speechPlanCache.set(cacheKey, promise);
  return promise;
}

export function prefetchSpeech(request: TTSRequest): void {
  void fetchSpeechPlan(request);
}

export async function getSpeechAudioBuffers(request: TTSRequest): Promise<AudioBuffer[] | null> {
  const cacheKey = getTTSRequestKey(request);
  const cached = decodedSpeechCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetchSpeechPlan(request);
    if (!response?.segments?.length) return null;

    const ctx = getSharedAudioContext();
    const buffers = await Promise.all(
      response.segments.map(segment =>
        decodeAudioData(
          decodeBase64(segment.audio.data),
          ctx,
          segment.audio.sample_rate || 24000,
          1,
        )
      )
    );

    return buffers;
  })();

  decodedSpeechCache.set(cacheKey, promise);
  return promise;
}

export const generateSpeech = async (text: string) => {
  try {
    const response = await fetchSpeechPlan({
      contentType: 'text',
      text,
    });
    return response?.segments?.[0]?.audio?.data || null;
  } catch (error) {
    console.error('TTS API Error Details:', error);
    return null;
  }
};

/**
 * 音频解码与处理工具函数
 */
export function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// ─── 视频分析任务 API（Phase 2-A）────────────────────────────────

/** 错误码 → 用户友好提示 */
const ANALYSIS_ERROR_MAP: Record<string, string> = {
  NO_VALID_SEGMENTS:            '未识别到有效的乒乓球动作片段，请上传包含击球练习或比赛回合的视频',
  'NO_VALID_SEGMENTS:not_table_tennis': '视频内容似乎不是乒乓球相关，请重新上传',
  VIDEO_UPLOAD_FAILED:          '视频上传失败，请检查网络后重试',
  VIDEO_PROCESSING_FAILED:      '视频处理失败，请稍后重试',
  MODEL_UNAVAILABLE:            '当前视频分析模型不可用，请稍后重试或联系管理员检查服务端模型配置',
  RATE_LIMITED:                 '分析服务繁忙，请稍后重试',
  UPSTREAM_UNAVAILABLE:         '分析服务繁忙，请稍后重试',
  QUOTA_EXHAUSTED:              '分析服务暂时不可用，请联系管理员',
  REPORT_PARSE_FAILED:          '分析结果解析失败，请重试',
  'REPORT_PARSE_FAILED:pass1':  '片段识别失败，请重试',
  'REPORT_PARSE_FAILED:pass2':  '分析报告生成失败，请重试',
  TIMEOUT:                      '分析超时，请上传更短的视频（建议 ≤ 60 秒）后重试',

  // 2026-11-06 前的历史任务（analysis_jobs.error）仍带有旧的 GEMINI_* 错误码，保持兼容
  GEMINI_UPLOAD_FAILED:         '视频上传失败，请检查网络后重试',
  GEMINI_MODEL_UNAVAILABLE:     '当前视频分析模型不可用，请稍后重试或联系管理员检查服务端模型配置',
  GEMINI_PROCESSING_FAILED:     '视频处理失败，请稍后重试',
};

export interface AnalysisJobStatus {
  success: boolean;
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  analysis_type: string;
  report?: any;          // AnalysisReportPayload when done
  error?: string;        // error code when failed
  errorMessage?: string; // friendly message
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

/**
 * 上传视频文件，创建分析 job
 */
export async function createAnalysisJob(
  videoFile: File,
  analysisType: 'technique' | 'match_strategy'
): Promise<{ success: boolean; job_id: string; status: string }> {
  const formData = new FormData();
  formData.append('video', videoFile);
  formData.append('analysis_type', analysisType);

  const res = await fetch('/api/v2/analysis/jobs', {
    method: 'POST',
    body: formData,
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error?.code || data.error?.message || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * 查询 job 状态
 */
export async function getAnalysisJobStatus(jobId: string): Promise<AnalysisJobStatus> {
  const res = await fetch(`/api/v2/analysis/jobs/${jobId}`);
  const data: AnalysisJobStatus = await res.json();

  // 映射友好错误消息
  if (data.status === 'failed' && data.error) {
    const baseError = data.error.split(':')[0];
    data.errorMessage = ANALYSIS_ERROR_MAP[data.error] || ANALYSIS_ERROR_MAP[baseError] || '分析失败，请重试';
  }

  return data;
}
