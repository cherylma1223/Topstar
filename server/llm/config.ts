/**
 * LLM 抽象层 — 能力路由配置
 *
 * 按部署区域（DEPLOY_REGION）给出每项能力的默认 provider / 模型降级链 / 重试策略，
 * 并允许用环境变量逐项覆盖：
 *
 *   DEPLOY_REGION=global|cn              默认 global（海外版，Gemini）
 *   LLM_<CAP>_PROVIDER=gemini            例：LLM_CHAT_PROVIDER
 *   LLM_<CAP>_MODELS=a,b,c               例：LLM_VIDEO_PASS2_MODELS（按顺序降级）
 *   LLM_<CAP>_MAX_RETRIES=2              临时性错误的重试次数
 *   LLM_<CAP>_RETRY_DELAY_MS=1000        首次重试等待时间（之后指数翻倍）
 *   VIDEO_STORAGE=gemini_files           视频托管实现
 *   GEMINI_VIDEO_MODEL=xxx               兼容旧配置：插到所有 video_* 能力降级链的最前面
 *
 * <CAP> 为能力名大写：CHAT / INTENT / VIDEO_PASS1 / VIDEO_PASS15 / VIDEO_PASS2 / TTS
 *
 * 参考：docs/arch/Topstar_国产化模型迁移计划_v2.md 决策 D7 / D8
 */
import type { Capability, ProviderName, VideoStorageName } from './types';
import { LLMError } from './errors';

export type DeployRegion = 'global' | 'cn';

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
}

export interface CapabilityConfig {
  provider: ProviderName;
  /** 按顺序尝试；遇到 MODEL_UNAVAILABLE 时降级到下一个 */
  models: string[];
  retry: RetryPolicy;
}

interface RegionConfig {
  capabilities: Record<Capability, CapabilityConfig>;
  videoStorage: VideoStorageName;
}

// ─── 默认配置 ─────────────────────────────────────────────────────

const GEMINI_VIDEO_MODELS = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'];
const VIDEO_RETRY: RetryPolicy = { maxRetries: 2, initialDelayMs: 3000 };

/** 海外版：与迁移前线上行为保持一致 */
const GLOBAL_DEFAULTS: RegionConfig = {
  capabilities: {
    chat:         { provider: 'gemini', models: ['gemini-3-flash-preview'], retry: { maxRetries: 3, initialDelayMs: 1000 } },
    intent:       { provider: 'gemini', models: ['gemini-3-flash-preview'], retry: { maxRetries: 0, initialDelayMs: 0 } },
    video_pass1:  { provider: 'gemini', models: GEMINI_VIDEO_MODELS, retry: VIDEO_RETRY },
    video_pass15: { provider: 'gemini', models: GEMINI_VIDEO_MODELS, retry: VIDEO_RETRY },
    video_pass2:  { provider: 'gemini', models: GEMINI_VIDEO_MODELS, retry: VIDEO_RETRY },
    tts:          { provider: 'gemini', models: ['gemini-2.5-flash-preview-tts'], retry: { maxRetries: 1, initialDelayMs: 300 } },
  },
  videoStorage: 'gemini_files',
};

/**
 * 国内版：Phase 1 接入阿里云百炼后填充（D7）。
 * 在此之前，DEPLOY_REGION=cn 时所有能力必须通过环境变量显式指定，否则报 NOT_CONFIGURED。
 */
const CN_DEFAULTS: RegionConfig | null = null;

// ─── 解析 ─────────────────────────────────────────────────────────

export function getDeployRegion(): DeployRegion {
  const raw = (process.env.DEPLOY_REGION || 'global').trim().toLowerCase();
  return raw === 'cn' ? 'cn' : 'global';
}

function envKey(cap: Capability, suffix: string): string {
  return `LLM_${cap.toUpperCase()}_${suffix}`;
}

function parseList(raw: string | undefined): string[] {
  return (raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

function regionDefaults(): RegionConfig | null {
  return getDeployRegion() === 'cn' ? CN_DEFAULTS : GLOBAL_DEFAULTS;
}

/** 每次调用实时读取环境变量，便于测试和热切换 */
export function getCapabilityConfig(cap: Capability): CapabilityConfig {
  const base = regionDefaults()?.capabilities[cap];

  const provider = (process.env[envKey(cap, 'PROVIDER')]?.trim() || base?.provider) as ProviderName | undefined;
  let models = parseList(process.env[envKey(cap, 'MODELS')]);
  if (models.length === 0) models = base ? [...base.models] : [];

  if (cap.startsWith('video_') && process.env.GEMINI_VIDEO_MODEL && provider === 'gemini') {
    models = [process.env.GEMINI_VIDEO_MODEL.trim(), ...models];
  }
  models = [...new Set(models.filter(Boolean))];

  const retriesRaw = process.env[envKey(cap, 'MAX_RETRIES')];
  const delayRaw = process.env[envKey(cap, 'RETRY_DELAY_MS')];
  const isNum = (v: string | undefined): v is string => v !== undefined && v !== '' && !isNaN(Number(v));
  const retry: RetryPolicy = {
    maxRetries: isNum(retriesRaw) ? Number(retriesRaw) : base?.retry.maxRetries ?? 0,
    initialDelayMs: isNum(delayRaw) ? Number(delayRaw) : base?.retry.initialDelayMs ?? 1000,
  };

  if (!provider || models.length === 0) {
    throw new LLMError(
      'NOT_CONFIGURED',
      `capability "${cap}" has no provider/models for DEPLOY_REGION=${getDeployRegion()}; ` +
      `set ${envKey(cap, 'PROVIDER')} and ${envKey(cap, 'MODELS')}`
    );
  }

  return { provider, models, retry };
}

export function getVideoStorageName(): VideoStorageName {
  const fromEnv = process.env.VIDEO_STORAGE?.trim() as VideoStorageName | undefined;
  const name = fromEnv || regionDefaults()?.videoStorage;
  if (!name) {
    throw new LLMError('NOT_CONFIGURED', `no video storage for DEPLOY_REGION=${getDeployRegion()}; set VIDEO_STORAGE`);
  }
  return name;
}
