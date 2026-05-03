# Phase 2-A：视频分析任务化 — 实施计划

> 设计文档：[Phase 2-A_video_analysis_design.md](file:///Users/yingdongma/Documents/Dev/projects/Topstar/docs/coding_plan/phase2/Phase%202-A_video_analysis_design.md)
>
> 目标：消灭 `setTimeout` 假报告，建立持久化异步任务系统 + 接入 Gemini Files API 实现真正的视频分析。

---

## User Review Required

> [!IMPORTANT]
> **Gemini SDK 版本**：当前项目使用 `@google/genai` SDK。Gemini Files API（文件上传）在新版 SDK 中通过 `ai.files.upload()` 调用。需确认当前 `package.json` 中的 SDK 版本是否已支持该 API，否则需要升级。

> [!WARNING]
> **视频文件存储**：MVP 方案将视频文件存储在服务端本地磁盘 `server/uploads/`。这个目录需要被 `.gitignore`。如果部署在容器/Serverless 环境，需要改为云存储（S3/GCS）。请确认当前部署方式。

> [!IMPORTANT]
> **前端 mock 替换**：`ChatScreen.tsx` 中 `handleFileUpload` 的 `setTimeout` 整块逻辑（L109-188）将被完全替换为真实的上传 + 轮询流程。"AI 场外指导" 的 mock 报告（球员 A/B 战术分析）也将被真实分析替代。

## Open Questions

1. **模型选择**：Gemini 视频分析默认使用 `gemini-3.1-pro-preview`。这是 2026 年视频理解能力最强的模型，支持复杂的时序推理。
2. **视频时长限制**：设计文档建议 ≤ 120 秒。是否接受这个限制？

---

## Proposed Changes

按执行步骤组织：

### Step 1：后端基建（表 + Worker + Queue）

---

#### [MODIFY] [db.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/db.ts)

新增 `analysis_jobs` 表的建表语句。追加在现有 `tutorial_videos` 建表语句之后。

```sql
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id                    TEXT PRIMARY KEY,
  status                TEXT NOT NULL DEFAULT 'queued',
  analysis_type         TEXT NOT NULL DEFAULT 'technique',
  video_path            TEXT,
  video_filename        TEXT,
  video_size            INTEGER,
  video_duration        INTEGER,
  mime_type             TEXT,
  report                TEXT,
  report_schema_version TEXT DEFAULT 'v1',
  error                 TEXT,
  model                 TEXT,
  gemini_file_name      TEXT,
  attempt_count         INTEGER DEFAULT 0,
  created_at            TEXT NOT NULL,
  started_at            TEXT,
  completed_at          TEXT
);
```

---

#### [NEW] [queue.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/jobs/queue.ts)

入队接口。MVP 阶段 job 已在 DB 中标记 `queued`，worker 自动轮询拾取，此函数为扩展点预留（未来可替换为 BullMQ/Redis Queue）。

```ts
export async function enqueueAnalysisJob(jobId: string): Promise<void> {
  console.log(`[queue] job ${jobId} enqueued`);
}
```

参考：Codex v6 §20.5。

---

#### [NEW] [analysisWorker.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/jobs/analysisWorker.ts)

SQLite Polling Worker。核心逻辑：

1. 每 10 秒扫描 `status='queued'` 的 job（按 `created_at ASC`）
2. 串行处理（`isRunning` 防并发）
3. 调用 `processAnalysisJob()` 处理单个 job
4. 单 job 超时保护：10 分钟

同时导出 `recoverStaleJobs()` 供启动时调用。

参考：Codex v6 §20.2。

---

#### [MODIFY] [index.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/index.ts)

在 `app.listen()` 回调中新增两行：

```diff
 app.listen(port, () => {
   console.log(`Server running at http://localhost:${port}`);
   loadKnowledgeBase();
   startLinkHealthCheck();
   startTutorialSyncJob();
+  recoverStaleJobs();
+  startAnalysisWorker();
 });
