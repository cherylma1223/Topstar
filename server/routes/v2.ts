/**
 * V2 API 路由
 * 
 * 设计文档 §9：结构化输出 + 教程推荐
 */
import express from 'express';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { handleChatEvent, type ChatRequest, type ChatResponse } from '../orchestrator/handleChatEvent';
import { recommendTutorials } from '../tutorials/recommendTutorials';
import { updateTutorialStatus, getTutorial } from '../tutorials/loader';
import { tts, isCapabilityAvailable, getPrimaryModel } from '../llm';
import { getCapabilityConfig } from '../llm/config';
import { qwenTtsAudioChunks } from '../llm/dashscope/qwenTtsStream';
import { resolveQwenVoice } from '../llm/dashscope/QwenTtsProvider';
import { probeVideoDuration } from '../video/probe';
import { fixMultipartFilename } from '../utils/filename';
import { resolveIsVip } from '../auth/vip';
import { requireAuth } from '../auth/middleware';
import db from '../db';
import { enqueueAnalysisJob } from '../jobs/queue';
import { conversationExists, persistChatTurn } from '../conversations/store';


const router = express.Router();

/**
 * 落库用的富媒体部件。形态必须与客户端构造的 MessagePart[] 一致
 * （见 client/App.tsx 的 handleSendMessage），历史会话还原时才能渲染出同样的气泡。
 */
function buildAssistantParts(result: ChatResponse): unknown[] {
  const actionRef = result.references?.find(ref => ref.type === 'actions_doc' && ref.title?.trim());
  const cardTitle = result.intent === 'VIDEO_ANALYSIS'
    ? (actionRef?.title ? `${actionRef.title}技术动作诊断报告` : '技术动作诊断报告')
    : (actionRef?.title ? `${actionRef.title}技术指导` : '技术动作指导');

  const videos = result.tutorialVideos || [];
  if (videos.length > 0) {
    return [{
      type: 'report',
      reportData: {
        techName: cardTitle,
        summaryText: result.answerText,
        problems: [],
        improvements: [],
        videoLinks: videos.map(v => ({
          title: `[${v.platform === 'douyin' ? '抖音' : 'B站'}] ${v.title}`,
          url: v.url,
        })),
        variant: 'gradient',
      },
    }];
  }

  return [{ type: 'text', content: result.answerText }];
}

const ttsCache = new Map<string, { expiresAt: number; audio: { mime_type: string; sample_rate: number; data: string }; model: string }>();
const TTS_CACHE_TTL_MS = 10 * 60 * 1000;
/** 流式命中缓存时，每个 SSE 事件的音频块大小（base64 前） */
const TTS_STREAM_CHUNK_BYTES = 48 * 1024;
/** 超过这个体积就不进缓存，避免长文本把内存吃满 */
const TTS_CACHE_MAX_BYTES = 20 * 1024 * 1024;

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
    return { audio: cached.audio, model: cached.model, cacheHit: true };
  }

  // 重试 / 降级策略见 server/llm/config.ts 的 tts 能力配置
  const result = await tts({ text, voice });

  const audio = {
    mime_type: result.mimeType,
    sample_rate: result.sampleRate ?? 24000,
    data: result.data,
  };

  ttsCache.set(cacheKey, {
    expiresAt: Date.now() + TTS_CACHE_TTL_MS,
    audio,
    model: result.model,
  });

  return { audio, model: result.model, cacheHit: false };
}

/**
 * POST /api/v2/chat
 * 结构化聊天接口（需要登录）
 */
