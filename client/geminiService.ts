
import { GoogleGenAI, Modality, GenerateContentResponse } from "@google/genai";

/**
 * 安全获取 API Key 的工具函数
 */
const getApiKey = () => {
  try {
    // 优先尝试从 Vite 环境变量读取 (客户端)
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_GEMINI_API_KEY) {
      return import.meta.env.VITE_GEMINI_API_KEY;
    }
    // 备选尝试从 Node 环境变量读取 (服务端)
    if (typeof process !== 'undefined' && process.env && process.env.API_KEY) {
      return process.env.API_KEY;
    }
  } catch (e) {
    console.warn("API Key access warning:", e);
  }
  return "";
};

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
        error?.status === 'UNAVAILABLE' || 
        error?.message?.includes('overloaded') || 
        error?.message?.includes('503') ||
        error?.message?.includes('429');

      if (i < maxRetries && isRetryable) {
        const delay = initialDelay * Math.pow(2, i);
        console.warn(`Gemini API overloaded/unavailable. Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

const OFF_TOP_REPLY = "抱歉，我只能回答乒乓球相关的问题。您可以尝试上传您的训练或比赛视频，让我为您进行深度分析，也可以根据您的打法推荐器材。";

// ---------------------------------------------------------
// 乒乓球知识库上下文 (Knowledge Base Context)
// ---------------------------------------------------------
const KNOWLEDGE_BASE_CONTEXT = `
以下是你必须参考的乒乓球专业知识库：

【技术动作-反手拧拉 (Ref: actions/bh_flick_zjk.md)】：
- 动作要领：双脚跨度大，重心压低并稍微偏向右侧。肘部必须向前架起作为支撑点，严禁贴肋。手腕极度内扣（拍头指着腹部）。击球瞬间前臂带动手腕像拧螺丝一样外展，在最高点通过薄摩擦把球“撕”过去。
- 常见问题：撞击多导致出界需加深内扣加强“刷”球皮感；发力闷需检查肘部是否顶出去留出爆发空间。
- 训练建议：多球训练强化内扣角度，体会“刷”球皮的手感；配合重心由后向前的蹬伸。
- 视频教程：[张继科拧拉动作示范](https://drive.google.com/file/d/13VkToMh1kvnbKRhHsLlgJ_D_WaT-Eef0/view)
- 核心秘诀(VIP专属)：食指二次点火——接触瞬间食指猛压拍肩，为球增加二次加速度产生“喷射感”。

【战术表现与策略映射 (Ref: tactics/direct_match_logic.md)】：
- 场景：被对方反手底线长球顶住 / 处理反手长球被动。
- 定性：节奏被压制，挥拍空间被挤压。
- 处理策略：不要拉手，不要往后躲！越躲越被顶。直接在台面上出手，球起跳即迎上去借力带回去。下旋略往上摩擦，上旋直接往前。
- 场景：处理正手位短球被动。
- 策略：敢于上步！右脚迅速插进球台深处，重心跟上，在最高点挑打或拧挑，严禁等球下降。

【器材知识-D09C】：
- 性能特点：蝴蝶粘性套胶，兼顾台内控制与远台底劲；支撑力强，搭配Viscaria等底板上限极高。
- 适合打法：发力出色的进攻型选手。
- 价格区间：国行刮码 390-400元；日版有码 400-430元；国行有码 450-490元。
`;

export const DEFAULT_COACH_INSTRUCTION = `你是一名资深的乒乓球教练。语气简练专业，充满洞察力。

${KNOWLEDGE_BASE_CONTEXT}

【核心任务】：
1. 识别意图：
   - 如果是咨询具体动作（如：怎么练习拧拉、动作要领是什么），必须严格按照【技术动作输出模板】回答。
   - 如果是咨询实战表现（如：被长球顶住、处理不掉短球），必须严格按照【战术策略输出模板】回答。

2. 结构化输出规范（严禁编造结构，严禁使用列表符号 - 或 *）：

---
【技术动作输出模板】：
第一行：一句核心总结。

【动作要领】
[参考知识库 actions 库的动作要领，分步描述]

【常见问题】
[描述技术上的核心痛点或误区]

【训练建议】
[给出具体、可执行的练习方法]

【视频教程】
请务必按照 [视频名称](URL) 的 Markdown 链接格式输出。

【核心秘诀(VIP专属)】
[务必包含知识库中的 VIP 秘诀内容]

---
【战术策略输出模板】：
第一行：一句核心总结。

【存在问题/定性分析】
[进行定性分析，如：节奏被压制、空间被挤压]

【改进建议/实战策略】
[给出具体的战术应对方案，如“不拉手、迎上去”]

【约束条件】：
- 总字数控制在150字以内。
- 乒乓球无关内容回复：“${OFF_TOP_REPLY}”`;


export const EQUIPMENT_ADVISOR_INSTRUCTION = `你是一名专业的乒乓球器材顾问。
你的回答必须【极致精简】且【高度结构化】。

${KNOWLEDGE_BASE_CONTEXT}

【核心原则】：
如果你判断用户的输入内容与乒乓球器材或乒乓球话题完全无关，请直接回复：
“${OFF_TOP_REPLY}”

1. 如果用户咨询具体的器材（例如：蝴蝶D09C）：
   请严格参考知识库中的器材参数和搭配建议。
   请严格按照以下格式输出，严禁使用短横线（-）或任何形式的列项符号：
   
   【性能特点】：
   [第一点特性描述，直接写文字]
   [第二点特性描述]
   
   【适合打法】：[描述]
   【代表运动员】：[姓名]
   【价格区间】：[金额]

2. 如果用户寻求推荐，请分行主动询问：
   1) 您想咨询：底板、胶皮还是整套器材？
   2) 您的打法：例如横板两面反胶/直板快攻等？
   3) 您的预算：大致范围？

