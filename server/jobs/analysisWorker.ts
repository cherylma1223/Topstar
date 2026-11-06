/**
 * 视频分析任务 Worker
 *
 * 基于 node-cron 的 SQLite Polling Worker。
 * 每 10 秒扫描 status='queued' 的 job，串行处理，防并发。
 * 为避免新任务白等一个轮询周期：
 *   - 入队后由 enqueueAnalysisJob 调用 triggerAnalysisPoll() 立即扫描一次；
 *   - 处理完一个任务后立刻再扫描一次，连续消化积压任务。
 * 参考：Codex v6 §20.2 / Phase 2-A 设计文档 §5.2
 */
import cron from 'node-cron';
import db from '../db';
import { processAnalysisJob } from '../orchestrator/handleAnalysisJob';

const MAX_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
let isRunning = false;
/** Worker 是否已启动且未被 ANALYSIS_WORKER_ENABLED=false 关闭；关闭时 trigger 不做任何事 */
let workerStarted = false;

// ─── 扫描 + 处理 ────────────────────────────────────────────────
/** @returns 本次是否取到并处理了一个任务 */
async function pollAndProcess(): Promise<boolean> {
  if (isRunning) return false; // 防止重入
  isRunning = true;

  try {
    // 捞取一条最老的 queued job
    const job = db.prepare(
      `SELECT id FROM analysis_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
    ).get() as { id: string } | undefined;

    if (!job) return false;

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
    return true;
  } catch (err: any) {
    console.error('[AnalysisWorker] Poll error:', err.message);
    return false;
  } finally {
    isRunning = false;
  }
}

/** 扫描一次；若处理了任务则立刻再扫描，直到队列清空（失败的任务已离开 queued 状态，不会死循环） */
async function runPoll(): Promise<void> {
  const processed = await pollAndProcess();
  if (processed) setImmediate(() => { void runPoll(); });
}

/**
 * 新任务入队后调用：立即扫描一次，不等下一个 10 秒轮询。
 * 在 setImmediate 里执行，不会拖慢上传接口的响应。重复触发是安全的（isRunning 防重入，
 * 抢占任务靠 `status='queued'` 的原子 UPDATE）。
 */
export function triggerAnalysisPoll(): void {
  if (!workerStarted) return;
  setImmediate(() => { void runPoll(); });
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

  workerStarted = true;

  // 每 10 秒执行一次（兜底：服务重启恢复的任务、触发时恰好正在处理其他任务的情况）
  cron.schedule('*/10 * * * * *', async () => {
    try {
      await runPoll();
    } catch (err: any) {
      console.error('[AnalysisWorker] Unexpected error in poll:', err.message);
    }
  });

  console.log('[AnalysisWorker] Started (polling every 10s)');
}
