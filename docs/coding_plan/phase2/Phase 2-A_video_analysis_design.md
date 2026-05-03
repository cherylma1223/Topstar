# Phase 2-A 设计文档：视频分析任务化

> 目标：消灭前端 `setTimeout` 假报告，建立持久化的异步任务处理系统，接入 Gemini Files API 实现真正的视频帧分析，让用户上传视频后能获得基于视频内容的结构化诊断报告。

---

## 1. 背景

Phase 1 已经完成了知识库 + 教程推荐 + 意图路由的基础链路。但"视频分析"这条核心功能仍然是完全 mock 的：

- 前端 `ChatScreen.tsx` 中的 `handleFileUpload` 用 `setTimeout(3500ms)` 模拟分析延迟
- 报告内容是前端硬编码的静态数据（"重心交换不足"、"引拍时手再放低一点"等）
- 没有任何后端处理逻辑——视频文件选择后根本没上传到服务器
- "技术动作分析"和"AI 场外指导"两个入口本质上走同一套 mock 逻辑

这意味着产品的核心卖点——"上传视频，AI 帮你诊断"——目前是完全假的。

Phase 2-A 要把这条链路从假的变成真的。

---

## 2. 当前架构问题

### 2.1 没有任务系统

当前视频分析没有任何后端概念。用户"上传"视频后，前端自己倒计时 3.5 秒，然后渲染一个写死的报告。没有 job 表、没有状态机、没有 worker。

### 2.2 视频文件不经过服务端

`ChatScreen.tsx` 中的 `<input type="file">` 选择视频后，文件对象被忽略——只用来触发一个假的 `setTimeout` 流程。视频内容从未被读取或传输。

### 2.3 报告内容与用户输入无关

无论用户上传什么视频，返回的报告都是同一份硬编码内容。这在演示阶段可以接受，但作为产品完全不可用。

### 2.4 无法容错

`setTimeout` 在以下场景中会直接失效：
- 用户切换页面
- 应用崩溃或刷新
- 网络中断

任务一旦"丢失"，没有任何恢复机制。

---

## 3. Phase 2-A 目标

1. **持久化任务系统**：用户提交视频 → 创建 `analysis_jobs` 记录 → 异步处理 → 前端轮询结果
2. **真实视频分析**：通过 Gemini Files API 上传视频，调用多模态模型进行帧分析，生成基于视频内容的结构化报告
3. **可靠性保障**：服务重启后未完成的 job 自动恢复；处理超时自动标记失败
4. **保持现有交互**：前端的视频上传界面（"选择视频"/"拍摄视频"按钮）和两个入口（技术动作分析/AI场外指导）保持不变

---

## 4. 目标架构

### 4.1 端到端流程

```
用户点击"选择视频/拍摄视频"
  ↓
前端上传视频文件到服务端
  ↓
POST /api/v2/analysis/jobs → 创建 job, 保存视频文件, 返回 job_id
  ↓
AnalysisWorker 轮询 → 捞取 queued job
  ↓
上传视频到 Gemini Files API → 等待处理完毕
  ↓
调用 Gemini 多模态模型 → 分析视频帧 → 生成结构化 JSON 报告
  ↓
关联教程推荐 → 更新 job status = done
  ↓
前端 GET /api/v2/analysis/jobs/{id} 轮询 → 获取报告 → 渲染 AnalysisReportCard
```

### 4.2 `analysis_jobs` 表结构

