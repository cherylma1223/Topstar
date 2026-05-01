# Topstar 开发任务清单

生成日期：2026-03-19  
对应设计文档：`Topstar_Product_Technical_Design_codex_v4.md`  
说明：任务按优先级顺序排列，同一 Phase 内请尽量按顺序开发，有依赖关系的任务已标注。

---

## Phase 1：教程推荐 + 结构化输出落地（目标 1-2 周）

> 目标：问"反手拧拉怎么练/给我视频教程"能返回真实链接，模型不再编造链接，死链不出现在结果里。

### 数据层

- [ ] **P1-D1** 定义并创建 `tutorial_videos` 表 DDL（字段参考设计文档 §4.4 + §17.3 + §19.4，含 `tutorial_id`、`status`、`quality_score`、`score_source`、`consecutive_failures`、`last_checked_at`、`last_verified_at`、`click_count`、`impression_count` 等字段；SQLite WAL 模式；参考 §10.3）
- [ ] **P1-D2** 定义并创建 `chat_sessions` 和 `chat_messages` 表 DDL（§10.2）
- [ ] **P1-D3** 编写数据归一化脚本 `server/scripts/normalize_pingpong_merged_tutorials.js`：将收藏原始数据（抖音 + B 站合并）输出为标准 `tutorials.pingpong-merged.normalized.json`（schema 参考 §4.4）
- [ ] **P1-D4** 编写冷启动评分脚本 `server/scripts/bootstrap_quality_scores.ts`：对 `quality_score = 0` 的记录自动计算初始分，写入 DB，标记 `score_source = 'auto_bootstrap_v1'`（算法参考 §19.2）
  - 依赖：P1-D1、P1-D3

### 服务端：教程库模块

- [ ] **P1-S1** 实现 `server/tutorials/loadTutorials.ts`：启动时从 JSON 文件加载教程库到内存，建立 `action_id` 倒排索引和 `tags` 倒排索引（§4.4、§11）
  - 依赖：P1-D3
- [ ] **P1-S2** 实现 `server/tutorials/scoreCandidate.ts`：`scoreCandidate(tutorial, tags)` 函数，含评分量级（action 命中 +5、tag 命中上限 +2、标题命中 +0.5，参考 §11）
- [ ] **P1-S3** 实现 `server/tutorials/recommendTutorials.ts`：`recommendTutorials(actionId, tags, limit)` 函数，先召回候选（过滤 `status = 'dead'`），再综合 `scoreCandidate` + `status` + `quality_score * 0.3` rerank，返回 Top-N（§11、§17.2）
  - 依赖：P1-S1、P1-S2

### 服务端：意图识别模块

- [ ] **P1-S4** 实现 `server/orchestrator/intentRouter.ts`：规则层（关键词强命中）+ 模型兜底（结构化 JSON 输出），返回 `{ intent, entities, confidence }`（§5.2）
- [ ] **P1-S5** 为意图识别创建 `intent_eval_set.jsonl`：人工写 30-50 条典型用户问题 + 期望 intent + 期望 action_id，用于后续 prompt 调试和 confidence 阈值校准（§5.3）

### 服务端：知识编排层

- [ ] **P1-S6** 实现 `server/knowledge/actions.ts`：加载动作知识库 Markdown，提供 `retrieveByIntent(intent, entities)` 接口（§4.1）
- [ ] **P1-S7** 实现 `server/knowledge/tactics.ts`：加载战术知识库，接口同上（§4.2）
- [ ] **P1-S8** 实现 `server/knowledge/equipment.ts`：加载器材知识库，接口同上（§4.3）
- [ ] **P1-S9** 实现 `server/templates/`：各 intent 的输出模板约束与校验函数，缺字段时补"暂无/待补充"降级（§7.3）
- [ ] **P1-S10** 实现 `server/orchestrator/handleChatEvent.ts`：完整编排流程——预处理 → 意图路由 → 知识检索 → 教程推荐 → 上下文组装 → LLM 调用 → 模板校验 → 结构化输出（§6.1）
  - 依赖：P1-S3、P1-S4、P1-S6、P1-S7、P1-S8、P1-S9

### 服务端：API 层

- [ ] **P1-S11** 新增 `POST /api/v2/chat` 接口：返回 `ChatResponse` 结构化 JSON，保持 v1 接口不变（§9、§7.2）
  - 依赖：P1-S10
- [ ] **P1-S12** 新增 `POST /api/v2/tutorials/recommend` 接口（§9）
  - 依赖：P1-S3
- [ ] **P1-S13** 实现统一错误响应中间件：所有 v2 接口错误统一返回 `ErrorResponse` 结构，含 `code`、`retryable`、`request_id`（§9.1）
- [ ] **P1-S14** 为所有请求生成 `request_id`，记录 intent、命中知识条目、命中教程数量、耗时、错误码到日志（§12.3）

