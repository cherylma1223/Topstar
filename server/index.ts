import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import 'dotenv/config';

import { loadKnowledgeBase } from './knowledge/loader';
import v1Router from './routes/v1';
import v2Router from './routes/v2';
import { startLinkHealthCheck } from './jobs/linkHealthCheck';
import { startTutorialSyncJob } from './jobs/tutorialSyncJob';

const app = express();
const port = process.env.PORT || 3001;

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
app.use('/api/v1', v1Router);
app.use('/api/v2', v2Router);

// 兼容旧的健康检查路径
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', hasKey: !!process.env.GEMINI_API_KEY });
});

// 启动
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);

  // 加载知识库
  loadKnowledgeBase();

  // 启动链接健康检查定时任务
  startLinkHealthCheck();

  // 启动视频教程自动同步任务（每周一 04:00）
  startTutorialSyncJob();
});

export default app;
