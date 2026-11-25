/**
 * LLM 抽象层 — 能力路由配置
 *
 * 按部署区域（DEPLOY_REGION）给出每项能力的默认 provider / 模型降级链 / 重试策略，
 * 并允许用环境变量逐项覆盖：
 *
 *   DEPLOY_REGION=global|cn              默认 global（海外版）
 *   LLM_<CAP>_PROVIDER=gemini            例：LLM_CHAT_PROVIDER。只改 provider 不改 models 时，
 *                                         默认 models 不再沿用（见 PROVIDER_DEFAULT_MODELS）
 *   LLM_<CAP>_MODELS=a,b,c               例：LLM_VIDEO_PASS2_MODELS（按顺序降级）
 *   LLM_<CAP>_MAX_RETRIES=2              临时性错误的重试次数
 *   LLM_<CAP>_RETRY_DELAY_MS=1000        首次重试等待时间（之后指数翻倍）
 *   VIDEO_STORAGE=gemini_files           视频托管实现
 *
 * <CAP> 为能力名大写：CHAT / INTENT / VIDEO_PASS1 / VIDEO_PASS15 / VIDEO_PASS2 / TTS
 *
 * 语音播报（TTS）默认走阿里云百炼 Qwen TTS，需要 DASHSCOPE_API_KEY；SSE 流式只为 dashscope 实现。
 * 切回谷歌语音：LLM_TTS_PROVIDER=gemini（不指定 models 时用 gemini-3.8-flash-tts）。
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

/**
 * 视频模型降级链（2026-11-25 调整，依据 docs/eval/2026-11-06-gemini-video-model-comparison.md、
 * docs/arch/Topstar_视频链路国产化方案_v1.md §1.1）：
 * - gemini-4-argon：首选。测评中判断正确、问题点最具体、模型计算耗时 0.63×
 * - gemini-3.1-pro-preview：唯一经生产验证的型号，退居第二
 * - gemini-3.8-flash：Pass 1 / 2 的末位兜底，不用于 Pass 1.5（见 GEMINI_VIDEO_PASS15_MODELS）
 * - gemini-2.5-pro / gemini-2.5-flash 已移除：2026-12-01 停用，且请求会被自动改道
 *   （2.5-pro → gemini-3.8-flash），不再是可控的降级目标
 */
const GEMINI_VIDEO_MODELS = ['gemini-4-argon', 'gemini-3.1-pro-preview', 'gemini-3.8-flash'];
/** Pass 1.5 不放 gemini-3.8-flash：测评里它以 0.95 的置信度把反手拉球判成正手，置信度门槛拦不住，判错后整份诊断作废 */
const GEMINI_VIDEO_PASS15_MODELS = ['gemini-4-argon', 'gemini-3.1-pro-preview'];
const VIDEO_RETRY: RetryPolicy = { maxRetries: 2, initialDelayMs: 3000 };

/** 语音播报默认走百炼 Qwen TTS（SSE 流式只为 dashscope 实现），需要 DASHSCOPE_API_KEY */
const QWEN_TTS_MODEL = 'qwen-audio-3.1-tts-flash';
/** gemini-2.5-flash-preview-tts 2026-12-18 停用，这是官方给的替代型号 */
const GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';

/** 海外版默认：对话 / 视频走 Gemini，语音播报走百炼 */
const GLOBAL_DEFAULTS: RegionConfig = {
  capabilities: {
    chat:         { provider: 'gemini', models: ['gemini-3-flash-preview'], retry: { maxRetries: 3, initialDelayMs: 1000 } },
    intent:       { provider: 'gemini', models: ['gemini-3-flash-preview'], retry: { maxRetries: 0, initialDelayMs: 0 } },
    video_pass1:  { provider: 'gemini', models: GEMINI_VIDEO_MODELS, retry: VIDEO_RETRY },
    video_pass15: { provider: 'gemini', models: GEMINI_VIDEO_PASS15_MODELS, retry: VIDEO_RETRY },
    video_pass2:  { provider: 'gemini', models: GEMINI_VIDEO_MODELS, retry: VIDEO_RETRY },
    tts:          { provider: 'dashscope', models: [QWEN_TTS_MODEL], retry: { maxRetries: 1, initialDelayMs: 300 } },
  },
  videoStorage: 'gemini_files',
};

/**
 * 环境变量只改了 provider、没有改 models 时使用的型号。
 * 区域默认里的模型名属于另一家（例：把 TTS 切回 Gemini 时，默认的 qwen-audio-* 不能发给 Google），
 * 所以 provider 被改掉后不再沿用默认 models：先查这张表，查不到就要求显式指定 models。
 */
const PROVIDER_DEFAULT_MODELS: Partial<Record<Capability, Partial<Record<ProviderName, string[]>>>> = {
  tts: { gemini: [GEMINI_TTS_MODEL] },
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

  const providerEnv = process.env[envKey(cap, 'PROVIDER')]?.trim();
  const provider = (providerEnv || base?.provider) as ProviderName | undefined;
  let models = parseList(process.env[envKey(cap, 'MODELS')]);
  if (models.length === 0) {
    const switchedProvider = Boolean(providerEnv && base && base.provider !== provider);
    if (switchedProvider) models = [...(PROVIDER_DEFAULT_MODELS[cap]?.[provider as ProviderName] ?? [])];
    else models = base ? [...base.models] : [];
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