```sql
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id                    TEXT PRIMARY KEY,
  status                TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
  analysis_type         TEXT NOT NULL DEFAULT 'technique', -- technique | match_strategy
  video_path            TEXT,                            -- 服务端存储路径
  video_filename        TEXT,                            -- 原始文件名
  video_size            INTEGER,                         -- 文件大小 (bytes)
  video_duration        INTEGER,                         -- 视频时长 (秒), 可选
  mime_type             TEXT,                            -- 真实 MIME 类型 (video/mp4, video/quicktime, video/webm)
  report                TEXT,                            -- JSON 格式的分析报告 (AnalysisReportPayload)
  report_schema_version TEXT DEFAULT 'v1',               -- 报告结构版本, 前端兼容用
  error                 TEXT,                            -- 失败原因 (error code)
  model                 TEXT,                            -- 实际使用的 Gemini 模型名
  gemini_file_name      TEXT,                            -- Gemini Files API 文件名, 用于异常清理
  attempt_count         INTEGER DEFAULT 0,               -- 处理尝试次数, 支持重试
  created_at            TEXT NOT NULL,
  started_at            TEXT,                            -- worker 开始处理的时间
  completed_at          TEXT
);
```

**字段说明**：
- `analysis_type`：区分"技术动作分析"和"AI 场外指导"两种入口，影响 Gemini prompt 和报告结构
- `report`：存储 `AnalysisReportPayload` 的 JSON 字符串（统一 `reports[]` 结构，见 5.3.5）
- `video_path`：视频文件在服务端的存储路径，供 Gemini Files API 上传使用
- `mime_type`：记录上传文件的真实 MIME 类型，Gemini Files API 上传时使用此值而非硬编码
- `report_schema_version`：报告结构版本号，前端可据此做兼容渲染
- `model`：记录实际使用的模型名（如 `gemini-3.1-pro-preview`），便于问题追踪和效果对比
- `gemini_file_name`：Gemini Files API 返回的文件标识，异常中断后可据此清理远端文件
- `attempt_count`：处理尝试次数，支持失败重试和最大重试次数判断

### 4.3 任务状态机

```
          创建
           ↓
        [queued]
           ↓ worker 捞取
        [running]
          ↙     ↘
      成功        失败/超时
       ↓            ↓
     [done]     [failed]
```

状态流转规则：
- `queued → running`：worker 捞取 job 时更新
- `running → done`：报告生成成功
- `running → failed`：处理出错或超时
- 服务重启时：所有 `running` 状态重置为 `queued`（恢复机制）

---

## 5. 核心模块设计

### 5.1 视频上传与 Job 创建

视频上传通过 `multipart/form-data` 提交到后端。后端：

1. 验证文件类型（仅接受 `video/mp4`, `video/quicktime`, `video/webm`）
2. 验证文件大小（MVP 限制 ≤ 100MB）
3. 保存到本地磁盘 `server/uploads/{job_id}.{ext}`（按真实扩展名：`.mp4` / `.mov` / `.webm`）
4. 创建 `analysis_jobs` 记录，写入真实 `mime_type`
5. 返回 `{ job_id, status: 'queued' }`

```typescript
// POST /api/v2/analysis/jobs
// Content-Type: multipart/form-data
// Fields: video (file), analysis_type ('technique' | 'match_strategy')
```

### 5.2 AnalysisWorker

基于 `node-cron` 的 SQLite Polling Worker（参考 Codex v6 §20.2）：

- 通过环境变量 `ANALYSIS_WORKER_ENABLED`（默认 `true`）控制是否启动 worker
- 每 10 秒扫描一次 `status='queued'` 的 job
- MVP 串行处理（`MAX_CONCURRENT_JOBS = 1`），避免资源争抢
- 使用 `isRunning` 标志防止并发触发
- 处理超时保护：单个 job 最长 10 分钟（Gemini 视频处理最慢约 5 分钟）
- 处理前递增 `attempt_count`，记录 `model` 和 `gemini_file_name`

```typescript
export function startAnalysisWorker() {
  if (process.env.ANALYSIS_WORKER_ENABLED === 'false') {
    console.log('[AnalysisWorker] Disabled by ANALYSIS_WORKER_ENABLED=false');
    return;
  }
  cron.schedule('*/10 * * * * *', pollAndProcess);
}
```

### 5.3 Job Processor（Two-Pass Pipeline）

这是 Phase 2-A 的核心——真正分析视频内容。

#### 5.3.1 为什么需要 Two-Pass？

