/**
 * 视频分析任务 Worker
 *
 * 基于 node-cron 的 SQLite Polling Worker。
 * 每 10 秒扫描 status='queued' 的 job，串行处理，防并发。
 * 参考：Codex v6 §20.2 / Phase 2-A 设计文档 §5.2
 */
import cron from 'node-cron';
import db from '../db';
import { processAnalysisJob } from '../orchestrator/handleAnalysisJob';

const MAX_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
let isRunning = false;

// ─── 扫描 + 处理 ────────────────────────────────────────────────
async function pollAndProcess(): Promise<void> {
  if (isRunning) return; // 防止重入
  isRunning = true;

  try {
    // 捞取一条最老的 queued job
    const job = db.prepare(
      `SELECT id FROM analysis_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
    ).get() as { id: string } | undefined;

    if (!job) return;

    console.log(`[AnalysisWorker] Picking up job: ${job.id}`);

    // 超时保护：10 分钟
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), MAX_JOB_TIMEOUT_MS)
    );

    try {
      await Promise.race([processAnalysisJob(job.id), timeoutPromise]);
    } catch (err: any) {
      console.error(`[AnalysisWorker] Job ${job.id} failed:`, err.message);
      // 更新为 failed（若 processAnalysisJob 内部已处理则幂等）
      db.prepare(
        `UPDATE analysis_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'running'`
      ).run(err.message || 'UNKNOWN_ERROR', new Date().toISOString(), job.id);
    }
  } catch (err: any) {
    console.error('[AnalysisWorker] Poll error:', err.message);
  } finally {
    isRunning = false;
  }
}

// ─── 服务重启恢复 ─────────────────────────────────────────────────
/**
 * 将所有 'running' 状态的 job 重置为 'queued'（服务重启后恢复）
 */
export function recoverStaleJobs(): void {
  const result = db.prepare(
    `UPDATE analysis_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`
  ).run();

  if (result.changes > 0) {
    console.log(`[AnalysisWorker] Recovered ${result.changes} stale job(s) → queued`);
  }
}

// ─── 启动 Worker ──────────────────────────────────────────────────
export function startAnalysisWorker(): void {
  if (process.env.ANALYSIS_WORKER_ENABLED === 'false') {
    console.log('[AnalysisWorker] Disabled by ANALYSIS_WORKER_ENABLED=false');
    return;
  }

  // 每 10 秒执行一次
  cron.schedule('*/10 * * * * *', async () => {
    try {
      await pollAndProcess();
    } catch (err: any) {
      console.error('[AnalysisWorker] Unexpected error in poll:', err.message);
    }
  });

  console.log('[AnalysisWorker] Started (polling every 10s)');
}
