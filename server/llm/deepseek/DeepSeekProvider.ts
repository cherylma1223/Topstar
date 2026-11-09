/**
 * DeepSeek Provider
 *
 * 走 OpenAI 兼容的 `POST {base}/chat/completions`（不引第三方 SDK，用 Node 内置 fetch）。
 * 负责：中立请求 → DeepSeek 请求的转换、思考模式开关、错误归一。
 * 重试 / 模型降级 / JSON 解析由门面层（server/llm/index.ts）统一处理。
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY      必填；未设置时 isConfigured() 为 false
 *   DEEPSEEK_BASE_URL     默认 https://api.deepseek.com
 *   DEEPSEEK_THINKING     enabled | disabled | auto（默认 auto：intent 自动关闭思考，其余走服务端默认）
 *   DEEPSEEK_MAX_TOKENS   可选，输出上限（JSON 模式建议设置，避免被截断）
 *   DEEPSEEK_TIMEOUT_MS   默认 120000
 *
 * 能力边界：DeepSeek 只处理文本（flash 支持图像理解，不支持视频输入，也没有 TTS），
 * 因此 video_pass* / tts 必须留在 gemini；误把 video part 路由过来会抛 INVALID_REQUEST。
 */
import { LLMError, errorMessage, type LLMErrorCode } from '../errors';
import type { AudioResult, GenerateRequest, LLMProvider, Message, TTSRequest, Usage } from '../types';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 120_000;

export function deepseekApiKey(): string {
  return (process.env.DEEPSEEK_API_KEY || '').trim();
}

export function deepseekBaseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

export function hasDeepSeekKey(): boolean {
  return deepseekApiKey().length > 0;
}

/** 把 DeepSeek 的 HTTP 状态 / 错误体转换为中立错误码 */
export function classifyDeepSeekError(status: number, detail: string): LLMErrorCode {
  const msg = (detail || '').toLowerCase();
  // 模型名写错：换模型可能有救，交给门面层降级
  if (status === 404 || msg.includes('model not exist') || msg.includes('model_not_found')) return 'MODEL_UNAVAILABLE';
  // 402 余额不足：重试和换模型都没用
  if (status === 402 || msg.includes('insufficient balance')) return 'QUOTA_EXHAUSTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  return 'UNKNOWN';
}

/**
 * 思考模式开关。
 * DeepSeek 默认开启思考模式（reasoning_effort=high），意图分类这类短任务没必要付这份延迟。
 */
function resolveThinking(req: GenerateRequest): 'enabled' | 'disabled' | undefined {
  const raw = (process.env.DEEPSEEK_THINKING || '').trim().toLowerCase();
  if (raw === 'enabled' || raw === 'disabled') return raw;
  if (req.capability === 'intent') return 'disabled';
  return undefined;
}

function toChatMessage(m: Message, model: string): { role: string; content: string } {
  const texts: string[] = [];
  for (const part of m.parts) {
    if (part.type === 'text') {
      texts.push(part.text);
      continue;
    }
    throw new LLMError(
      'INVALID_REQUEST',
      'DeepSeekProvider cannot read "video" parts; keep video_pass* capabilities on gemini',
      { provider: 'deepseek', model }
    );
  }
  return { role: m.role, content: texts.join('\n\n') };
}

function readUsage(payload: any): Usage | undefined {
  const u = payload?.usage;
  if (!u) return undefined;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek' as const;

  isConfigured(): boolean {
    return hasDeepSeekKey();
  }

  async generate(req: GenerateRequest, model: string): Promise<{ text: string; usage?: Usage }> {
    if (!this.isConfigured()) {
      throw new LLMError('NOT_CONFIGURED', 'DEEPSEEK_API_KEY is not set', { provider: 'deepseek', model });
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push(toChatMessage(m, model));

    const body: Record<string, unknown> = { model, messages, stream: false };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // DeepSeek 的 JSON Output：prompt 里必须出现 "json" 字样，业务侧 prompt 已包含
    if (req.responseSchema) body.response_format = { type: 'json_object' };
    const thinking = resolveThinking(req);
    if (thinking) body.thinking = { type: thinking };
    const maxTokens = Number(process.env.DEEPSEEK_MAX_TOKENS);
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

    const timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

    let res: Response;
    try {
      res = await fetch(`${deepseekBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${deepseekApiKey()}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // 网络失败 / DNS / 超时：按可重试的上游不可用处理
      throw new LLMError('UPSTREAM_UNAVAILABLE', `request failed: ${errorMessage(err)}`, {
        provider: 'deepseek', model, cause: err,
      });
    }

    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      throw new LLMError(classifyDeepSeekError(res.status, raw), `HTTP ${res.status}: ${raw.slice(0, 300)}`, {
        provider: 'deepseek', model,
      });
    }

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new LLMError('UPSTREAM_UNAVAILABLE', `invalid JSON in response: ${raw.slice(0, 200)}`, {
        provider: 'deepseek', model,
      });
    }

    const choice = payload?.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (!text.trim()) {
      // JSON 模式下无法解析的内容会被替换成空格，此时 finish_reason 仍是 stop
      throw new LLMError('EMPTY_RESPONSE', `empty content (finish_reason=${choice?.finish_reason ?? 'unknown'})`, {
        provider: 'deepseek', model,
      });
    }

    return { text, usage: readUsage(payload) };
  }

  async tts(_req: TTSRequest, model: string): Promise<Omit<AudioResult, 'provider' | 'model'>> {
    throw new LLMError(
      'NOT_CONFIGURED',
      'DeepSeek has no TTS; keep LLM_TTS_PROVIDER=gemini',
      { provider: 'deepseek', model }
    );
  }
}