乒乓球视频中存在大量"死时间"——捡球、等待发球、失误后停顿、换边休息等。这些片段可能占总时长的 40-60%。如果直接把完整视频丢给模型分析：

- 模型的注意力被无效帧稀释，关键动作的诊断精度下降
- 返回的 `timestamp` 可能指向捡球等无关画面
- 浪费 token（视频 token 按秒计费）

因此，我们采用 **Two-Pass Pipeline**：先识别有效片段，再聚焦分析。

两次 Gemini 调用均使用**结构化输出**（`responseMimeType: 'application/json'` + `responseSchema`），确保输出为合法 JSON，减少解析失败风险。正则提取仅作为兆底。

#### 5.3.2 处理流程

```
                    视频上传到 Gemini Files API
                              ↓
                    等待处理完毕 (PROCESSING → ACTIVE)
                              ↓
              ┌───────────────────────────────────┐
              │  Pass 1：有效片段识别              │
              │  "这段视频中哪些时间段是有效回合？"  │
              │  输出：[{start, end, desc}, ...]   │
              └───────────────────────────────────┘
                              ↓
                   有效片段时间戳列表
                              ↓
              ┌───────────────────────────────────┐
              │  Pass 2：聚焦技术/战术分析         │
              │  "请只分析以下时间段的内容：       │
              │   00:05-00:12, 00:18-00:25, ..."  │
              │  输出：结构化诊断报告 JSON          │
              └───────────────────────────────────┘
                              ↓
                    关联教程推荐 → 存储报告
                              ↓
                    清理 Gemini Files API 文件
```

**关键优势**：两次调用复用同一个已上传的视频文件（Gemini Files API 上传一次，可多次引用），不需要物理裁剪视频，不依赖 ffmpeg。

#### 5.3.3 Pass 1：有效片段识别

**目标**：让模型观看完整视频，识别出所有有效的乒乓球回合/练习片段的时间范围。

**输出结构**：

```json
{
  "segments": [
    { "start": "00:05", "end": "00:12", "description": "正手拉球练习" },
    { "start": "00:18", "end": "00:25", "description": "反手推挡对练" },
    { "start": "00:32", "end": "00:45", "description": "发球抢攻回合" }
  ],
  "total_valid_seconds": 27,
  "filtered_out": ["00:00-00:05 准备阶段", "00:12-00:18 捡球", "00:25-00:32 休息"]
}
```

**Pass 1 Prompt**：

```
你是一名专业乒乓球视频分析助手。请观看这段视频，识别出所有包含有效乒乓球动作的时间段。

有效片段包括：正式回合、练习击球、发球练习、多球训练等包含实际击球动作的片段。
需要过滤掉的无效片段：捡球、等待、休息、聊天、走动、调整器材、失误后的停顿等。

请严格按以下 JSON 格式输出（只输出 JSON，不要其他文字）：
{
  "segments": [
    { "start": "mm:ss", "end": "mm:ss", "description": "片段内容简述" }
  ],
  "total_valid_seconds": 数字
}
```

**Pass 1 输出校验（`validateSegments()`）**：

LLM 输出的时间戳不能直接信任，Pass 1 结果在传递给 Pass 2 之前必须经过以下校验和清洗：

| 校验项 | 规则 |
|--------|------|
| 时间戳格式 | 必须为合法的 `mm:ss` 或 `hh:mm:ss` 格式 |
| 时间顺序 | `start < end`，否则丢弃该片段 |
| 不超过视频时长 | `end <= video_duration`，否则截断至视频时长 |
| 过短片段过滤 | 片段时长 < 1 秒的丢弃 |
| 数量上限 | segments 数量 <= 20，超出时按时长降序取前 20 段 |
| 总有效时长为 0 | 返回 `NO_VALID_SEGMENTS` 错误 |

**降级处理**：如果 Pass 1 返回的 `segments` 校验后为空（模型未识别到有效片段），job 标记为 `failed`，error code 为 `NO_VALID_SEGMENTS`，前端提示"未识别到有效的乒乓球动作片段，请上传包含击球练习或比赛回合的视频"。

