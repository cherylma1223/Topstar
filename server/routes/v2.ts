/**
 * V2 API 路由
 * 
 * 设计文档 §9：结构化输出 + 教程推荐
 */
import express from 'express';
import { randomUUID } from 'crypto';
import { Modality } from '@google/genai';
import { handleChatEvent, type ChatRequest } from '../orchestrator/handleChatEvent';
import { recommendTutorials } from '../tutorials/recommendTutorials';
import { updateTutorialStatus, getTutorial } from '../tutorials/loader';
import { getAI, withRetry } from './v1';

const router = express.Router();
const ttsCache = new Map<string, { expiresAt: number; audio: { mime_type: string; sample_rate: number; data: string } }>();
const TTS_CACHE_TTL_MS = 10 * 60 * 1000;

function buildTTSPrompt(text: string): string {
  return `Please read the following text aloud in a professional and encouraging tone: ${text.trim()}`;
}

function cleanupExpiredTTSCache() {
  const now = Date.now();
  for (const [key, value] of ttsCache.entries()) {
    if (value.expiresAt <= now) {
      ttsCache.delete(key);
    }
  }
}

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

function buildTextSegments(answerText: string) {
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

function buildReportSegments(report: any, isFieldGuidance: boolean) {
  const segments: { segment_id: string; order: number; text: string }[] = [];
  const summary = sanitizeTextForTTS(stripVipSections(report?.summaryText || ''));
  const techName = sanitizeTextForTTS(report?.techName || '');
  const problemTitle = isFieldGuidance ? '技术特点' : '技术问题';
  const improvementTitle = isFieldGuidance ? '战术指导' : '训练建议';
  const problems = Array.isArray(report?.problems) ? report.problems.map((item: any) => item?.text).filter(Boolean) : [];
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

async function synthesizeSegment(text: string, voice: string) {
  cleanupExpiredTTSCache();

  const cacheKey = `${voice}::${text}`;
  const cached = ttsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { audio: cached.audio, cacheHit: true };
  }

  const response = await withRetry(() => getAI().models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: buildTTSPrompt(text),
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  }), 1, 300);

  const part = (response as any).candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error('No audio data in response');
  }

  const audio = {
    mime_type: part.inlineData.mimeType || 'audio/pcm',
    sample_rate: 24000,
    data: part.inlineData.data,
  };

  ttsCache.set(cacheKey, {
    expiresAt: Date.now() + TTS_CACHE_TTL_MS,
    audio,
  });

  return { audio, cacheHit: false };
}

/**
 * POST /api/v2/chat
 * 结构化聊天接口
 */
router.post('/chat', async (req, res) => {
  const { message, history, prefs, event } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: '缺少 message 参数',
        retryable: false,
        request_id: '',
      },
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'API Key 未配置',
        retryable: false,
        request_id: '',
      },
    });
  }

  const chatRequest: ChatRequest = { message, history, prefs, event };
  const result = await handleChatEvent(chatRequest);
  
  if (result.success === false) {
    // ErrorResponse
    const errorResult = result as any;
    const httpStatus = errorResult.error?.code === 'LLM_UNAVAILABLE' ? 503 : 500;
    return res.status(httpStatus).json(result);
  }

  res.json(result);
});

/**
 * POST /api/v2/tts
 * 结构化 TTS 接口
 */
router.post('/tts', async (req, res) => {
  const {
    contentType = 'text',
    text,
    report,
    isFieldGuidance = false,
    voice = 'Kore',
  } = req.body || {};

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'API Key 未配置',
        retryable: false,
        request_id: '',
      },
    });
  }

  const requestId = randomUUID();
  const startedAt = Date.now();

  try {
    const segments = contentType === 'report'
      ? buildReportSegments(report, Boolean(isFieldGuidance))
      : buildTextSegments(typeof text === 'string' ? text : '');

    if (segments.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'TTS_TEXT_INVALID',
          message: '没有可朗读的文本内容',
          retryable: false,
          request_id: requestId,
        },
      });
    }

    const synthesized = await Promise.all(
      segments.map(async (segment) => {
        const { audio, cacheHit } = await synthesizeSegment(segment.text, voice);
        return {
          ...segment,
          audio,
          cacheHit,
        };
      })
    );

    res.json({
      success: true,
      request_id: requestId,
      cache_hit: synthesized.every(item => item.cacheHit),
      voice,
      segments: synthesized.map(({ cacheHit, ...segment }) => segment),
      metrics: {
        provider_model: 'gemini-2.5-flash-preview-tts',
        generation_ms: Date.now() - startedAt,
      },
    });
  } catch (error: any) {
    console.error('[V2] TTS Error:', error.message || error);
    res.status(503).json({
      success: false,
      error: {
        code: 'TTS_GENERATION_FAILED',
        message: error.message || 'TTS 生成失败',
        retryable: true,
        request_id: requestId,
      },
    });
  }
});

/**
 * POST /api/v2/tutorials/recommend
 * 独立教程推荐接口
 */
router.post('/tutorials/recommend', (req, res) => {
  const { query, action_id, limit = 3 } = req.body;

  if (!query && !action_id) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: '需要提供 query 或 action_id',
        retryable: false,
        request_id: '',
      },
    });
  }

  // 从 query 中提取标签
  const tags: string[] = [];
  const commonTerms = ['拧拉', '弧圈', '发球', '接发球', '推挡', '搓球', '削球', '正手', '反手', '拉球', '挑打', '摆短', '劈长', '台内', '步法', '发力', '横拍', '直拍'];
  if (query) {
    for (const term of commonTerms) {
      if (query.includes(term)) tags.push(term);
    }
    // 如果没有命中常见术语，用整个 query 作为标签
    if (tags.length === 0) tags.push(query);
  }

  const results = recommendTutorials(action_id || null, tags, limit);
  res.json({ success: true, tutorials: results });
});

/**
 * POST /api/v2/tutorials/:tutorial_id/report-dead
 * 用户上报链接失效
 */
router.post('/tutorials/:tutorial_id/report-dead', (req, res) => {
  const { tutorial_id } = req.params;

  const tutorial = getTutorial(tutorial_id);
  if (!tutorial) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'JOB_NOT_FOUND',
        message: '教程不存在',
        retryable: false,
        request_id: '',
      },
    });
  }

  updateTutorialStatus(tutorial_id, {
    status: 'suspect',
    failure_reported_by_user: 1,
  });

  console.log(`[V2] User reported dead link: ${tutorial_id}`);
  res.json({ success: true, message: '感谢您的反馈，我们会尽快处理' });
});

export default router;
