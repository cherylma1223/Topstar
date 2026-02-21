const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3001;

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

app.post('/api/v1/ai/tts', async (req, res) => {
  const { text } = req.body;
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'API Key missing' });

  try {
    // 关键：指定专用的 TTS 模型
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-tts" });
    
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: text.trim() }] }],
      generationConfig: {
        // TTS 专用配置
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' } // 使用磁性男声
          }
        }
      }
    });

    const response = await result.response;
    const audioData = response.candidates[0].content.parts[0].inlineData.data;

    res.json({ success: true, audioData });
  } catch (error) {
    console.error('Gemini TTS Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/ai/chat', async (req, res) => {
  const { prompt, systemInstruction } = req.body;
  try {
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      systemInstruction: systemInstruction || "你是一名专业的乒乓球教练。"
    });
    const result = await model.generateContent(prompt);
    res.json({ success: true, content: result.response.text() });
  } catch (error) {
    console.error('Chat Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