#### 5.3.4 Pass 2：聚焦分析

**目标**：基于 Pass 1 识别出的有效片段时间戳，让模型只聚焦分析这些片段的技术动作或战术特点。

Pass 2 的 prompt 会将 Pass 1 的时间戳列表注入，引导模型精确定位：

- `technique`（技术动作分析）：

```
你是一名专业乒乓球教练。请分析这段视频中以下时间段的技术动作：
- 00:05-00:12：正手拉球练习
- 00:18-00:25：反手推挡对练
- 00:32-00:45：发球抢攻回合

请忽略上述时间段以外的画面（捡球、休息等无关内容）。
对有效片段中的技术动作进行诊断，指出问题并给出改进建议。

请严格按以下 JSON 格式输出（只输出 JSON，不要其他文字）：
{
  "techName": "xxx技术诊断报告",
  "problems": [{ "text": "问题描述", "timestamp": "mm:ss" }],
  "improvements": ["改进建议1", "改进建议2"],
  "action_ids_detected": ["bh_flick"],
  "valid_segments": [{ "start": "00:05", "end": "00:12" }, ...]
}
```

- `match_strategy`（AI 场外指导）：

```
你是一名专业乒乓球战术分析师。请分析这段比赛视频中以下有效回合时间段：
- 00:05-00:12：第一回合
- 00:18-00:30：第二回合
- ...

请忽略回合之间的间歇画面。
为每位球员（标记为球员A和球员B）分别分析技战术特点。

请严格按以下 JSON 格式输出（只输出 JSON，不要其他文字）：
[
  {
    "techName": "球员 A",
    "problems": [{ "text": "技术特点描述", "timestamp": "mm:ss" }],
    "improvements": ["战术指导建议"]
  },
  {
    "techName": "球员 B",
    ...
  }
]
```

#### 5.3.5 统一报告封装（`AnalysisReportPayload`）

Pass 2 的原始输出（`technique` 为单个 report，`match_strategy` 为 report 数组）在存储前统一封装为以下结构：

```typescript
type AnalysisReportPayload = {
  analysis_type: 'technique' | 'match_strategy';
  reports: AnalysisReport[];  // technique 时 length=1，match_strategy 时 length=2
  valid_segments?: Array<{ start: string; end: string; description?: string }>;
  schema_version: 'v1';
};
```

前端始终消费 `reports[]` 数组，不同 `analysis_type` 只影响展示标题和样式。

#### 5.3.6 教程关联

Pass 2 报告生成后，用 `action_ids_detected` 调用现有的 `recommendTutorials()` 关联真实教程链接，注入到每个 report 的 `videoLinks`。

#### 5.3.7 错误码常量

失败状态使用结构化 error code，存入 `analysis_jobs.error` 字段：

```typescript
const ERROR_CODES = {
  NO_VALID_SEGMENTS: '未识别到有效的乒乓球动作片段',
  GEMINI_UPLOAD_FAILED: '视频上传失败',
  GEMINI_PROCESSING_FAILED: '视频处理失败',
  REPORT_PARSE_FAILED: '报告解析失败',
  TIMEOUT: '分析超时',
} as const;
```

前端根据 error code 做友好提示映射。

### 5.4 前端轮询与渲染

前端在视频上传后进入轮询状态，替代当前的 `setTimeout` mock：

**job_id 保留**：上传成功后，`job_id` 应保存到当前 AI processing message 的 data 中（而非仅存在于函数闭包），确保页面刷新后仍可恢复轮询。MVP 阶段至少做到：
- AI processing message 中保存 `job_id`
- job 查询接口可被重新调用
- 未来可支持"恢复最近未完成分析"

**轮询策略**（参考 Codex v6 §18.4）：
- 前 30 秒：每 3 秒轮询一次
- 30 秒后：每 10 秒轮询一次
- 超过 10 分钟：标记超时，提示用户

**轮询接口**：
```
GET /api/v2/analysis/jobs/{job_id}
→ { status: 'queued' | 'running' | 'done' | 'failed', report?: AnalysisReportPayload, error?: string }
```

