/**
 * 分析任务入队接口
 *
 * MVP 阶段：job 在 DB 中标记为 queued 后，worker 自动轮询拾取。
 * 此函数作为扩展点预留，未来可替换为 BullMQ / Redis Queue。
 * 参考：Codex v6 §20.5
 */
export async function enqueueAnalysisJob(jobId: string): Promise<void> {
  console.log(`[queue] job ${jobId} enqueued`);
}
