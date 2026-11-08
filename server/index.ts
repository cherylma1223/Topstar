import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import 'dotenv/config';

import { loadKnowledgeBase } from './knowledge/loader';
import v2Router from './routes/v2';
import authRouter from './routes/auth';
import { initAuthService } from './auth';
import { startLinkHealthCheck } from './jobs/linkHealthCheck';
import { startTutorialSyncJob } from './jobs/tutorialSyncJob';
import { recoverStaleJobs, startAnalysisWorker } from './jobs/analysisWorker';
import { isCapabilityAvailable, getDeployRegion } from './llm';

const app = express();
const port = process.env.PORT || 3001;

// 配置有问题（缺 AUTH_SECRET、生产环境用了控制台短信等）直接让服务启动失败
const authService = initAuthService();

// 部署在 nginx 等反向代理之后时，设置 TRUST_PROXY=1（代理层数），req.ip 才是真实客户端 IP；
// 不设置就不信任 X-Forwarded-For（防止被伪造 IP 绕过按 IP 的限制）
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isInteger(hops) && hops > 0 ? hops : process.env.TRUST_PROXY);
}

// 防止未捕获异常导致进程退出
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// 挂载路由
app.use('/api/v2/auth', authRouter);
app.use('/api/v2', v2Router);

// 兼容旧的健康检查路径
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', hasKey: isCapabilityAvailable('chat'), region: getDeployRegion() });
});

// 启动
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);

  // 加载知识库
  loadKnowledgeBase();

  // 定时清理过期的验证码和登录会话（启动时一次，之后每小时一次）
  const cleanupAuth = () => {
    try { authService.cleanup(); } catch (err: any) { console.error('[Auth] cleanup failed:', err?.message || err); }
  };
  cleanupAuth();
  setInterval(cleanupAuth, 60 * 60 * 1000).unref();

  // 启动链接健康检查定时任务
  startLinkHealthCheck();

  // 启动视频教程自动同步任务（每周一 04:00）
  startTutorialSyncJob();

  // 恢复中断的视频分析任务，启动分析 Worker
  recoverStaleJobs();
  startAnalysisWorker();
});

export default app;