### 服务端：外链健康检查 Job

- [ ] **P1-S15** 实现 `server/jobs/link-health-check.ts`：含速率控制（每次请求 200-500ms 随机 jitter）、连续失败阈值（`DEAD_THRESHOLD = 3`）、状态流转逻辑（§17.2）
  - 依赖：P1-D1
- [ ] **P1-S16** 用 `node-cron` 注册健康检查 Job，每天凌晨 3 点执行（§17.2）
  - 依赖：P1-S15

### 前端

- [ ] **P1-F1** `/api/v2/chat` 接入：将现有聊天请求从 v1 迁移至 v2，消费 `ChatResponse` 结构化返回
  - 依赖：P1-S11
- [ ] **P1-F2** 教程链接渲染：报告卡片 `videoLinks` 从后端 `tutorialVideos` 数组渲染为超链接，不再使用 mock 数据
  - 依赖：P1-F1

### Phase 1 验收检查

- [ ] 问"反手拧拉怎么练/给我视频教程"，响应中返回真实 B 站/抖音链接
- [ ] 模型回复中不出现任何自编链接（所有链接来自教程库）
- [ ] 死链（`status = 'dead'`）不出现在推荐结果里
- [ ] 有 `action_id` 关联的教程排在无关联教程之前
- [ ] 运行冷启动脚本后，`quality_score` 有明显分层（有 action 关联的高于无关联的）

---

## Phase 2：视频分析任务化（目标 1-2 周）

> 目标：消灭 setTimeout mock，建立真实的任务状态机，视频分析链路端到端跑通。

### 数据层

- [ ] **P2-D1** 定义并创建 `analysis_jobs` 和 `analysis_reports` 表 DDL（字段含 `status`、`stage`、`user_desc`、`video_path`、`report`、`error`、`created_at`、`completed_at`，§10.2、§18.2）
- [ ] **P2-D2** 定义并创建 `usage_events` 表 DDL（记录 `tutorial_impression`、`tutorial_click`、token 使用量等，§12.3、§19.3）

### 服务端：Analysis Job 状态机

- [ ] **P2-S1** 实现 `server/jobs/queue.ts`：`enqueueAnalysisJob(jobId)` 接口（§20.5）
- [ ] **P2-S2** 实现 `server/jobs/analysisWorker.ts`：SQLite Polling Worker，每 10 秒扫描 `status = 'queued'` 的 job，含并发保护（`isRunning` 标志）（§20.2）
- [ ] **P2-S3** 实现服务启动时的 `recoverStaleJobs()`：将 `status = 'running'` 的残留 job 重置为 `queued`（§20.2）
- [ ] **P2-S4** 实现 `server/orchestrator/handleAnalysisJob.ts` 阶段 A：`createAnalysisJobStageA()` + `processJobStageA()`，输入为结构化用户描述，不接收视频文件（§18.2）
  - 依赖：P2-S1、P2-D1
- [ ] **P2-S5** 实现 job 超时保护：`processJobStageA` 加 5 分钟超时，超时后写入 `status = 'failed'`（§20.2 超时处理）
  - 依赖：P2-S4

### 服务端：API 层

- [ ] **P2-S6** 新增 `POST /api/v2/analysis/jobs`：创建任务，接收结构化描述字段，返回 `job_id`（§9）
  - 依赖：P2-S4
- [ ] **P2-S7** 新增 `GET /api/v2/analysis/jobs/{job_id}`：查询任务状态与报告（§9）
  - 依赖：P2-D1
- [ ] **P2-S8** 新增 `POST /api/v2/tutorials/{tutorial_id}/report-dead`：用户失效上报，将 `status` 设为 `suspect`（§17.2 层 3）
- [ ] **P2-S9** 新增 `POST /api/v2/tutorials/impression` 和 `POST /api/v2/tutorials/{tutorial_id}/click`：曝光和点击事件上报，写入 `usage_events`（§19.3）
  - 依赖：P2-D2

### 服务端：Worker 启动集成

- [ ] **P2-S10** 在 `server/index.ts` 启动时调用 `recoverStaleJobs()` 和 `startAnalysisWorker()`（§20.2）
  - 依赖：P2-S2、P2-S3

### 前端

- [ ] **P2-F1** 视频分析入口改版：移除视频文件上传控件，改为结构化描述表单（技术动作、遇到的问题、改进方向，§18.2 阶段 A 交互设计）
- [ ] **P2-F2** 实现轮询逻辑：提交后轮询 `GET /api/v2/analysis/jobs/{id}`，前 30 秒每 3 秒一次，之后每 10 秒一次，超过 10 分钟提示超时（§18.4）
  - 依赖：P2-S7
