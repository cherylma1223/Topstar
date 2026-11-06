/**
 * Gemini Provider
 *
 * 海外版（DEPLOY_REGION=global）的正式实现，长期维护（决策 D8）。
 * 负责：中立请求 → Gemini SDK 请求的转换、Schema 方言转换、错误归一。
 * 重试 / 模型降级 / JSON 解析由门面层（server/llm/index.ts）统一处理。
 */
import { Modality } from '@google/genai';
import { getAI, hasGeminiKey } from './client';
import { LLMError, errorMessage, type LLMErrorCode } from '../errors';
import { toGeminiSchema } from '../schema';
import type { AudioResult, GenerateRequest, LLMProvider, Part, TTSRequest, Usage } from '../types';

const DEFAULT_VOICE = 'Kore';
const TTS_SAMPLE_RATE = 24000;

function buildTTSPrompt(text: string): string {
  return `Please read the following text aloud in a professional and encouraging tone: ${text.trim()}`;
}

/** 把 Gemini SDK 抛出的错误转换为中立错误码 */
export function classifyGeminiError(err: unknown): LLMErrorCode {
  const status = typeof (err as any)?.status === 'number' ? (err as any).status as number : undefined;
  const msg = errorMessage(err);

  const modelUnavailable =
    msg.includes(' is not found for API version ') ||
    msg.includes(' is not supported for generateContent') ||
    (msg.includes('NOT_FOUND') && msg.toLowerCase().includes('model'));
  if (modelUnavailable || status === 404 || msg.includes('"code":404') || msg.includes('code: 404')) {
    return 'MODEL_UNAVAILABLE';
  }
  // 账户额度耗尽（如 402 "prepayment credits are depleted"）：必须先于 RATE_LIMITED 判断，
  // 因为它的 status 同样是 RESOURCE_EXHAUSTED，但重试和换模型都没有意义
  if (
    status === 402 || msg.includes('"code":402') ||
    msg.toLowerCase().includes('prepayment credits are depleted') ||
    msg.toLowerCase().includes('billing account')
  ) {
    return 'QUOTA_EXHAUSTED';
  }
  if (status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) return 'RATE_LIMITED';
  if (
    status === 500 || status === 502 || status === 503 || status === 504 ||
    msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('overloaded') ||
    msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT')
  ) {
    return 'UPSTREAM_UNAVAILABLE';
  }
  if (status === 401 || status === 403 || msg.includes('PERMISSION_DENIED') || msg.includes('UNAUTHENTICATED') || msg.includes('API key not valid')) {
    return 'AUTH_FAILED';
  }
  if (status === 400 || msg.includes('INVALID_ARGUMENT') || msg.includes('FAILED_PRECONDITION')) return 'INVALID_REQUEST';
  return 'UNKNOWN';
}

function wrapError(err: unknown, model: string): LLMError {
  if (err instanceof LLMError) return err;
  return new LLMError(classifyGeminiError(err), errorMessage(err), { provider: 'gemini', model, cause: err });
}

function toGeminiPart(part: Part, model: string): Record<string, any> {
  if (part.type === 'text') return { text: part.text };

  if (part.ref.storage !== 'gemini_files') {
    throw new LLMError(
      'INVALID_REQUEST',
      `GeminiProvider cannot read video from storage "${part.ref.storage}"; use VIDEO_STORAGE=gemini_files`,
      { provider: 'gemini', model }
    );
  }
  const geminiPart: Record<string, any> = {
    fileData: { fileUri: part.ref.uri, mimeType: part.ref.mimeType },
  };
  if (part.fps) geminiPart.videoMetadata = { fps: part.fps };
  return geminiPart;
}

/** SDK 的 response.text 是 getter；历史上出现过被当作函数调用导致报错，这里统一兼容 */
function readText(response: any): string {
  const t = typeof response?.text === 'function' ? response.text() : response?.text;
  return typeof t === 'string' ? t : '';
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini' as const;

  isConfigured(): boolean {
    return hasGeminiKey();
  }

  async generate(req: GenerateRequest, model: string): Promise<{ text: string; usage?: Usage }> {
    if (!this.isConfigured()) {
      throw new LLMError('NOT_CONFIGURED', 'GEMINI_API_KEY is not set', { provider: 'gemini', model });
    }

    const contents = req.messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.parts.map(p => toGeminiPart(p, model)),
    }));

    const config: Record<string, any> = {};
    if (req.system) config.systemInstruction = req.system;
    if (req.temperature !== undefined) config.temperature = req.temperature;
    if (req.responseSchema) {
      config.responseMimeType = 'application/json';
      config.responseSchema = toGeminiSchema(req.responseSchema);
    }

    let response: any;
    try {
      response = await getAI().models.generateContent({ model, contents, config });
    } catch (err) {
      throw wrapError(err, model);
    }

    const usageMeta = response?.usageMetadata;
    return {
      text: readText(response),
      usage: usageMeta
        ? { inputTokens: usageMeta.promptTokenCount, outputTokens: usageMeta.candidatesTokenCount }
        : undefined,
    };
  }

  async tts(req: TTSRequest, model: string): Promise<Omit<AudioResult, 'provider' | 'model'>> {
    if (!this.isConfigured()) {
      throw new LLMError('NOT_CONFIGURED', 'GEMINI_API_KEY is not set', { provider: 'gemini', model });
    }

    let response: any;
    try {
      response = await getAI().models.generateContent({
        model,
        contents: buildTTSPrompt(req.text),
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: req.voice || DEFAULT_VOICE },
            },
          },
        },
      });
    } catch (err) {
      throw wrapError(err, model);
    }

    const part = response?.candidates?.[0]?.content?.parts?.[0];
    if (!part?.inlineData?.data) {
      throw new LLMError('EMPTY_RESPONSE', 'No audio data in response', { provider: 'gemini', model });
    }

    return {
      mimeType: part.inlineData.mimeType || 'audio/pcm',
      sampleRate: TTS_SAMPLE_RATE,
      data: part.inlineData.data,
    };
  }
}
