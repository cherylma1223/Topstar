const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();
const { GoogleGenAI, Modality } = require('@google/genai');

const app = express();
const port = process.env.PORT || 3001;

// 防止未捕获异常导致进程退出
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

/**
 * 指数退避重试：处理 503/429 等临时性错误
 */
async function withRetry(operation, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
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
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', hasKey: !!process.env.GEMINI_API_KEY });
});

// ---- AI 聊天 ----
app.post('/api/v1/ai/chat', async (req, res) => {
  const { prompt, systemInstruction } = req.body;
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'API Key missing' });

  try {
    const response = await withRetry(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        systemInstruction: systemInstruction || '你是一名专业的乒乓球教练。',
      },
    }));
    res.json({ success: true, content: response.text || '' });
  } catch (error) {
    console.error('Chat Error:', error.message || error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

// ---- TTS 语音合成 ----
app.post('/api/v1/ai/tts', async (req, res) => {
  const { text } = req.body;
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'API Key missing' });

  try {
    const response = await withRetry(() => ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text: text.trim() }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    }));

    const part = response.candidates?.[0]?.content?.parts?.[0];
    if (part?.inlineData?.data) {
      res.json({ success: true, audioData: part.inlineData.data });
    } else {
      res.status(500).json({ error: 'No audio data in response' });
    }
  } catch (error) {
    console.error('Gemini TTS Error:', error.message || error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

// ---- 图片生成 ----
app.post('/api/v1/ai/image', async (req, res) => {
  const { actionDescription } = req.body;
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'API Key missing' });

  try {
    const response = await withRetry(() => ai.models.generateContent({
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

    if (response.candidates && response.candidates[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          return res.json({
            success: true,
            imageData: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          });
        }
      }
    }
    res.json({ success: true, imageData: null });
  } catch (error) {
    console.error('Image Generation Error:', error.message || error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
