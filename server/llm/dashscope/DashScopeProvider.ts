/**
 * 阿里云百炼 Provider（dashscope）
 *
 * 文本 / 视频输入走 OpenAI 兼容接口 `POST {base}/chat/completions`（不引第三方 SDK，用 Node 内置 fetch）；
 * 语音合成委托 `QwenTtsProvider`（同一把 DASHSCOPE_API_KEY）。
 * 重试 / 模型降级 / JSON 解析由门面层（server/llm/index.ts）统一处理。
 *
 * 接口要点（2026-11-25 查文档）：
 *   - 视频以 `{ type: 'video_url', video_url: { url }, fps }` 内容块传入，fps 与 video_url 同级，取值范围 0.1–10
 *   - 视频地址必须是模型能直接访问的公网 URL：私有 OSS 桶用签名 URL（V2 的 storage 负责签发）
 *   - 要求 JSON 输出时传 `response_format: { type: 'json_object' }`，提示词里要出现 "json" 字样
 *   - qwen3.8 系列默认开思考模式，用 `enable_thinking: false` 关掉（与项目「思考模式全线关闭」一致）
 *
 * 环境变量：
 *   DASHSCOPE_API_KEY        必填；未设置时 isConfigured() 为 false
 *   DASHSCOPE_BASE_URL       默认 https://dashscope.aliyuncs.com/compatible-mode/v1；
 *                            工作空间专属域名形如 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
 *   DASHSCOPE_TIMEOUT_MS     默认 300000（视频要抽帧 + 推理，比纯文本慢得多）
 *   DASHSCOPE_MAX_TOKENS     可选，输出上限（JSON 模式建议设，避免被截断）
 *   DASHSCOPE_THINKING       enabled | disabled | auto（默认 auto：chat 用服务端默认，其余关掉）
 *
 * 能力边界：chat / intent / video_pass1 / video_pass15 / video_pass2。
 * 尚未实现（接口已留位置）：`oss://` 直读、ASR 旁路、豆包方舟（见方案 §5 的 V3 / 后续 PR）。
 */
import { LLMError, errorMessage, type LLMErrorCode } from '../errors';
import type { AudioResult, GenerateRequest, LLMProvider, Message, Part, TTSRequest, Usage } from '../types';
import { QwenTtsProvider, dashscopeApiKey, hasDashscopeKey } from './QwenTtsProvider';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_TIMEOUT_MS = 300_000;
/** 百炼对 fps 的约束；越界先夹到可接受区间并告警，别让服务端替我们拒绝整条请求 */
const FPS_MIN = 0.1;
const FPS_MAX = 10;

export function dashscopeBaseUrl(): string {
  return (process.env.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

/** 文本 / 视频生成的错误归一。TTS 的那份在 QwenTtsProvider.classifyDashscopeError */
export function classifyDashscopeGenerateError(status: number, detail: string): LLMErrorCode {
  const msg = (detail || '').toLowerCase();
  if (msg.includes('arrearage') || msg.includes('insufficient') || msg.includes('quota')) return 'QUOTA_EXHAUSTED';
  if (status === 401 || status === 403) {
    // 内容审核不通过走 400/403 都可能；先归到不可重试的 INVALID_REQUEST
    // TODO V4：单独映射 CONTENT_BLOCKED，前端给「这段视频/文本不适合分析」的提示
    if (msg.includes('data_inspection') || msg.includes('inappropriate')) return 'INVALID_REQUEST';
    return 'AUTH_FAILED';
  }
  if (status === 404) return 'MODEL_UNAVAILABLE';
  if (msg.includes('model') && (msg.includes('not exist') || msg.includes('not found'))) return 'MODEL_UNAVAILABLE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
  // 400 / 422：视频 URL 不可达、解码失败、格式不支持都落在这里。同一份视频换模型也没救，不做降级
  // TODO V4：细分出 VIDEO_UNSUPPORTED
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  return 'UNKNOWN';
}

/**
 * 思考模式开关。
 * auto：chat 保留服务端的默认（qwen3.8 默认开思考），intent 与三个视频环节关掉——
 * 它们都是「给足指令的分析任务」，思考只会加延迟；需要时用 DASHSCOPE_THINKING=enabled 打开。
 */
function resolveThinking(req: GenerateRequest): boolean | undefined {
  const raw = (process.env.DASHSCOPE_THINKING || '').trim().toLowerCase();
  if (raw === 'enabled') return true;
  if (raw === 'disabled') return false;
  return req.capability === 'chat' ? undefined : false;
}

function clampFps(fps: number, model: string): number {
  if (!Number.isFinite(fps) || fps <= 0) return FPS_MIN;
  const clamped = Math.min(FPS_MAX, Math.max(FPS_MIN, fps));
  if (clamped !== fps) {
    console.warn(`[LLM dashscope ${model}] fps ${fps} out of range [${FPS_MIN}, ${FPS_MAX}], clamped to ${clamped}`);
  }
  return clamped;
}

/** 把中立 part 转成兼容模式的内容块；有视频时用数组，纯文本压成一个字符串（兼容性和缓存都更好） */
function toContent(parts: Part[], model: string): string | Array<Record<string, unknown>> {
  const hasVideo = parts.some(p => p.type === 'video');
  if (!hasVideo) {
    return parts.map(p => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n\n');
  }

  const content: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.ref.state !== 'ready') {
      throw new LLMError(
        'INVALID_REQUEST',
        `video is "${part.ref.state}"; wait for the upload to finish before calling the model`,
        { provider: 'dashscope', model }
      );
    }
    // 只接受两种地址：公网 http(s)（V2 的 OSS 签名 URL）或百炼同账号的 oss://（临时存储 / 同地域私有桶，
    // 需要在请求头加 X-DashScope-OssResourceResolve: enable，见 generate()）
    if (!/^https?:\/\//i.test(part.ref.uri || '') && !/^oss:\/\//i.test(part.ref.uri || '')) {
      throw new LLMError(
        'INVALID_REQUEST',
        `video uri must be a public http(s) URL or an oss:// path (got "${String(part.ref.uri).slice(0, 40)}"); 百炼读不到本地文件`,
        { provider: 'dashscope', model }
      );
    }
    const block: Record<string, unknown> = { type: 'video_url', video_url: { url: part.ref.uri } };
    if (part.fps) block.fps = clampFps(part.fps, model);
    content.push(block);
  }
  return content;
}

function toMessage(m: Message, model: string): { role: string; content: unknown } {
  return { role: m.role, content: toContent(m.parts, model) };
}

/** 兼容模式下 content 可能是字符串，也可能是 {type:'text',text} 数组 */
function readText(choice: any): string {
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : '')).join('');
  }
  return '';
}