3. 推荐方案时（同样禁止使用符号）：
   【底板】：[名称]（理由：...）
   【正手】：[名称]
   // 【反手】：[名称]

回复要求：
- 严禁在每行开头使用“-”或“*”。
- 确保主题（【...】）与下方内容紧凑。
- 禁止多余的客套话。`;

export const getAIResponse = async (prompt: string, systemInstruction: string = DEFAULT_COACH_INSTRUCTION) => {
  const apiKey = getApiKey();
  
  if (!apiKey) {
    console.error("Gemini API Key is missing in environment variables.");
    return "AI 助手未配置 API Key，请联系管理员。";
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    // 注意：在浏览器环境中，如果遇到 TypeError: Failed to fetch，通常是网络连接问题或代理配置问题。
    // 请确保您的网络环境可以正常访问 Google Gemini API (https://generativelanguage.googleapis.com)。
    const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        systemInstruction: systemInstruction,
      },
    }));
    
    return response.text || "AI 助手暂时没有回应，请重试。";
  } catch (error) {
    console.error("Gemini Service Error:", error);
    // 如果是网络错误，给出更明确的提示
    if (error instanceof TypeError && error.message.includes('fetch')) {
      return "网络连接失败，请检查您的网络环境（是否可以访问 Google API）。";
    }
    return "AI 助手目前正忙（服务过载），请稍后重试。";
  }
};

/**
 * 语音合成功能 (TTS)
 */
export const generateSpeech = async (text: string) => {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `Please read the following text aloud with a professional and encouraging tone: ${text.trim()}` }] }],
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
      return part.inlineData.data;
    }
    return null;
  } catch (error) {
    console.error("TTS API Error Details:", error);
    return null;
  }
};

/**
 * 根据技术动作描述生成背景图片
 */
export const generateActionImage = async (actionDescription: string) => {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await withRetry<GenerateContentResponse>(() => ai.models.generateContent({
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
          aspectRatio: "16:9"
        }
      },
    }));

    if (response.candidates && response.candidates[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
      }
    }
  } catch (error) {
    console.error("Image Generation Error:", error);
  }
  return null;
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
