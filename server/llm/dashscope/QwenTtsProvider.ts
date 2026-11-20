/**
 * 阿里云百炼 Qwen-Audio-TTS Provider（dashscope）
 *
 * 只用它的语音合成：qwen-audio-3.1-tts-flash。
 * generate() 直接抛错——这个 provider 不承担文本生成，避免有人把 chat / intent 误路由过来。
 *
 * 接口：POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
 *   请求体 { model, input: { text, voice, format, sample_rate } }
 *   返回 output.audio.url（OSS 临时地址），需要再下载一次拿到音频字节
 * 计费：按 token（输入 1.5 元/百万、输出 12 元/百万；音频按 12.5 token/秒折算）
 *
 * 环境变量：
 *   DASHSCOPE_API_KEY          必填（百炼控制台申请的 sk-...）
 *   DASHSCOPE_TTS_VOICE        默认 longhua_v3.1（与模型绑定的音色 ID）
 *   DASHSCOPE_TTS_ENDPOINT     默认北京地域的 SpeechSynthesizer 地址
 *   DASHSCOPE_TTS_TIMEOUT_MS   默认 30000
 */
import { LLMError, errorMessage, type LLMErrorCode } from '../errors';
import type { AudioResult, GenerateRequest, LLMProvider, TTSRequest } from '../types';

const DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const DEFAULT_VOICE = 'longhua_v3.1';
const SAMPLE_RATE = 24000;
const DEFAULT_TIMEOUT_MS = 30_000;

export function dashscopeApiKey(): string {
  return (process.env.DASHSCOPE_API_KEY || '').trim();
}

export function hasDashscopeKey(): boolean {
  return dashscopeApiKey().length > 0;
}

export function dashscopeEndpoint(): string {
  return (process.env.DASHSCOPE_TTS_ENDPOINT || DEFAULT_ENDPOINT).trim();
}

export function dashscopeTtsVoice(): string {
  return (process.env.DASHSCOPE_TTS_VOICE || DEFAULT_VOICE).trim();
}

/** 只认「与模型绑定的音色 ID」形态，如 longhua_v3.1；其它（如 Gemini 的 Kore）走默认音色 */
const QWEN_VOICE_RE = /^[a-z][a-z0-9_]*_v\d+(\.\d+)?$/i;

export function resolveQwenVoice(requested?: string): string {
  const voice = (requested || '').trim();
  if (voice && QWEN_VOICE_RE.test(voice)) return voice;
  return dashscopeTtsVoice();
}

export function classifyDashscopeError(status: number, detail: string): LLMErrorCode {
  const msg = (detail || '').toLowerCase();
  if (msg.includes('arrearage') || msg.includes('insufficient') || msg.includes('quota')) return 'QUOTA_EXHAUSTED';
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
  if (status === 404) return 'MODEL_UNAVAILABLE';
  if (msg.includes('model') && (msg.includes('not exist') || msg.includes('not found'))) return 'MODEL_UNAVAILABLE';
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  return 'UNKNOWN';
}

export class QwenTtsProvider implements LLMProvider {
  readonly name = 'dashscope' as const;

  isConfigured(): boolean {
    return hasDashscopeKey();
  }

  /** 本 provider 不做文本生成 */
  async generate(_req: GenerateRequest, model: string): Promise<{ text: string }> {
    throw new LLMError(
      'NOT_CONFIGURED',
      'DashScope provider 只实现了 TTS；chat / intent 请继续使用 gemini 或 deepseek',
      { provider: 'dashscope', model }
    );
  }

  async tts(req: TTSRequest, model: string): Promise<Omit<AudioResult, 'provider' | 'model'>> {
    if (!this.isConfigured()) {
      throw new LLMError('NOT_CONFIGURED', 'DASHSCOPE_API_KEY is not set', { provider: 'dashscope', model });
    }
    if (!req.text || !req.text.trim()) {
      throw new LLMError('INVALID_REQUEST', 'text is empty', { provider: 'dashscope', model });
    }

    const voice = resolveQwenVoice(req.voice);
    const timeoutMs = Number(process.env.DASHSCOPE_TTS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

    const doFetch = async (url: string, init: RequestInit): Promise<Response> => {
      try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new LLMError('UPSTREAM_UNAVAILABLE', `request failed: ${errorMessage(err)}`, {
          provider: 'dashscope', model, cause: err,
        });
      }
    };

    const started = Date.now();
    const res = await doFetch(dashscopeEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dashscopeApiKey()}`,
      },
      body: JSON.stringify({
        model,
        input: { text: req.text, voice, format: 'pcm', sample_rate: SAMPLE_RATE },
      }),
    });

    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      throw new LLMError(classifyDashscopeError(res.status, raw), `HTTP ${res.status}: ${raw.slice(0, 300)}`, {
        provider: 'dashscope', model,
      });
    }

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new LLMError('UPSTREAM_UNAVAILABLE', `invalid JSON in response: ${raw.slice(0, 200)}`, {
        provider: 'dashscope', model,
      });
    }

    const audioUrl = payload?.output?.audio?.url;
    if (typeof audioUrl !== 'string' || !audioUrl) {
      throw new LLMError('EMPTY_RESPONSE', 'no audio url in response', { provider: 'dashscope', model });
    }

    // 音频在 OSS 临时地址上，需要再取一次
    const audioRes = await doFetch(audioUrl, { method: 'GET' });
    if (!audioRes.ok) {
      throw new LLMError('UPSTREAM_UNAVAILABLE', `audio download failed: HTTP ${audioRes.status}`, {
        provider: 'dashscope', model,
      });
    }
    const bytes = Buffer.from(await audioRes.arrayBuffer());
    if (bytes.length === 0) {
      throw new LLMError('EMPTY_RESPONSE', 'empty audio payload', { provider: 'dashscope', model });
    }

    const usage = payload?.usage || {};
    console.log(
      `[LLM dashscope tts] voice=${voice} chars=${usage.characters ?? '?'} out_tokens=${usage.output_tokens ?? '?'} ` +
      `bytes=${bytes.length} 耗时=${Date.now() - started}ms`
    );

    return { mimeType: 'audio/pcm', sampleRate: SAMPLE_RATE, data: bytes.toString('base64') };
  }
}