**渲染逻辑**：
- `queued`/`running`：显示 `ProcessingCard`，更新文案为"正在分析您的视频动作，请耐心等待..."
- `done`：从 `report.reports[]` 渲染 `AnalysisReportCard`（复用现有组件）
- `failed`：根据 error code 显示对应的友好提示（如 `NO_VALID_SEGMENTS` → "未识别到有效动作片段"）

---

## 6. 成本与限制

| 项目 | 参数 |
|------|------|
| 模型选择 | 通过环境变量 `GEMINI_VIDEO_MODEL` 配置，默认 `gemini-3.1-pro-preview` |
| 每次分析 API 调用次数 | 2 次（Pass 1 片段识别 + Pass 2 聚焦分析），复用同一上传文件 |
| 最大视频时长 | 前后端校验 ≤ 120 秒（2 分钟），控制成本和等待时间 |
| 最大文件大小 | ≤ 100MB |
| 处理延迟 | 上传 + Gemini 处理 + 两次模型推理 约 1-5 分钟 |
| Files API 文件有效期 | 7 天，处理完毕后主动删除 |

---

## 7. 降级策略

### 7.1 Gemini Files API 不可用

如果 Files API 上传或处理失败：
- 将 job 标记为 `failed`
- 前端显示"视频分析服务暂时不可用，请稍后再试"
- 记录错误日志供排查

### 7.2 模型返回非 JSON

如果多模态模型输出不是合法 JSON（使用 `responseMimeType: 'application/json'` 后概率大幅降低）：
- 尝试正则提取 `{...}` 块
- 如果仍失败，将 job 标记为 `failed`，error code 为 `REPORT_PARSE_FAILED`
- 前端提示"分析结果解析失败，请重试"

### 7.3 视频内容非乒乓球

模型可能判断视频内容与乒乓球无关：
- 在 prompt 中加入指令：如果视频内容不是乒乓球相关，返回特定标记
- 前端展示友好提示

---

## 8. 迁移策略

Phase 2-A 的改造分两条线并行：

### 后端线（无破坏性）

1. 新增 `analysis_jobs` 表（不影响现有 `tutorial_videos` 等表）
2. 新增 `server/jobs/analysisWorker.ts` 和 `server/orchestrator/handleAnalysisJob.ts`
3. 新增 API 路由（`POST /api/v2/analysis/jobs` 和 `GET /api/v2/analysis/jobs/:id`）
4. 在 `server/index.ts` 启动时注册 worker

### 前端线（替换 mock）

1. `ChatScreen.tsx` 的 `handleFileUpload` 从 `setTimeout` 改为：上传文件 → 创建 job → 轮询
2. `ProcessingCard.tsx` 的文案和进度逻辑更新
3. 其他组件（HomeScreen、App.tsx）的入口交互保持不变

---

## 9. 验收标准

1. ✅ 用户通过"选择视频/拍摄视频"上传视频后，视频文件被真实上传到服务端
2. ✅ 后端创建 `analysis_jobs` 记录，状态从 `queued → running → done` 流转
3. ✅ 报告内容是基于上传视频的真实分析结果（不是硬编码内容）
4. ✅ 报告中的 `problems[].timestamp` 指向视频中的实际时间点
5. ✅ 任务失败时 `status = 'failed'`，前端展示错误提示
6. ✅ 服务重启后，未完成的 job 自动恢复处理
7. ✅ 不再有任何 `setTimeout` 驱动的 mock 报告
8. ✅ "技术动作分析"和"AI 场外指导"两个入口分别生成对应类型的报告

---

## 10. 非目标

Phase 2-A 暂不追求：

- 视频预压缩 / 转码优化（Stage C，长期优化）
- 用户级 quota/限流（待商业化阶段引入）
- 教程点击/曝光埋点（独立任务）
- 链接失效上报（独立任务）
- `usage_events` 表和 token 消耗记录
- 前端交互入口改版（保持现有 UI）
