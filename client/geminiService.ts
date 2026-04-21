
import type { AnalysisReport } from './types.ts';

/**
 * Gemini Service — 通过后端代理访问 AI 能力
 * 所有 API Key 仅存在于服务端，前端不持有任何密钥
 */

const API_BASE = '/api/v1/ai';

const OFF_TOP_REPLY = "抱歉，我只能回答乒乓球相关的问题。您可以尝试上传您的训练或比赛视频，让我为您进行深度分析，也可以根据您的打法推荐器材。";

export const UNIFIED_COACH_INSTRUCTION = `你是一名资深的乒乓球教练，同时也是专业的器材顾问。语气简练专业，充满洞察力。
你的回答必须【极致精简】且【高度结构化】。严禁编造结构，严禁使用列表符号 - 或 *。

【核心任务——意图识别与模板匹配】：
你必须根据用户提问内容（而非当前所处的对话主题）判断问题类型，并严格使用对应的输出模板。规则如下：
1. 用户咨询具体技术动作（如：怎么练拧拉、正手攻球要领、发球技术）→ 严格使用【技术动作输出模板】
2. 用户咨询实战表现或战术（如：被长球顶住、处理不掉短球、比赛策略）→ 严格使用【战术策略输出模板】
3. 用户咨询器材（如：D09C怎么样、推荐胶皮、底板搭配）→ 严格使用【器材咨询输出模板】
4. 如果知识库中有相关文件内容，必须严格参考知识库内容回答，不要编造。
5. 乒乓球无关内容直接回复："${OFF_TOP_REPLY}"

===== 模板一：技术动作输出模板 =====
第一行：一句核心总结。

【动作要领】
[参考知识库中的动作要领，分步描述]

【常见问题】
[描述技术上的核心痛点或误区]

【训练建议】
[给出具体、可执行的练习方法]

【视频教程】
请务必按照 [视频名称](URL) 的 Markdown 链接格式输出。

【核心秘诀(VIP专属)】
[务必包含知识库中的核心秘诀内容]

===== 模板二：战术策略输出模板 =====
第一行：一句核心总结。

【存在问题/定性分析】
[进行定性分析，如：节奏被压制、空间被挤压]

【改进建议/实战策略】
[给出具体的战术应对方案，如"不拉手、迎上去"]

===== 模板三：器材咨询输出模板 =====
如果用户咨询具体的器材（例如：蝴蝶D09C）：
请严格参考知识库中的器材参数和搭配建议。

【性能特点】
[第一点特性描述，直接写文字]
[第二点特性描述]

【适合打法】[描述]
【代表运动员】[姓名]
【价格区间】[金额]

如果用户寻求器材推荐，请分行主动询问：
1) 您想咨询：底板、胶皮还是整套器材？
2) 您的打法：例如横板两面反胶/直板快攻等？
3) 您的预算：大致范围？

推荐方案时（同样禁止使用符号）：
【底板】[名称]（理由：...）
【正手】[名称]
【反手】[名称]

【约束条件】：
总字数控制在200字以内。
严禁在每行开头使用"-"或"*"。
确保主题（【...】）与下方内容紧凑。
禁止多余的客套话。`;

// 保留旧名称作为向后兼容的别名
export const DEFAULT_COACH_INSTRUCTION = UNIFIED_COACH_INSTRUCTION;
export const EQUIPMENT_ADVISOR_INSTRUCTION = UNIFIED_COACH_INSTRUCTION;

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
 * AI 聊天 — 通过后端代理 V1 (遗留文本接口，做降级备份)
 */
export const getAIResponse = async (prompt: string, history: { sender: string, content: string }[] = [], systemInstruction: string = DEFAULT_COACH_INSTRUCTION) => {
  try {
    const data = await withRetry(async () => {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, history, systemInstruction }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    });

    return data.content || "AI 助手暂时没有回应，请重试。";
  } catch (error) {
    console.error("Gemini Service Error:", error);
    if (error instanceof TypeError && error.message.includes('fetch')) {
      return "网络连接失败，请检查您的网络环境。";
    }
    return "AI 助手目前正忙（服务过载），请稍后重试。";
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

async function fetchLegacySegmentAudio(text: string): Promise<TTSSegment['audio']> {
  const data = await withRetry(async () => {
    const res = await fetch(`${API_BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, 1, 300);

  if (!data.audioData) {
    throw new Error('No audio data in legacy response');
  }

  return {
    mime_type: 'audio/pcm',
    sample_rate: 24000,
    data: data.audioData,
  };
}

async function fetchSpeechPlanLegacy(request: TTSRequest): Promise<TTSResponse | null> {
  const rawSegments = request.contentType === 'report'
    ? buildReportSegments(request.report, request.isFieldGuidance)
    : buildTextSegments(request.text || '');

  if (rawSegments.length === 0) return null;

  const segments = await Promise.all(
    rawSegments.map(async (segment) => ({
      ...segment,
      audio: await fetchLegacySegmentAudio(segment.text),
    }))
  );

  return {
    success: true,
    request_id: `legacy-${Date.now()}`,
    cache_hit: false,
    voice: request.voice || 'Kore',
    segments,
    metrics: {
      provider_model: 'gemini-2.5-flash-preview-tts',
    },
  };
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
          if (res.status === 404) {
            throw new Error('TTS_V2_NOT_FOUND');
          }
          throw new Error(err.error?.message || err.error || `HTTP ${res.status}`);
        }
        return res.json();
      }, 1, 300);

      return data;
    } catch (error) {
      if (error instanceof Error && error.message === 'TTS_V2_NOT_FOUND') {
        try {
          return await fetchSpeechPlanLegacy(request);
        } catch (legacyError) {
          console.error('TTS API Error Details:', legacyError);
          speechPlanCache.delete(cacheKey);
          return null;
        }
      }

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
 * 根据技术动作描述生成背景图片 — 通过后端代理
 */
export const generateActionImage = async (actionDescription: string) => {
  try {
    const data = await withRetry(async () => {
      const res = await fetch(`${API_BASE}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionDescription }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    });

    return data.imageData || null;
  } catch (error) {
    console.error("Image Generation Error:", error);
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
