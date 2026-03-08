const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
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

// ---------------------------------------------------------
// 知识库加载与检索系统
// ---------------------------------------------------------
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'client', 'src', 'assets', 'knowledge');
const knowledgeStore = new Map(); // id -> { title, category, keywords, content }
let knowledgeIndex = [];           // index.json entries

function loadKnowledgeBase() {
  try {
    const indexPath = path.join(KNOWLEDGE_DIR, 'index.json');
    if (!fs.existsSync(indexPath)) {
      console.warn('[Knowledge] index.json not found at:', indexPath);
      return;
    }

    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    knowledgeIndex = indexData.entries || [];

    let loaded = 0;
    for (const entry of knowledgeIndex) {
      const filePath = path.join(KNOWLEDGE_DIR, entry.file);
      if (fs.existsSync(filePath)) {
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        // 去除 YAML frontmatter（--- ... ---）
        const content = rawContent.replace(/^---[\s\S]*?---\n*/, '').trim();
        knowledgeStore.set(entry.id, {
          title: entry.title,
          category: entry.category,
          keywords: entry.keywords || [],
          content: content,
        });
        loaded++;
      } else {
        console.warn(`[Knowledge] File not found: ${filePath}`);
      }
    }
    console.log(`[Knowledge] Loaded ${loaded}/${knowledgeIndex.length} knowledge files.`);
  } catch (err) {
    console.error('[Knowledge] Failed to load knowledge base:', err.message);
  }
}

/**
 * 根据用户输入匹配相关知识文件
 * @param {string} query - 用户的问题文本
 * @param {number} maxResults - 最多返回的知识文件数量
 * @returns {Array<{id, title, category, content}>}
 */
function matchKnowledge(query, maxResults = 5) {
  if (!query || knowledgeStore.size === 0) return [];

  const scored = [];

  for (const [id, data] of knowledgeStore) {
    let score = 0;

    // 关键词匹配：每命中一个关键词 +10 分，命中越多得分越高
    for (const keyword of data.keywords) {
      if (query.includes(keyword)) {
        // 根据关键词长度加权（更长的关键词匹配更精确）
        score += 10 + keyword.length;
      }
    }

    // 标题匹配：+20 分
    if (query.includes(data.title)) {
      score += 20;
    }

    if (score > 0) {
      scored.push({ id, title: data.title, category: data.category, content: data.content, score });
    }
  }

  // 按得分降序排列，取前 N 个
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/**
 * 生成知识库摘要列表（兜底：当没有命中任何关键词时使用）
 */
function getKnowledgeSummary() {
  const categories = {};
  for (const [id, data] of knowledgeStore) {
    if (!categories[data.category]) categories[data.category] = [];
    categories[data.category].push(data.title);
  }

  let summary = '以下是你掌握的知识库目录，当用户咨询相关话题时请告知可以提供帮助：\n';
  const categoryNames = { actions: '技术动作', equipment: '器材', tactics: '战术策略' };
  for (const [cat, titles] of Object.entries(categories)) {
    summary += `【${categoryNames[cat] || cat}】${titles.join('、')}\n`;
  }
  return summary;
}

// 启动时加载知识库
loadKnowledgeBase();

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
  res.json({
    status: 'ok',
    hasKey: !!process.env.GEMINI_API_KEY,
    knowledgeFiles: knowledgeStore.size,
  });
});

// ---- AI 聊天 ----
app.post('/api/v1/ai/chat', async (req, res) => {
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
  const contents = history.map(msg => ({
    role: msg.sender === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: prompt }]
  });

  try {
    const response = await withRetry(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: contents,
      config: {
        systemInstruction: enrichedInstruction,
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
