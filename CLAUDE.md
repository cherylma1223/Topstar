# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

### 客户端 (client/)
```bash
cd client && npm run dev      # Vite 开发服务器，端口 3000
cd client && npm run build    # 生产构建到 dist/
```

### 服务端 (server/)
```bash
cd server && npm run dev      # tsx watch 热重载，端口 3001
cd server && npm run build    # 仅类型检查 (tsc --noEmit)，不产生输出
cd server && npm start        # 生产启动
cd server && npm run import-tutorials   # 导入教程数据
cd server && npm run sync-tutorials     # 从外部源同步教程
cd server && npm run bootstrap-scores   # 初始化质量评分
```

### 注意事项
- 客户端通过 Vite proxy 将 `/api` 请求代理到 `localhost:3001`，所有 API 密钥仅存在于服务端
- 项目没有测试用例（server 的 test 脚本是占位符，直接 exit 1）

## 架构概览

**Topstar（当家球星）** 是一个 AI 乒乓球教练应用。前端 React + TypeScript + Vite，后端 Express + TypeScript + SQLite (better-sqlite3, WAL 模式)。通过 Google Gemini API 提供智能教练对话、视频动作分析、教程推荐等功能。

### API 路由

| 路由前缀 | 文件 | 用途 |
|---------|------|------|
| `/api/v1` | `server/routes/v1.ts` | 旧版 API：chat、TTS、图片生成 |
| `/api/v2` | `server/routes/v2.ts` | 新版 API：编排式 chat、TTS 分段、教程推荐、视频分析 Job CRUD |

### 核心链路：对话编排 (handleChatEvent)

`server/orchestrator/handleChatEvent.ts` 是对话的核心 pipeline：

1. **意图识别** → `intent/intentRouter.ts`：两层分类（规则优先，LLM 兜底），6 种意图：ACTION_COACHING / TACTIC_ADVICE / EQUIPMENT_QA / TUTORIAL_REQUEST / VIDEO_ANALYSIS / OFF_TOPIC
2. **知识检索** → `knowledge/loader.ts` + `knowledge/matcher.ts`：从 `client/src/assets/knowledge/` 加载 Markdown 知识库，关键词匹配
3. **教程推荐** → `tutorials/recommendTutorials.ts`：召回→打分→重排，分值权重：action_id 匹配 +5，tag 命中 +2（上限），标题 +0.5
4. **上下文组装** + **LLM 调用**（`gemini-3-flash-preview`）→ 将知识库内容、教程推荐、模板约束注入 system instruction
5. **模板校验** → `orchestrator/templateValidator.ts`：确保 LLM 输出包含模板要求的必要段落
6. **输出清洗** → 非 VIP 用户剥离 VIP 内容，附加 `[LOCKED_VIP_CONTENT]` 占位符

### 核心链路：视频分析 (handleAnalysisJob)

`server/orchestrator/handleAnalysisJob.ts` — 两轮分析：

1. **Pass 1**：识别有效乒乓球动作片段，过滤无效内容
2. **Pass 2**：对有效片段逐帧分析，生成 TechniqueReport（问题点 + 改进建议 + 视频链接）

模型优先级：`gemini-3.1-pro-preview` → `gemini-2.5-pro` → `gemini-2.5-flash`

视频先上传 Gemini Files API，轮询至 ACTIVE 状态，分析完成后清理。

Worker (`server/jobs/analysisWorker.ts`) 每 10 秒轮询 `analysis_jobs` 表中 status=queued 的任务，串行处理。

### 数据库 (SQLite)

- `tutorial_videos` — 教程视频库，含平台信息、标签、关联动作/战术 ID、质量评分、链接健康状态
- `analysis_jobs` — 视频分析任务，含状态流转（queued → running → done/failed）、分析结果 JSON、Gemini 文件引用

### 定时任务 (node-cron)

| 任务 | 文件 | 频率 |
|------|------|------|
| 链接健康检查 | `jobs/linkHealthCheck.ts` | 每天凌晨 3:00 |
| 教程同步 | `jobs/tutorialSyncJob.ts` | 每周一凌晨 4:00 |

### 客户端状态管理

`App.tsx` 是状态中心，管理 `currentScreen`（HOME/CHAT/HISTORY/SETTINGS/APPEARANCE）、`messages`（Message[]，每个 Message 含多个 MessagePart）、`history`、视频播放覆盖层。

`geminiService.ts`（670 行）是 AI 服务层：V2 对话、TTS 分段语音合成与缓存（内存缓存，10 分钟 TTL）、视频分析 Job 创建与轮询、带指数退避的重试（503/429）。

### 系统提示词

`UNIFIED_COACH_INSTRUCTION` 定义在 `client/geminiService.ts`，包含三种输出模板：技术动作分析、战术建议、器材问答。服务端 orchestrator 在此基础上追加知识库上下文和模板约束再发给 LLM。

### 类型定义

核心类型在 `client/types.ts`：`Message`、`MessagePart`、`AnalysisReport`、`AppScreen`。

服务端类型在 orchestrator 文件中内联定义：`ChatRequest`、`ChatResponse`、`AnalysisReportPayload`、`TechniqueReport`。

### 知识库

`client/src/assets/knowledge/` 存放知识库 Markdown 文件 + `index.json`，服务端启动时加载到内存 Map。`knowledge_git_repo/` 是知识库的独立 git 仓库。
