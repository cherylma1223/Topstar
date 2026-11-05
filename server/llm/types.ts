/**
 * LLM 抽象层 — 类型定义
 *
 * 业务代码只依赖本文件和 `server/llm/index.ts` 导出的门面函数，
 * 不感知具体厂商（Gemini / 通义 / 豆包 …）。
 *
 * 参考：docs/arch/Topstar_国产化模型迁移计划_v2.md §4.2 Phase 0.1
 */
import type { JSONSchema } from './schema';

// ─── 能力与 Provider ──────────────────────────────────────────────

/** 按能力路由：每项能力可单独配置 provider、模型和降级链 */
export type Capability =
  | 'chat'          // AI 教练对话
  | 'intent'        // 意图识别（LLM 兜底）
  | 'video_pass1'   // 视频有效片段切割
  | 'video_pass15'  // 视频技术动作分类
  | 'video_pass2'   // 视频诊断报告
  | 'tts';          // 语音合成

export type ProviderName = 'gemini';

/** 视频托管实现。Gemini 用 Files API；国内模型一般用对象存储签名 URL */
export type VideoStorageName = 'gemini_files';

// ─── 视频引用 ────────────────────────────────────────────────────

export type VideoRefState = 'processing' | 'ready' | 'failed';

export interface VideoRef {
  /** 由哪种托管实现产生，provider 据此判断能否直接使用 */
  storage: VideoStorageName;
  /** 托管侧的唯一标识（Gemini 为 files/xxx；OSS 为 object key），落库到 analysis_jobs.file_ref */
  fileRef: string;
  /** 模型可访问的地址（Gemini file URI / 签名 URL） */
  uri: string;
  mimeType: string;
  state: VideoRefState;
}

export interface VideoStorage {
  readonly name: VideoStorageName;
  upload(localPath: string, mimeType: string): Promise<VideoRef>;
  /** 等待托管侧处理完毕；onPoll 用于业务层记录日志 */
  waitReady(ref: VideoRef, onPoll?: (state: VideoRefState) => void): Promise<VideoRef>;
  cleanup(ref: VideoRef): Promise<void>;
}

// ─── 生成请求 ────────────────────────────────────────────────────

export type Part =
  | { type: 'text'; text: string }
  | { type: 'video'; ref: VideoRef; fps?: number };

export interface Message {
  role: 'user' | 'assistant';
  parts: Part[];
}

export interface GenerateRequest {
  capability: Capability;
  system?: string;
  messages: Message[];
  /** 标准 JSON Schema（小写 type）。提供时要求模型输出 JSON，并在抽象层解析与校验 */
  responseSchema?: JSONSchema;
  temperature?: number;
  /** 优先尝试的模型（例如 Pass 2 沿用 Pass 1 实际命中的模型），之后再走配置的降级链 */
  preferModel?: string;
  /** 日志关联 ID（如视频分析 jobId），可选 */
  traceId?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface GenerateResult {
  text: string;
  /** 提供 responseSchema 时为解析后的 JSON（已做数组/对象纠正） */
  json?: unknown;
  /** Schema 校验未通过的字段说明；为空表示通过。校验失败不抛错，由业务层决定如何处理 */
  schemaErrors?: string[];
  provider: ProviderName;
  model: string;
  usage?: Usage;
}

// ─── TTS ─────────────────────────────────────────────────────────

export interface TTSRequest {
  text: string;
  /** 音色名。各 provider 自行映射；未知音色使用默认音色 */
  voice?: string;
}

export interface AudioResult {
  /** 例如 audio/pcm、audio/wav、audio/mpeg */
  mimeType: string;
  /** PCM 时必填 */
  sampleRate?: number;
  /** base64 编码的音频数据 */
  data: string;
  provider: ProviderName;
  model: string;
}

// ─── Provider 接口 ───────────────────────────────────────────────

export interface LLMProvider {
  readonly name: ProviderName;
  /** 当前环境是否已配置凭证 */
  isConfigured(): boolean;
  /** 单次调用指定模型；重试、降级、JSON 解析由门面层负责 */
  generate(req: GenerateRequest, model: string): Promise<{ text: string; usage?: Usage }>;
  tts(req: TTSRequest, model: string): Promise<Omit<AudioResult, 'provider' | 'model'>>;
}