router.post('/chat', requireAuth, async (req, res) => {
  const { message, history, event, conversation_id, service, client_msg_id } = req.body;

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

  if (!isCapabilityAvailable('chat')) {
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

  // 指定了会话就先校验归属：别等 LLM 生成完才发现会话不是自己的
  const requestedConversationId = typeof conversation_id === 'string' ? conversation_id.trim() : '';
  if (requestedConversationId && !conversationExists(db, requestedConversationId, req.user!.id)) {
    return res.status(404).json({
      success: false,
      error: { code: 'CONVERSATION_NOT_FOUND', message: '会话不存在', retryable: false, request_id: '' },
    });
  }

  // VIP 由服务端判定（默认所有人都不是 VIP）；请求体里的 prefs / is_vip 一律忽略
  const chatRequest: ChatRequest = { message, history, event, isVip: resolveIsVip(req.headers) };
  const result = await handleChatEvent(chatRequest);
  
  if (result.success === false) {
    // ErrorResponse
    const errorResult = result as any;
    const httpStatus = errorResult.error?.code === 'LLM_UNAVAILABLE' ? 503 : 500;
    return res.status(httpStatus).json(result);
  }

  // 会话落库：回答已经产生，落库失败只记日志、不影响这次返回（客户端拿不到 conversation_id 就不进历史）
  const response: Record<string, unknown> = { ...result };
  try {
    const turn = persistChatTurn(db, {
      userId: req.user!.id,
      conversationId: requestedConversationId || null,
      service,
      userContent: message,
      userClientMsgId: typeof client_msg_id === 'string' ? client_msg_id : null,
      assistantContent: result.answerText,
      assistantPayload: buildAssistantParts(result),
    });

    if (turn) {
      response.conversation_id = turn.conversationId;
      if (turn.assistantMessageId) response.assistant_message_id = turn.assistantMessageId;
    } else {
      console.warn('[Conversations] persistChatTurn returned null: 会话不存在');
    }
  } catch (err: any) {
    console.error('[Conversations] persist failed:', err?.message || err);
  }

  res.json(response);
});

/**
 * POST /api/v2/tts
 * 结构化 TTS 接口（需要登录）
 */
router.post('/tts', requireAuth, async (req, res) => {
  const {
    contentType = 'text',
    text,
    report,
    isFieldGuidance = false,
    voice = 'Kore',
  } = req.body || {};

  if (!isCapabilityAvailable('tts')) {
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
        const { audio, model, cacheHit } = await synthesizeSegment(segment.text, voice);
        return {
          ...segment,
          audio,
          model,
          cacheHit,
        };
      })
    );

    res.json({
      success: true,
      request_id: requestId,
      cache_hit: synthesized.every(item => item.cacheHit),
      voice,
      segments: synthesized.map(({ cacheHit, model, ...segment }) => segment),
      metrics: {
        provider_model: synthesized[0]?.model || getPrimaryModel('tts') || 'unknown',
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
 * POST /api/v2/tts/stream
 * 流式语音合成（SSE）：边合成边下发 PCM 块，浏览器边收边播
 *
 * 入参与 /tts 一致（contentType=text 传 text，contentType=report 传 report）。
 * 只有 dashscope provider 支持真流式；其它 provider 退化成「合成完发一整块」，前端行为不变。
 */
router.post('/tts/stream', requireAuth, async (req, res) => {
  const { contentType = 'text', text, report, isFieldGuidance = false, voice } = req.body || {};

  if (!isCapabilityAvailable('tts')) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'API Key 未配置', retryable: false, request_id: '' },
    });
  }

  const segments = contentType === 'report'
    ? buildReportSegments(report, Boolean(isFieldGuidance))
    : buildTextSegments(typeof text === 'string' ? text : '');
  const content = segments.map(segment => segment.text).join('。').trim();

  if (!content) {
    return res.status(400).json({
      success: false,
      error: { code: 'TTS_TEXT_INVALID', message: '没有可朗读的文本内容', retryable: false, request_id: randomUUID() },
    });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const requestId = randomUUID();
  const startedAt = Date.now();
  const abort = new AbortController();
  // 注意：不能用 req.on('close')——POST 的请求体读完后它就会触发，会立刻掐断上游。
  // 监听响应的 close，且只在响应未正常结束时才中断。
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    const cfg = getCapabilityConfig('tts');
    const requestedVoice = typeof voice === 'string' ? voice : undefined;
    // 缓存键用「解析后的音色」：客户端传 Kore 或什么都不传，落到的都是同一个音色
    const cacheVoice = cfg.provider === 'dashscope' ? resolveQwenVoice(requestedVoice) : (requestedVoice || 'default');
    const cacheKey = `${cfg.provider}::${cfg.models[0]}::${cacheVoice}::${content}`;

    let firstAudioMs = 0;
    let bytes = 0;

    // 命中缓存：把整段音频切成小块一次性下发，不再调模型（也不重复计费）
    cleanupExpiredTTSCache();
    const cached = ttsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const audio = Buffer.from(cached.audio.data, 'base64');
      firstAudioMs = Date.now() - startedAt;
      for (let offset = 0; offset < audio.length; offset += TTS_STREAM_CHUNK_BYTES) {
        const slice = audio.subarray(offset, offset + TTS_STREAM_CHUNK_BYTES);
        res.write(`event: audio\ndata: ${JSON.stringify({ data: slice.toString('base64') })}\n\n`);
      }
      bytes = audio.length;
      res.write(`event: done\ndata: ${JSON.stringify({
        request_id: requestId,
        cache_hit: true,
        first_audio_ms: firstAudioMs,
        elapsed_ms: Date.now() - startedAt,
        bytes,
      })}\n\n`);
      console.log(`[V2] TTS stream ${requestId} | cache=hit | chars=${content.length} | ${Date.now() - startedAt}ms`);
      res.end();
      return;
    }

    const collected: Buffer[] = [];

    if (cfg.provider === 'dashscope') {
      for await (const chunk of qwenTtsAudioChunks({
        text: content,
        voice: requestedVoice,
        model: cfg.models[0],
        signal: abort.signal,
      })) {
        if (firstAudioMs === 0) firstAudioMs = Date.now() - startedAt;
        bytes += chunk.length;
        collected.push(chunk);
        res.write(`event: audio\ndata: ${JSON.stringify({ data: chunk.toString('base64') })}\n\n`);
      }
    } else {
      const result = await tts({ text: content, voice: requestedVoice });
      firstAudioMs = Date.now() - startedAt;
      const audio = Buffer.from(result.data, 'base64');
      bytes += audio.length;
      collected.push(audio);
      res.write(`event: audio\ndata: ${JSON.stringify({ data: result.data, mime_type: result.mimeType, sample_rate: result.sampleRate })}\n\n`);
    }

    // 合成成功且体积可控 → 写缓存，10 分钟内同一段文本重复播放直接秒开、不重复计费
    if (bytes > 0 && bytes <= TTS_CACHE_MAX_BYTES) {
      ttsCache.set(cacheKey, {
        expiresAt: Date.now() + TTS_CACHE_TTL_MS,
        audio: {
          mime_type: 'audio/pcm',
          sample_rate: 24000,
          data: Buffer.concat(collected).toString('base64'),
        },
        model: cfg.models[0],
      });
    }

    res.write(`event: done\ndata: ${JSON.stringify({
      request_id: requestId,
      cache_hit: false,
      first_audio_ms: firstAudioMs,
      elapsed_ms: Date.now() - startedAt,
      bytes,
    })}\n\n`);
    console.log(
      `[V2] TTS stream ${requestId} | provider=${cfg.provider} | cache=miss | chars=${content.length} | first=${firstAudioMs}ms | total=${Date.now() - startedAt}ms`
    );
    res.end();
  } catch (err: any) {
    if (abort.signal.aborted) {
      res.end();
      return;
    }
    console.error('[V2] TTS stream error:', err?.message || err);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({
        code: err?.code || 'TTS_GENERATION_FAILED',
        message: err?.message || '语音合成失败',
        request_id: requestId,
      })}\n\n`);
    } catch { /* 客户端可能已断开 */ }
    res.end();
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

// ─── 视频分析任务路由 ──────────────────────────────────────────────────────

// multer 配置：保存到 server/uploads/{jobId}.{ext}
const UPLOADS_DIR = path.join(__dirname, '../uploads');
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`INVALID_MIME_TYPE:${file.mimetype}`));
    }
  },
});

/**
 * POST /api/v2/analysis/jobs
 * 上传视频文件，创建分析任务，返回 job_id（需要登录）
 *
 * requireAuth 必须排在 multer 之前：未登录的请求在读取请求体（最大 500MB 的视频）之前就被拒绝。
 */
router.post('/analysis/jobs', requireAuth, (req, res) => {
  upload.single('video')(req, res, async (err) => {
    if (err) {
      const isFileSizeError = err.message?.includes('File too large') || err.code === 'LIMIT_FILE_SIZE';
      const isMimeError = err.message?.startsWith('INVALID_MIME_TYPE');
      if (isFileSizeError) {
        return res.status(413).json({
          success: false,
          error: { code: 'FILE_TOO_LARGE', message: '视频文件不能超过 100MB', retryable: false },
        });
      }
      if (isMimeError) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_TYPE', message: '仅支持 MP4、MOV、WebM 格式的视频', retryable: false },
        });
      }
      console.error('[V2] Upload error:', err);
      return res.status(400).json({
        success: false,
        error: { code: 'UPLOAD_FAILED', message: err.message, retryable: true },
      });
    }

    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_FILE', message: '未收到视频文件', retryable: false },
      });
    }

    // 推断扩展名
    const extMap: Record<string, string> = {
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'video/webm': '.webm',
    };
    const ext = extMap[file.mimetype] || path.extname(file.originalname) || '.mp4';
    const jobId = randomUUID();
    const newPath = path.join(UPLOADS_DIR, `${jobId}${ext}`);


    // 重命名临时文件为 jobId.ext
    try {
      fs.renameSync(file.path, newPath);
    } catch (e: any) {
      console.error('[V2] Failed to rename upload:', e.message);
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: '文件存储失败', retryable: true },
      });
    }

    const analysisType = (req.body?.analysis_type === 'match_strategy') ? 'match_strategy' : 'technique';

    // 探测视频时长（秒）；失败时留空，处理任务时会再尝试一次
    const videoDuration = (await probeVideoDuration(newPath)) ?? null;

    // 写入 DB
    db.prepare(`
      INSERT INTO analysis_jobs
        (id, status, analysis_type, video_path, video_filename, video_size, video_duration, mime_type, user_id, created_at)
      VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId,
      analysisType,
      newPath,
      fixMultipartFilename(file.originalname), // multer 把 UTF-8 文件名按 latin1 读成乱码，这里还原
      file.size,
      videoDuration,
      file.mimetype,
      req.user!.id,
      new Date().toISOString()
    );

    // 通知队列（MVP: no-op）
    await enqueueAnalysisJob(jobId);

    console.log(`[V2] Created analysis job: ${jobId} (${analysisType}, ${file.mimetype}, ${Math.round(file.size / 1024)}KB, ${videoDuration ?? '?'}s)`);

    res.json({ success: true, job_id: jobId, status: 'queued' });
  });
});

/**
 * GET /api/v2/analysis/jobs/:id
 * 查询分析任务状态（需要登录，且只能查自己创建的任务；别人的任务和历史无主任务一律按「不存在」返回）
 */
router.get('/analysis/jobs/:id', requireAuth, (req, res) => {
  const { id } = req.params;

  const job = db.prepare(
    `SELECT id, status, analysis_type, report, error, created_at, started_at, completed_at FROM analysis_jobs WHERE id = ? AND user_id = ?`
  ).get(id, req.user!.id) as {
    id: string;
    status: string;
    analysis_type: string;
    report: string | null;
    error: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  } | undefined;

  if (!job) {
    return res.status(404).json({
      success: false,
      error: { code: 'JOB_NOT_FOUND', message: '分析任务不存在', retryable: false },
    });
  }

  const response: any = {
    success: true,
    job_id: job.id,
    status: job.status,
    analysis_type: job.analysis_type,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
  };

  if (job.status === 'done' && job.report) {
    try {
      response.report = JSON.parse(job.report);
    } catch {
      response.report = null;
    }
  }

  if (job.status === 'failed' && job.error) {
    response.error = job.error;
  }

  res.json(response);
});

export default router;
