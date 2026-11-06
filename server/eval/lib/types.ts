/**
 * 评测结果的数据结构（会原样保存为 eval/runs/<日期-标签>/results.json）
 */
import type { Interval } from './annotations';
import type { AnalysisTrace } from '../../videoAnalysis/pipeline';

/** 保存进结果文件的标注子集，让结果文件自包含，对比时不需要再读标注表 */
export interface GoldSubset {
  actionId?: string;
  segments?: Interval[];
  hasVoice?: boolean;
  issues?: string[];
  tags: string[];
}

export interface RunRecord {
  ok: boolean;
  /** 失败时的错误（`错误码: 细节`） */
  error?: string;
  /** 各环节的原始输出 / 模型 / 耗时 / token 用量；失败时保留已完成环节 */
  trace: AnalysisTrace;
}

export interface VideoResult {
  videoId: string;
  videoFile: string;
  gold: GoldSubset;
  durationSec?: number;
  /** 被跳过的原因（如视频文件不存在） */
  skipped?: string;
  /** 上传失败（整个视频无法评测） */
  uploadError?: string;
  storage?: string;
  /** 上传与等待就绪的耗时：每个视频只发生一次，多次重复运行共享 */
  uploadMs?: number;
  readyMs?: number;
  runs: RunRecord[];
}

export interface RunConfig {
  pass1Models: string[];
  pass15Models: string[];
  pass2Models: string[];
  region: string;
  storage: string;
  repeat: number;
}

export interface EvalResults {
  schemaVersion: 1;
  label: string;
  startedAt: string;
  finishedAt: string;
  gitCommit?: string;
  config: RunConfig;
  videos: VideoResult[];
}