- [ ] **P2-F3** 报告卡片渲染：`status = 'done'` 后渲染 `AnalysisReport`，卡片顶部加说明文字"本报告根据您的描述生成，视频帧分析功能即将上线"（§18.2、§18.4）
  - 依赖：P2-F2
- [ ] **P2-F4** 教程卡片加"链接失效？"上报按钮，点击调用 `report-dead` 接口（§17.2 层 3）
  - 依赖：P2-S8
- [ ] **P2-F5** 教程链接加点击上报（调用 `/click` 接口），报告卡片加曝光上报（调用 `/impression` 接口）（§19.3）
  - 依赖：P2-S9

### Phase 2 验收检查

- [ ] 不再有任何 `setTimeout` 驱动的 mock 报告
- [ ] 提交描述后可看到 `queued → running → done` 状态流转
- [ ] 任务失败时 `status = 'failed'`，有错误信息，前端给出提示
- [ ] 服务重启后，未完成的 job 自动恢复处理
- [ ] 教程点击/曝光数据写入 `usage_events` 表

---

## Phase 3：视频真实理解 + 质量持续优化（持续迭代）

> 目标：真正看视频、推荐质量自动优化、为小程序适配做好准备。

### 数据库迁移

- [ ] **P3-D1** 将 SQLite 迁移至 PostgreSQL（Prisma schema + migration，§10.2）
- [ ] **P3-D2** `tutorial_videos` 表添加 `version` 字段（用于乐观锁），为点击率调权 Job 的并发安全做准备（§10.3）

### 视频真实理解（阶段 B）

- [ ] **P3-S1** 实现 `processJobStageB()`：接入 Gemini Files API，上传视频 → 等待处理 → 调用生成模型 → 解析 JSON 报告 → 关联教程推荐（§18.2 阶段 B）
- [ ] **P3-S2** 前端恢复视频上传控件（替换阶段 A 的文字描述表单），接入 `PUT /api/v2/analysis/jobs/{id}/upload`（§9）
  - 依赖：P3-S1
- [ ] **P3-S3** 前端根据阶段更新等待文案："正在分析您的视频动作，请耐心等待..."（§18.4）
  - 依赖：P3-S2
- [ ] **P3-S4** 将环境变量 `VIDEO_ANALYSIS_STAGE` 从 `A` 切换为 `B`，验证端到端（§18.3）
  - 依赖：P3-S1
- [ ] **P3-S5** 阶段 B 超时保护升级：`processJobStageB` 加 10 分钟超时（Gemini 视频处理最慢约 5 分钟，§18.2、§20.2）
  - 依赖：P3-S1

### 推荐质量持续优化

- [ ] **P3-S6** 实现点击率调权定期 Job（每周执行一次）：CTR 显著高于均值的 `quality_score += 0.5`，持续 30 天无点击的 `quality_score -= 0.3`，使用 PostgreSQL 乐观锁（§19.3、§10.3）
  - 依赖：P3-D1、P3-D2
- [ ] **P3-S7** （可选）实现模型辅助批量打分：对有 `title + description` 的条目，调用 Gemini Flash 批量评估教学相关性，返回 0-3 分作为补充信号，标记 `score_source = 'model_assisted'`（§19.3）

### 语义检索增强（可选）

- [ ] **P3-S8** （可选）为动作/战术/教程建立 embedding 索引，`recallTutorialCandidates()` 支持 `strategy = 'hybrid'`（关键词 + 语义）（§16 扩展点、§11）

### 小程序适配

- [ ] **P3-F1** 小程序端 UI 层适配：复用所有 `/api/v2/*` BFF 接口，仅替换前端 UI 组件（§3.1、§16）

### Phase 3 验收检查

- [ ] 上传真实视频后，报告内容基于视频帧分析生成（不再是文字描述）
- [ ] 报告中的 `problems[].timestamp` 指向视频中真实的时间点
- [ ] 点击率调权 Job 运行后，高点击率教程的 `quality_score` 有可见提升
- [ ] PostgreSQL 迁移完成，所有并发写入场景无报错

---

## 附录：跨 Phase 持续任务

以下任务不属于某个具体 Phase，应在整个开发周期中持续维护：

- [ ] **持续** 扩充 `intent_eval_set.jsonl`：每次修改意图识别 prompt 后，在 eval set 上跑回归，记录准确率变化（§5.3）
- [ ] **持续** 人工抽样标注教程质量：优先标注展示量 Top 100 的教程，设置 `score_source = 'human'`（§19.3）
- [ ] **持续** 监控 `usage_events` 表中的死链上报量和点击率分布，作为推荐质量的健康指标
- [ ] **持续** 关注 Gemini 模型版本更新，必要时更新 `GEMINI_VIDEO_MODEL` 环境变量（§18.2）
