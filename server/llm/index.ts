/**
 * LLM 抽象层 — 门面
 *
 * 业务代码唯一入口：
 *   generate(req)       文本 / 多模态生成（含模型降级、临时性错误重试、JSON 解析与校验）
 *   tts(req)            语音合成（含降级与重试）
 *   getVideoStorage()   视频托管（Gemini Files / OSS …）
 *   isCapabilityAvailable(cap)  路由层判断是否已配置凭证
 *
 * 参考：docs/arch/Topstar_国产化模型迁移计划_v2.md §4.2 Phase 0.1
 */
import { getCapabilityConfig, getVideoStorageName, type RetryPolicy } from './config';
import { LLMError, isLLMError, errorMessage } from './errors';
import { getProvider, getStorage } from './registry';
import { coerceToSchema, extractJson, validateJson } from './schema';
import type {
  AudioResult, Capability, GenerateRequest, GenerateResult, LLMProvider, TTSRequest, VideoStorage,
} from './types';

export * from './types';
export { LLMError, isLLMError, errorMessage } from './errors';
export type { LLMErrorCode } from './errors';
export type { JSONSchema } from './schema';
export { getDeployRegion } from './config';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tag(cap: Capability, model: string, traceId?: string): string {
  return `[LLM ${cap}${traceId ? ` ${traceId}` : ''} ${model}]`;
}

/** 单个模型上的重试：临时性错误按指数退避重试；JSON 解析失败至少重试 1 次 */
async function withRetryPolicy<T>(
  policy: RetryPolicy,
  label: string,
  op: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const llmErr = isLLMError(err) ? err : undefined;
      const limit = llmErr?.code === 'PARSE_FAILED' ? Math.max(1, policy.maxRetries) : policy.maxRetries;
      if (llmErr?.retryable && attempt < limit) {
        const delay = policy.initialDelayMs * Math.pow(2, attempt);
        console.warn(`${label} ${llmErr.code}, retrying in ${delay}ms (${attempt + 1}/${limit}): ${llmErr.message}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

/** 按降级链依次尝试模型；仅 MODEL_UNAVAILABLE 触发降级，其他错误直接抛出 */
async function withModelFallback<T>(
  cap: Capability,
  models: string[],
  traceId: string | undefined,
  op: (model: string) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < models.length; i++) {
    try {
      return await op(models[i]);
    } catch (err) {
      if (!(isLLMError(err) && err.code === 'MODEL_UNAVAILABLE')) throw err;
      lastErr = err;
      if (models[i + 1]) {
        console.warn(`${tag(cap, models[i], traceId)} model unavailable; falling back to ${models[i + 1]}`);
      }
    }
  }
  throw lastErr instanceof LLMError
    ? lastErr
    : new LLMError('MODEL_UNAVAILABLE', `no available model for "${cap}": ${errorMessage(lastErr)}`);
}

async function generateOnce(provider: LLMProvider, req: GenerateRequest, model: string): Promise<GenerateResult> {
  const { text, usage } = await provider.generate(req, model);
  const result: GenerateResult = { text, provider: provider.name, model, usage };

  if (!req.responseSchema) return result;

  if (!text) {
    throw new LLMError('EMPTY_RESPONSE', 'empty response while JSON was required', { provider: provider.name, model });
  }
  const parsed = extractJson(text);
  if (parsed === undefined) {
    throw new LLMError('PARSE_FAILED', `invalid JSON: ${text.slice(0, 200)}`, { provider: provider.name, model });
  }
  result.json = coerceToSchema(parsed, req.responseSchema);
  const schemaErrors = validateJson(result.json, req.responseSchema);
  if (schemaErrors.length > 0) {
    result.schemaErrors = schemaErrors;
    console.warn(`${tag(req.capability, model, req.traceId)} schema check failed: ${schemaErrors.slice(0, 5).join('; ')}`);
  }
  return result;
}

export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const cfg = getCapabilityConfig(req.capability);
  const provider = getProvider(cfg.provider);
  const models = cfg.models;

  return withModelFallback(req.capability, models, req.traceId, model =>
    withRetryPolicy(cfg.retry, tag(req.capability, model, req.traceId), () => generateOnce(provider, req, model))
  );
}

export async function tts(req: TTSRequest): Promise<AudioResult> {
  const cfg = getCapabilityConfig('tts');
  const provider = getProvider(cfg.provider);

  return withModelFallback('tts', cfg.models, undefined, model =>
    withRetryPolicy(cfg.retry, tag('tts', model), async () => {
      const audio = await provider.tts(req, model);
      return { ...audio, provider: provider.name, model };
    })
  );
}

export function getVideoStorage(): VideoStorage {
  return getStorage(getVideoStorageName());
}

/** 当前部署是否能提供该能力（配置完整且凭证存在） */
export function isCapabilityAvailable(cap: Capability): boolean {
  try {
    return getProvider(getCapabilityConfig(cap).provider).isConfigured();
  } catch {
    return false;
  }
}

/** 该能力当前首选的模型名（用于日志、metrics 展示） */
export function getPrimaryModel(cap: Capability): string | undefined {
  try {
    return getCapabilityConfig(cap).models[0];
  } catch {
    return undefined;
  }
}
