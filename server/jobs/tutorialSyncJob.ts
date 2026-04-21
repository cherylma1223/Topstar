import cron from 'node-cron';
import { runSyncTutorials } from '../scripts/syncTutorials';

/**
 * 视频教程自动同步定时任务
 * 
 * 时间设定：每周一凌晨 04:00 运行
 * Cron 表达式: '0 4 * * 1'
 */
export function startTutorialSyncJob(): void {
  // 每周一凌晨 4 点执行
  cron.schedule('0 4 * * 1', async () => {
    console.log('[TutorialSyncJob] Starting scheduled weekly sync...');
    try {
      const result = await runSyncTutorials();
      if (result.success) {
        console.log('[TutorialSyncJob] Automated sync completed successfully.');
      } else {
        console.error('[TutorialSyncJob] Automated sync failed:', result.error);
        console.error(`[TutorialSyncJob] Rollback data available in ${result.backupPath}`);
      }
    } catch (err: any) {
      console.error('[TutorialSyncJob] Unexpected error during job execution:', err.message);
    }
  });

  console.log('[TutorialSyncJob] Cron job registered: weekly every Monday at 04:00');
}
