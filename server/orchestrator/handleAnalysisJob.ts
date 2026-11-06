/**
 * 视频分析 Job 处理器（Worker 入口）
 *
 * 分析管道本身（Pass 1 / 1.5 / 2、prompt、Schema、片段校验、报告封装）在
 * server/videoAnalysis/pipeline.ts，不依赖数据库，评测脚本也复用它。
 * 本文件只负责：从数据库取任务 → 调用管道 → 把报告、trace 和状态写回数据库。
 *
 * 参考：Phase 2-A 设计文档 §5.3 / Codex v6 §20
 */
import db from '../db';
import { errorMessage } from '../llm';
import { recommendTutorials } from '../tutorials/recommendTutorials';
import { probeVideoDuration } from '../video/probe';
import { VideoAnalysisLogger } from '../videoAnalysis/videoAnalysisLogger';
import { createTrace, uploadAndAnalyzeVideo } from '../videoAnalysis/pipeline';

// 类型的原位置，继续从这里导出以保持兼容
export type { VideoSegment, TechniqueReport, AnalysisReportPayload } from '../videoAnalysis/pipeline';

// ─── Job 处理入口（Worker 调用）───────────────────────────────────

export async function processAnalysisJob(jobId: string): Promise<void> {
  // 原子地标记为 running，防止多个进程/线程并发抢占同一个 Job
  const updateResult = db.prepare(
    `UPDATE analysis_jobs SET status = 'running', started_at = ?, attempt_count = attempt_count + 1 WHERE id = ? AND status = 'queued'`
  ).run(new Date().toISOString(), jobId);

  if (updateResult.changes === 0) {
    VideoAnalysisLogger.warn(jobId, 'JOB_SKIP', `Job is not in queued state (already running by another worker), skipping.`);
    return;
  }

  // 读取 job 信息
  const job = db.prepare(
    `SELECT id, video_path, mime_type, analysis_type, video_duration FROM analysis_jobs WHERE id = ?`
  ).get(jobId) as {
    id: string;
    video_path: string;
    mime_type: string;
    analysis_type: string;
    video_duration: number | null;
  } | undefined;

  if (!job) {
    VideoAnalysisLogger.error(jobId, 'JOB_LOAD_FAILED', `Job not found in database: ${jobId}`);
    return;
  }

  // 各环节的结构化输出；成功和失败都会落库（失败时保留已完成环节的输出，便于排查）
  const trace = createTrace(job.analysis_type, job.video_duration ?? undefined);

  try {
    // 上传时没探测到时长（或历史任务）则在这里补测一次，用于片段截断
    let videoDuration = job.video_duration;
    if (videoDuration == null) {
      const probed = await probeVideoDuration(job.video_path);
      if (probed !== undefined) {
        videoDuration = probed;
        trace.videoDurationSec = probed;
        db.prepare(`UPDATE analysis_jobs SET video_duration = ? WHERE id = ?`).run(probed, jobId);
      }
    }

    VideoAnalysisLogger.info(jobId, 'JOB_START', `Processing video analysis job (${job.analysis_type})`, {
      jobId: job.id,
      videoPath: job.video_path,
      mimeType: job.mime_type,
      videoDuration
    });

    const { payload, storage, fileRef, model } = await uploadAndAnalyzeVideo({
      jobId,
      videoPath: job.video_path,
      mimeType: job.mime_type || 'video/mp4',
      analysisType: job.analysis_type,
      videoDurationSec: videoDuration ?? undefined,
      trace,
      deps: { recommendTutorials },
    });

    // 存储报告，标记完成（gemini_file_name 已废弃，改写 provider + file_ref）
    db.prepare(
      `UPDATE analysis_jobs
       SET status = 'done',
           report = ?,
           model = ?,
           provider = ?,
           file_ref = ?,
           trace = ?,
           completed_at = ?
       WHERE id = ?`
    ).run(
      JSON.stringify(payload),
      model,
      storage,
      fileRef,
      JSON.stringify(trace),
      new Date().toISOString(),
      jobId
    );

    VideoAnalysisLogger.info(jobId, 'JOB_SUCCESS', `Job completed successfully`);

  } catch (err: any) {
    const errorCode = errorMessage(err) || 'UNKNOWN_ERROR';
    VideoAnalysisLogger.error(jobId, 'JOB_FAILED', `Job failed with error: ${errorCode}`);
    trace.error = errorCode;

    db.prepare(
      `UPDATE analysis_jobs SET status = 'failed', error = ?, trace = ?, completed_at = ? WHERE id = ?`
    ).run(errorCode, JSON.stringify(trace), new Date().toISOString(), jobId);
  }
}