```

引入 `recoverStaleJobs` 和 `startAnalysisWorker`。

---

### Step 2：Gemini Files API 集成

---

#### [NEW] [handleAnalysisJob.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/orchestrator/handleAnalysisJob.ts)

Phase 2-A 的核心文件。采用 **Two-Pass Pipeline** 架构：先过滤无效片段（捡球/休息），再聚焦分析有效回合。

##### `processAnalysisJob(jobId: string)`

主处理函数，Worker 调用入口：

1. 更新 job `status = 'running'`, `started_at = now`
2. 读取 job 信息，获取 `video_path` 和 `analysis_type`
3. 上传视频到 Gemini Files API，等待处理完毕
4. **Pass 1**：调用 `identifyValidSegments()` 识别有效片段
5. **Pass 2**：调用 `analyzeSegments()` 聚焦分析有效片段
6. 关联教程推荐，更新 job `status = 'done'`, 存储 `report`
7. 清理 Gemini Files API 文件
8. 异常捕获 → `status = 'failed'`, 存储 `error`

##### Two-Pass Pipeline 实现

```ts
async function uploadAndAnalyzeVideo(videoPath: string, mimeType: string, analysisType: string) {
  const ai = getAI();
  const model = process.env.GEMINI_VIDEO_MODEL || 'gemini-3.1-pro-preview';

  // 1. 上传视频到 Gemini Files API (使用真实 MIME)
  const uploadResult = await ai.files.upload({
    file: videoPath,
    config: { mimeType },
  });

  // 2. 轮询等待处理完毕
  let file = uploadResult;
  while (file.state === 'PROCESSING') {
    await sleep(5000);
    file = await ai.files.get({ name: file.name });
  }
  if (file.state === 'FAILED') throw new Error('GEMINI_PROCESSING_FAILED');

  const fileData = { fileUri: file.uri, mimeType: file.mimeType };

  try {
    // ===== Pass 1：识别有效片段 (使用结构化输出) =====
    const pass1Response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [
        { fileData },
        { text: SEGMENT_IDENTIFICATION_PROMPT },
      ]}],
      config: { 
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: PASS1_SCHEMA 
      },
    });

    const rawSegments = JSON.parse(pass1Response.text);
    const segments = validateSegments(rawSegments.segments); // 新增校验逻辑

    if (segments.length === 0) {
      throw new Error('NO_VALID_SEGMENTS');
    }

    // ===== Pass 2：聚焦分析 (使用结构化输出) =====
    const pass2Prompt = buildPass2Prompt(analysisType, segments);
    const pass2Response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [
        { fileData },
        { text: pass2Prompt },
      ]}],
      config: { 
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: analysisType === 'technique' ? TECH_SCHEMA : MATCH_SCHEMA
      },
    });

    const reportData = JSON.parse(pass2Response.text);
    return wrapReportPayload(analysisType, reportData, segments); // 统一封装 reports[]
  } finally {
    // 清理上传的文件
    await ai.files.delete({ name: file.name }).catch(() => {});
  }
}
```

##### Prompt 定义

三套 prompt：

**`SEGMENT_IDENTIFICATION_PROMPT`**（Pass 1，两种分析类型通用）：
- 任务：识别视频中所有有效乒乓球动作片段的时间范围
- 过滤：捡球、等待、休息、聊天、走动等无效画面
- 输出：`{ segments: [{start, end, description}], total_valid_seconds }`

**`buildPass2Prompt(analysisType, segments)`**（动态生成 Pass 2 prompt）：
- 将 Pass 1 的时间戳列表注入 prompt，引导模型只分析有效片段
- `technique` 类型：输出技术诊断报告，timestamp 指向有效片段中的具体时间点
- `match_strategy` 类型：输出双方球员的战术分析报告数组

##### 教程关联

Pass 2 报告生成后，用 `action_ids_detected` 调用现有的 `recommendTutorials()` 关联真实教程链接，注入到 `report.videoLinks`。

##### 降级处理

- Pass 1 返回空 segments → job 标记 `failed`，错误信息："未识别到有效的乒乓球动作片段"
- Pass 1 JSON 解析失败 → 尝试正则提取，仍失败则 fallback 为 single-pass（跳过片段过滤，直接全量分析）
- Pass 2 JSON 解析失败 → 同上，尝试正则提取

---

### Step 3：API 路由 + 前端对接

---

#### [MODIFY] [v2.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/routes/v2.ts)

新增两个 API 路由：

##### `POST /api/v2/analysis/jobs`

- 接收：`multipart/form-data`（`video` 文件 + `analysis_type` 字段）
- 校验：文件类型（video/mp4, video/quicktime, video/webm）、大小 ≤ 100MB
- 保存视频到 `server/uploads/{job_id}.{ext}` (保留原始扩展名)
- 创建 `analysis_jobs` 记录，包含真实 `mime_type`
- 返回：`{ success: true, job_id, status: 'queued' }`

需要引入 `multer` 中间件处理文件上传：

```ts
import multer from 'multer';
const upload = multer({
  dest: path.join(__dirname, '../uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

router.post('/analysis/jobs', upload.single('video'), async (req, res) => { ... });
```

##### `GET /api/v2/analysis/jobs/:id`

- 查询 `analysis_jobs` 表
- 返回：`{ success: true, job_id, status, report?, error?, created_at, started_at?, completed_at? }`
- `report` 字段在 `status = 'done'` 时包含完整的 `AnalysisReport` JSON

---

#### [MODIFY] [geminiService.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/client/geminiService.ts)

新增两个前端 API 调用函数：

```ts
// 上传视频并创建分析 job
export async function createAnalysisJob(videoFile: File, analysisType: string): Promise<{ job_id: string }> {
  const formData = new FormData();
  formData.append('video', videoFile);
  formData.append('analysis_type', analysisType);
  const res = await fetch('/api/v2/analysis/jobs', { method: 'POST', body: formData });
  return res.json();
}

// 查询 job 状态
export async function getAnalysisJobStatus(jobId: string): Promise<AnalysisJobResponse> {
  const res = await fetch(`/api/v2/analysis/jobs/${jobId}`);
  const data = await res.json();
  // 映射友好错误消息 (基于 error code)
  if (data.status === 'failed' && data.error) {
    data.errorMessage = ERROR_MAP[data.error] || '分析失败，请重试';
  }
  return data;
}
```

---

#### [MODIFY] [ChatScreen.tsx](file:///Users/yingdongma/Documents/Dev/projects/Topstar/client/components/ChatScreen.tsx)

**核心改动**：`handleFileUpload`（L73-188）完全重写。

当前逻辑（被替换）：
```ts
// L109: setTimeout(() => { ... 硬编码报告 ... }, 3500);
```

新逻辑：

```ts
const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;

  // 1. 展示用户的视频消息（保持现有的缩略图生成逻辑）
  // ... (保留 L78-107 的用户消息添加和缩略图逻辑)

  setIsInternalProcessing(true);

  try {
    // 2. 上传视频 + 创建 job
    const analysisType = aiIcon === 'person' ? 'match_strategy' : 'technique';
    const { job_id } = await createAnalysisJob(file, analysisType);

    // 3. 轮询 job 状态
    const report = await pollJobUntilDone(job_id);

    // 4. 渲染报告
    setIsInternalProcessing(false);
    renderReport(report, analysisType);
  } catch (err) {
    setIsInternalProcessing(false);
    renderErrorMessage(err);
  }
};
```

其中 `pollJobUntilDone()` 实现轮询策略（前 30 秒每 3 秒，之后每 10 秒，10 分钟超时）。

**渲染逻辑**：报告结构与现有 `AnalysisReportCard` 完全对齐，`match_strategy` 类型返回多个报告卡片。不需要修改 `AnalysisReportCard` 组件本身。

---

#### [MODIFY] [ProcessingCard.tsx](file:///Users/yingdongma/Documents/Dev/projects/Topstar/client/components/ProcessingCard.tsx)

改动点：

1. **文案更新**：从"AI正在分析视频"改为"正在分析您的视频动作，请耐心等待..."
2. **进度逻辑**：当前的 `setInterval` 随机进度保留作为视觉反馈（因为 Gemini 不返回真实进度百分比），但增加阶段性文案变化：
   - 0-20%："正在上传视频..."
   - 20-50%："正在识别有效动作片段..."
   - 50-80%："AI正在分析技术动作..."
   - 80-90%："正在生成诊断报告..."

---

#### [MODIFY] [App.tsx](file:///Users/yingdongma/Documents/Dev/projects/Topstar/client/App.tsx)

无交互入口变更。但需确保 `handleSendMessage` 中的 `isAIService` 判断仍正确覆盖两个分析入口。

---

## 文件变更总览

| 文件 | 操作 | 改动量 | 说明 |
|------|------|--------|------|
| `server/db.ts` | 修改 | 小 | 新增 `analysis_jobs` 建表 |
| `server/jobs/queue.ts` | **新建** | ~15 行 | 入队扩展点 |
| `server/jobs/analysisWorker.ts` | **新建** | ~80 行 | Worker + 恢复机制 |
| `server/orchestrator/handleAnalysisJob.ts` | **新建** | ~150 行 | Gemini Files API 集成 + prompt |
| `server/routes/v2.ts` | 修改 | 中等 | 新增 2 个 API 路由 + multer |
| `server/index.ts` | 修改 | 小 | 启动 worker |
| `server/package.json` | 修改 | 小 | 新增 `multer` 依赖 |
| `client/geminiService.ts` | 修改 | 小 | 新增 2 个 API 函数 |
| `client/components/ChatScreen.tsx` | 修改 | **大** | 替换 setTimeout mock 为真实流程 |
| `client/components/ProcessingCard.tsx` | 修改 | 小 | 文案更新 |
| `server/uploads/` | **新建目录** | — | 视频文件存储（需 .gitignore） |

---

## Verification Plan

### 自动化测试

1. **TypeScript 编译检查**：
   ```bash
   cd server && npx tsc --noEmit
   ```

2. **数据库表验证**：
   ```bash
   sqlite3 server/topstar.db ".schema analysis_jobs"
   ```

### 手动验证

3. **端到端 Happy Path**：
   - 启动开发服务器
   - 通过"技术动作分析"入口上传一段 ≤ 30 秒的乒乓球训练视频
   - 验证：前端显示 ProcessingCard → 轮询状态变化 → 最终渲染报告卡片
   - 验证：报告内容与上传的视频内容相关（不是硬编码）
   - 验证：报告中的 `timestamp` 指向视频中的实际时间点

4. **AI 场外指导 Happy Path**：
   - 通过"AI 场外指导"入口上传一段乒乓球比赛视频
   - 验证：返回两个球员的分析报告

5. **异常场景验证**：
   - 上传非视频文件 → 400 错误
   - 上传超大文件 (>100MB) → 413 错误
   - 在 job 处理中重启服务器 → 重启后 job 自动恢复
   - 模拟 Gemini API 失败 → job 标记为 `failed`，前端展示错误提示

6. **数据库状态验证**：
   ```bash
   sqlite3 server/topstar.db "SELECT id, status, analysis_type, created_at, completed_at FROM analysis_jobs ORDER BY created_at DESC LIMIT 5"
   ```
