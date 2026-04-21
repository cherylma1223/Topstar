/**
 * 链接健康检查定时任务
 * 
 * 设计文档 §17.2：三层可用性治理 - 层 1（定期探测 Job）
 * 
 * 状态流转：
 * active ──[探测失败]──> suspect ──[连续失败 ≥ 3 次]──> dead
 *   ^                      |
 *   └──[探测成功]──────────┘
 * dead  ──[30天后重探,探测成功]──> active
 */
import cron from 'node-cron';
import { getTutorialsForHealthCheck, updateTutorialStatus } from '../tutorials/loader';

const CHECK_INTERVAL_DAYS = 7;   // 普通条目每 7 天检查一次
const DEAD_RETRY_DAYS = 30;      // dead 条目每 30 天重新确认
const DEAD_THRESHOLD = 3;        // 连续失败 3 次才升级为 dead
const MAX_PER_BATCH = 200;       // 每次批跑最多处理 200 条

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 探测单个链接的可用性
 */
async function checkOne(url: string, platform: string): Promise<'active' | 'suspect' | 'dead_confirmed'> {
  try {
    if (platform === 'douyin') {
      // 抖音对 HEAD 有 403 拦截，改为 GET + 检查 title
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Topstar-LinkBot/1.0)' },
      });
      if (!res.ok) return 'suspect';
      const body = await res.text();
      if (body.includes('找不到') || body.includes('已删除') || body.includes('已失效') || body.includes('页面不存在')) {
        return 'dead_confirmed';
      }
      return 'active';
    } else {
      // B 站等：HEAD 检查通常有效
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Topstar-LinkBot/1.0' },
      });
      if (res.ok) return 'active';
      if (res.status === 404 || res.status === 410) return 'dead_confirmed';
      return 'suspect';
    }
  } catch {
    return 'suspect'; // 超时 / 网络错误 -> 先标疑似，避免误杀
  }
}

/**
 * 执行一次批量健康检查
 */
async function runHealthCheck(): Promise<void> {
  console.log('[LinkHealthCheck] Starting batch check...');
  const now = Date.now();
  const tutorials = getTutorialsForHealthCheck(CHECK_INTERVAL_DAYS, DEAD_RETRY_DAYS);

  let checked = 0;
  let updated = 0;

  for (const t of tutorials) {
    if (checked >= MAX_PER_BATCH) {
      console.log(`[LinkHealthCheck] Batch limit reached (${MAX_PER_BATCH}), remaining deferred to next run`);
      break;
    }

    // 判断是否需要检查
    const lastCheck = t.last_checked_at ? new Date(t.last_checked_at).getTime() : 0;
    const staleDays = (now - lastCheck) / 86400000;
    const needsCheck = t.status !== 'dead'
      ? staleDays >= CHECK_INTERVAL_DAYS
      : staleDays >= DEAD_RETRY_DAYS;

    if (!needsCheck) continue;

    // 速率控制：随机 jitter 200-500ms
    await sleep(200 + Math.random() * 300);

    const platform = (t as any).platform || 'bilibili';
    const probe = await checkOne((t as any).url, platform);
    checked++;

    const consecutiveFailures = (probe === 'suspect' || probe === 'dead_confirmed')
      ? (t.consecutive_failures ?? 0) + 1
      : 0;

    // 状态升级规则
    let newStatus: 'active' | 'suspect' | 'dead' = t.status as any;
    if (probe === 'active') {
      newStatus = 'active';
    } else if (consecutiveFailures >= DEAD_THRESHOLD) {
      newStatus = 'dead';
    } else {
      newStatus = 'suspect';
    }

    // 只在状态或失败次数发生变化时写入
    if (newStatus !== t.status || consecutiveFailures !== t.consecutive_failures) {
      updateTutorialStatus(t.tutorial_id, {
        status: newStatus,
        consecutive_failures: consecutiveFailures,
        last_checked_at: new Date().toISOString(),
      });
      updated++;
    }
  }

  console.log(`[LinkHealthCheck] Complete: checked ${checked}, updated ${updated}`);
}

/**
 * 启动定时任务（每天凌晨 3 点执行）
 */
export function startLinkHealthCheck(): void {
  // 每天凌晨 3 点执行
  cron.schedule('0 3 * * *', async () => {
    try {
      await runHealthCheck();
    } catch (err: any) {
      console.error('[LinkHealthCheck] Job failed:', err.message);
    }
  });

  console.log('[LinkHealthCheck] Cron job registered: daily at 03:00');
}

// 导出 runHealthCheck 用于手动触发
export { runHealthCheck };
