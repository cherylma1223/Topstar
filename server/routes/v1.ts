import express from 'express';
import { GoogleGenAI, Modality } from '@google/genai';
import { matchKnowledge, getKnowledgeSummary } from '../knowledge/matcher';

const router = express.Router();

// AI client - lazy init
let ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!ai) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  }
  return ai;
}

function buildTTSPrompt(text: string): string {
  return `Please read the following text aloud in a professional and encouraging tone: ${text.trim()}`;
}

/**
 * 指数退避重试：处理 503/429 等临时性错误
 */
async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3, initialDelay = 1000): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const msg = error?.message || '';
      const isRetryable = msg.includes('503') || msg.includes('429') || msg.includes('overloaded') || msg.includes('UNAVAILABLE');
      if (i < maxRetries && isRetryable) {
        const delay = initialDelay * Math.pow(2, i);
        console.warn(`Gemini API overloaded. Retrying in ${delay}ms... (${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// ---- 健康检查 ----
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    hasKey: !!process.env.GEMINI_API_KEY,
  });
});

// ---- AI 聊天 ----
router.post('/ai/chat', async (req, res) => {
  const { prompt, systemInstruction, history = [] } = req.body;
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'API Key missing' });

  // 知识库检索：根据用户 prompt 匹配相关知识
  const matched = matchKnowledge(prompt);
  let knowledgeContext = '';

  if (matched.length > 0) {
    knowledgeContext = '\n\n以下是你必须参考的乒乓球专业知识库（与本次提问相关的内容）：\n\n';
    for (const item of matched) {
      knowledgeContext += `【${item.title}】(Ref: ${item.id})\n${item.content}\n\n`;
    }
  } else {
    // 兜底：没有命中关键词，提供知识摘要
    knowledgeContext = '\n\n' + getKnowledgeSummary();
  }

  // 将知识上下文拼接到 system instruction
  const enrichedInstruction = (systemInstruction || '你是一名专业的乒乓球教练。') + knowledgeContext;

  // 构建 Gemini 的内容格式
  const contents = history.map((msg: any) => ({
    role: msg.sender === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: prompt }]
  });

  try {
    const response = await withRetry(() => getAI().models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: contents,
      config: {
        systemInstruction: enrichedInstruction,
      },
    }));
    res.json({ success: true, content: response.text || '' });
  } catch (error: any) {
    console.error('Chat Error:', error.message || error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

// ---- TTS 语音合成 ----
router.post('/ai/tts', async (req, res) => {
  const { text } = req.body;
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'API Key missing' });

  try {
    const response = await withRetry(() => getAI().models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: buildTTSPrompt(text),
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    }));

    const part = (response as any).candidates?.[0]?.content?.parts?.[0];
    if (part?.inlineData?.data) {
      res.json({ success: true, audioData: part.inlineData.data });
    } else {
      res.status(500).json({ error: 'No audio data in response' });
    }
  } catch (error: any) {
    console.error('Gemini TTS Error:', error.message || error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

// ---- 图片生成 ----
router.post('/ai/image', async (req, res) => {
  const { actionDescription } = req.body;
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'API Key missing' });

  try {
    const response = await withRetry(() => getAI().models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          {
            text: `A cinematic, high-quality sports photography shot of a professional table tennis player performing a ${actionDescription}. Focused on technique, blurred background, dynamic movement, professional lighting.`,
          },
        ],
      },
      config: {
        imageConfig: {
          aspectRatio: '16:9',
        },
      },
    }));

    if ((response as any).candidates && (response as any).candidates[0]?.content?.parts) {
      for (const part of (response as any).candidates[0].content.parts) {
        if (part.inlineData) {
          return res.json({
            success: true,
            imageData: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          });
        }
      }
    }
    res.json({ success: true, imageData: null });
  } catch (error: any) {
    console.error('Image Generation Error:', error.message || error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

export default router;
export { withRetry, getAI };
