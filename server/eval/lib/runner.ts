/**
 * 评测运行器：对标注集里的每个视频跑完整的分析管道（Pass 1 → 1.5 → 2），收集各环节输出
 *
 * - 不经过数据库和 Worker，直接调用 videoAnalysis/pipeline.ts，所以和线上用的是同一套代码
 * - 每个视频只上传一次，`repeat` 次重复运行共享同一个上传（上传占端到端耗时的大头）
 * - 串行执行，避免触发限流；模型用多少、降级链如何，完全由环境变量 / 配置决定
 */
import fs from 'fs';
import path from 'path';
import { getDeployRegion } from '../../llm';
import { getCapabilityConfig, getVideoStorageName } from '../../llm/config';
import { probeVideoDuration } from '../../video/probe';
import {
  cleanupAnalysisVideo,
  createTrace,
  runAnalysisPasses,
  uploadVideoForAnalysis,
} from '../../videoAnalysis/pipeline';
import type { Annotation } from './annotations';
import type { EvalResults, GoldSubset, RunConfig, RunRecord, VideoResult } from './types';

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
};

export function goldOf(a: Annotation): GoldSubset {
  return { actionId: a.actionId, segments: a.segments, hasVoice: a.hasVoice, issues: a.issues, tags: a.tags };
}

export function currentRunConfig(repeat: number): RunConfig {
  const models = (cap: 'video_pass1' | 'video_pass15' | 'video_pass2') => {
    try { return getCapabilityConfig(cap).models; } catch { return []; }
  };
  let storage = 'unknown';
  try { storage = getVideoStorageName(); } catch { /* 保持 unknown */ }
  return {
    pass1Models: models('video_pass1'),
    pass15Models: models('video_pass15'),
    pass2Models: models('video_pass2'),
    region: getDeployRegion(),
    storage,
    repeat,
  };
}

export interface RunnerOptions {
  label: string;
  videosDir: string;
  annotations: Annotation[];
  repeat: number;
  gitCommit?: string;
  log?: (msg: string) => void;
}

export async function runEvaluation(opts: RunnerOptions): Promise<EvalResults> {
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const runTag = Date.now().toString(36);
  const videos: VideoResult[] = [];

  for (const [i, ann] of opts.annotations.entries()) {
    const progress = `[${i + 1}/${opts.annotations.length}] ${ann.videoId}`;
    const result: VideoResult = { videoId: ann.videoId, videoFile: ann.videoFile, gold: goldOf(ann), runs: [] };
    videos.push(result);

    const videoPath = path.join(opts.videosDir, ann.videoFile);
    if (!fs.existsSync(videoPath)) {
      result.skipped = `视频文件不存在：${videoPath}`;
      log(`${progress} 跳过：${result.skipped}`);
      continue;
    }

    const mimeType = MIME_BY_EXT[path.extname(videoPath).toLowerCase()];
    if (!mimeType) {
      result.skipped = `不支持的视频格式：${path.extname(videoPath)}`;
      log(`${progress} 跳过：${result.skipped}`);
      continue;
    }

    result.durationSec = await probeVideoDuration(videoPath);
    const jobId = `eval-${runTag}-${ann.videoId}`;

    log(`${progress} 上传中…`);
    const upTrace = createTrace('technique', result.durationSec);
    let uploaded: Awaited<ReturnType<typeof uploadVideoForAnalysis>>;
    try {
      uploaded = await uploadVideoForAnalysis(jobId, videoPath, mimeType, { analysisType: 'technique', videoDurationSec: result.durationSec }, upTrace);
    } catch (err: any) {
      result.uploadError = err?.message ?? String(err);
      log(`${progress} 上传失败：${result.uploadError}`);
      continue;
    }
    result.storage = upTrace.storage;
    result.uploadMs = upTrace.timingsMs.upload;
    result.readyMs = upTrace.timingsMs.ready;

    try {
      for (let r = 1; r <= opts.repeat; r++) {
        const trace = createTrace('technique', result.durationSec);
        trace.storage = upTrace.storage;
        const t0 = Date.now();
        const record: RunRecord = { ok: false, trace };
        try {
          await runAnalysisPasses({
            jobId: `${jobId}-r${r}`,
            video: uploaded.video,
            analysisType: 'technique',
            videoDurationSec: result.durationSec,
            trace,
          });
          record.ok = true;
        } catch (err: any) {
          record.error = err?.message ?? String(err);
          trace.error = record.error;
        }
        trace.timingsMs.total = Date.now() - t0;
        result.runs.push(record);

        const predicted = trace.pass15?.result.primary_action_id ?? '-';
        log(`${progress} 第 ${r}/${opts.repeat} 次：${record.ok ? `✓ ${predicted}` : `✗ ${record.error}`}（${((trace.timingsMs.passes ?? 0) / 1000).toFixed(1)}s）`);
      }
    } finally {
      await cleanupAnalysisVideo(jobId, uploaded.storage, uploaded.video);
    }
  }

  return {
    schemaVersion: 1,
    label: opts.label,
    startedAt,
    finishedAt: new Date().toISOString(),
    gitCommit: opts.gitCommit,
    config: currentRunConfig(opts.repeat),
    videos,
  };
}
