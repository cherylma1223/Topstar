/**
 * 分析任务入队接口
 *
 * MVP 阶段：job 在 DB 中标记为 queued 后，由进程内 worker 拾取。
 * 入队后立即唤醒 worker 扫描一次（不再白等最多 10 秒的轮询周期）；
 * 轮询仍保留作兜底。此函数是扩展点，未来可替换为 BullMQ / Redis Queue。
 * 参考：Codex v6 §20.5
 */
import { triggerAnalysisPoll } from './analysisWorker';

export async function enqueueAnalysisJob(jobId: string): Promise<void> {
  console.log(`[queue] job ${jobId} enqueued`);
  triggerAnalysisPoll();
}