function readUsage(payload: any): Usage | undefined {
  const u = payload?.usage;
  if (!u) return undefined;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
}

export class DashScopeProvider implements LLMProvider {
  readonly name = 'dashscope' as const;

  /** 语音合成实现（同样的 key / 端点约定），保持和之前的行为一致 */
  private readonly ttsProvider = new QwenTtsProvider();

  isConfigured(): boolean {
    return hasDashscopeKey();
  }

  async generate(req: GenerateRequest, model: string): Promise<{ text: string; usage?: Usage }> {
    if (!this.isConfigured()) {
      throw new LLMError('NOT_CONFIGURED', 'DASHSCOPE_API_KEY is not set', { provider: 'dashscope', model });
    }

    const messages: Array<{ role: string; content: unknown }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push(toMessage(m, model));

    const body: Record<string, unknown> = { model, messages, stream: false };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // 百炼的 JSON Object 模式不强制 schema 结构，结构与字段校验仍由门面层做
    if (req.responseSchema) body.response_format = { type: 'json_object' };
    const thinking = resolveThinking(req);
    if (thinking !== undefined) body.enable_thinking = thinking;
    const maxTokens = Number(process.env.DASHSCOPE_MAX_TOKENS);
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

    const timeoutMs = Number(process.env.DASHSCOPE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

    // 用 oss:// 地址时必须显式声明「允许解析同账号 OSS 资源」，否则服务端读不到视频
    const usesOss = req.messages.some(m => m.parts.some(p => p.type === 'video' && /^oss:\/\//i.test(p.ref.uri || '')));

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${dashscopeApiKey()}`,
    };
    if (usesOss) headers['X-DashScope-OssResourceResolve'] = 'enable';

    let res: Response;
    try {
      res = await fetch(`${dashscopeBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // 网络失败 / DNS / 超时：按可重试的上游不可用处理
      throw new LLMError('UPSTREAM_UNAVAILABLE', `request failed: ${errorMessage(err)}`, {
        provider: 'dashscope', model, cause: err,
      });
    }

    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      throw new LLMError(classifyDashscopeGenerateError(res.status, raw), `HTTP ${res.status}: ${raw.slice(0, 300)}`, {
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

    const choice = payload?.choices?.[0];
    const text = readText(choice);
    if (!text.trim()) {
      throw new LLMError('EMPTY_RESPONSE', `empty content (finish_reason=${choice?.finish_reason ?? 'unknown'})`, {
        provider: 'dashscope', model,
      });
    }

    return { text, usage: readUsage(payload) };
  }

  async tts(req: TTSRequest, model: string): Promise<Omit<AudioResult, 'provider' | 'model'>> {
    return this.ttsProvider.tts(req, model);
  }
}
