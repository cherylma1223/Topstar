/**
 * LLM 抽象层 — 中立错误码
 *
 * 各 provider 负责把厂商错误转换为 LLMError，业务层只匹配 code，
 * 不再匹配 Gemini 的错误字符串。
 */

export type LLMErrorCode =
  | 'MODEL_UNAVAILABLE'     // 模型不存在 / 不支持该方法（触发降级到下一个模型）
  | 'RATE_LIMITED'          // 429 限流（可重试）
  | 'QUOTA_EXHAUSTED'       // 402 / 账户额度耗尽（不可重试，换模型也没用，需要充值）
  | 'UPSTREAM_UNAVAILABLE'  // 503 / 过载 / 网络失败（可重试）
  | 'INVALID_REQUEST'       // 400 参数错误（不可重试）
  | 'AUTH_FAILED'           // 401 / 403 凭证问题（不可重试）
  | 'NOT_CONFIGURED'        // 未配置凭证或 provider 未实现
  | 'EMPTY_RESPONSE'        // 模型返回空内容（可重试）
  | 'PARSE_FAILED'          // 要求 JSON 但无法解析（可重试一次）
  | 'STORAGE_FAILED'        // 视频托管上传 / 处理失败
  | 'UNKNOWN';

const RETRYABLE: ReadonlySet<LLMErrorCode> = new Set([
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'EMPTY_RESPONSE',
  'PARSE_FAILED',
]);

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly provider?: string;
  readonly model?: string;

  constructor(code: LLMErrorCode, detail: string, opts: { provider?: string; model?: string; cause?: unknown } = {}) {
    // message 保持「CODE: 细节」格式，便于落库和日志检索
    super(`${code}: ${detail}`, { cause: opts.cause });
    this.name = 'LLMError';
    this.code = code;
    this.provider = opts.provider;
    this.model = opts.model;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

export function isLLMError(err: unknown): err is LLMError {
  return err instanceof LLMError;
}

export function errorMessage(err: unknown): string {
  if (typeof (err as any)?.message === 'string') return (err as any).message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
