# Phase 2-A / Phase 2-B 架构设计评审建议

## 评审结论

Phase 2-A 和 Phase 2-B 的整体方向是正确的。

Phase 2-A 解决的是“视频分析从前端 mock 变成真实异步任务”的产品真实性问题；Phase 2-B 解决的是“意图识别过粗，导致编排、prompt、教程推荐、前端渲染一起跑偏”的系统架构问题。

建议继续推进，但在实施前补强任务可靠性、模型调用契约、schema 版本、前后端渲染协议和新旧 intent 兼容策略。

---

## 一、Phase 2-A：视频分析任务化建议

### 1. `analysis_jobs` 表建议补强任务治理字段

当前表结构可以支持 MVP，但对恢复、重试、幂等和多实例部署支持偏弱。

建议增加：

```sql
attempt_count INTEGER DEFAULT 0,
locked_at TEXT,
locked_by TEXT,
heartbeat_at TEXT,
next_run_at TEXT,
model TEXT,
report_schema_version TEXT,
mime_type TEXT,
gemini_file_name TEXT
```

理由：

- `attempt_count`：支持失败重试和最大重试次数。
- `locked_at / locked_by`：避免多 worker 或多实例重复处理同一 job。
- `heartbeat_at`：识别 worker 崩溃或卡死任务。
- `next_run_at`：支持 retry backoff。
- `model`：记录实际使用模型，方便问题追踪和效果对比。
- `report_schema_version`：前端报告结构未来演进时可兼容。
- `mime_type`：避免上传文件类型和 Gemini Files API 参数不一致。
- `gemini_file_name`：便于异常中断后的远端文件清理。

### 2. 上传文件不要统一保存成 `.mp4`

设计文档允许 `video/mp4`、`video/quicktime`、`video/webm`，但 implementation plan 示例中保存为：

```text
server/uploads/{job_id}.mp4
```

建议改为按真实 MIME / 扩展名保存：

```text
server/uploads/{job_id}.mp4
server/uploads/{job_id}.mov
server/uploads/{job_id}.webm
```

并在 DB 中记录真实 `mime_type`。

Gemini 上传时也应使用真实 MIME，而不是固定：

```ts
mimeType: 'video/mp4'
```

### 3. Worker MVP 可以放在 web server 内，但需明确部署边界

当前 `node-cron + SQLite polling worker` 适合单实例 MVP。

但如果未来部署到多实例、容器扩缩容或 serverless 环境，只靠进程内 `isRunning` 不够，需要 DB 层 job lock。

建议：

- 增加环境变量 `ANALYSIS_WORKER_ENABLED=true`
- 单独指定一个实例运行 worker
- 或使用 DB 原子更新抢占任务，例如 `queued -> running` 时带条件更新
- 长期可迁移到 BullMQ / Redis Queue / 云任务队列

### 4. Two-Pass Pipeline 方向正确，但 Pass 1 输出必须强校验

Two-Pass 的设计是合理的：

- Pass 1 识别有效乒乓球片段
- Pass 2 聚焦分析有效片段
- 复用同一个 Gemini File
- 不依赖 ffmpeg

但 Pass 1 的结果不能直接信任，建议做校验：

- 时间戳格式必须合法
- `start < end`
- 片段不能超过视频时长
- 过短片段过滤，例如小于 1 秒
- 相邻片段可合并
- 总有效时长为 0 时返回友好失败
- segments 数量过多时限制上限，避免 Pass 2 prompt 过长

### 5. 报告结构建议统一成 `reports[]`

当前设计中：

- `technique` 返回一个 report object
- `match_strategy` 返回 report array

建议统一为：

```ts
type AnalysisReportPayload = {
  analysis_type: 'technique' | 'match_strategy';
  reports: AnalysisReport[];
  valid_segments?: Array<{ start: string; end: string; description?: string }>;
  schema_version: 'v1';
};
```

这样前端永远消费 `reports[]`，只是不同类型展示标题和样式不同。

好处：

- 前端逻辑更简单
- TTS / 分享 / 历史记录复用更容易
- 后续扩展双打、多人训练、发球专项更自然

### 6. JSON 输出建议使用结构化输出能力

当前方案主要依赖 prompt 要求“只输出 JSON”，再用正则提取。

建议优先使用 Gemini API 支持的结构化输出能力，例如 `responseMimeType` / response schema 等方式；正则提取只作为兜底。

原因：

- 多模态分析结果比普通文本更容易出现解释性文字
- 报告 schema 需要稳定给前端消费
- 可以减少“解析失败但其实内容可用”的情况

### 7. 模型名建议更新为 `gemini-3.1-pro-preview`

根据最新官方文档确认，视频分析默认模型建议使用：

```ts
const model = process.env.GEMINI_VIDEO_MODEL || 'gemini-3.1-pro-preview';
```

同时建议在文档中注明：

- 模型名以官方 Gemini API 文档和账号实际可用列表为准
- 默认值必须可通过 `GEMINI_VIDEO_MODEL` 覆盖
- job 表中记录实际使用的 `model`

### 8. 前端轮询建议保留 `job_id`

前端上传视频后，应把 `job_id` 挂到当前消息或本地状态上。

否则用户刷新页面、切换页面或网络中断时，后端 job 还在跑，但前端无法恢复关联。

MVP 可以不做完整恢复，但建议至少：

- AI processing message 中保存 `job_id`
- job 查询接口可被重新调用
- 未来支持“恢复最近未完成分析”

### 9. 失败状态建议区分错误类型

当前 `failed + error` 能跑 MVP，但建议 error 更结构化：

```ts
{
  code: 'NO_VALID_SEGMENTS' | 'GEMINI_UPLOAD_FAILED' | 'GEMINI_PROCESSING_FAILED' | 'REPORT_PARSE_FAILED' | 'TIMEOUT',
  message: string,
  retryable: boolean
}
```

这样前端可以更友好地提示：

- 不是乒乓球视频
- 视频过长
- 模型服务暂不可用
- 解析失败可重试
- 上传失败可重新上传

---

## 二、Phase 2-B：意图识别层重构建议

### 1. `domain_intent / task_intent / response_mode / entities` 抽象是正确的

当前系统的问题不是 intent 枚举不够多，而是把多个职责混在一个字段里：

- 知识域
- 用户任务
- 输出形态
- 前端渲染方式
- 是否推荐教程

Phase 2-B 将其拆开是正确方向。

建议保留这个核心设计：

```ts
{
  domain_intent,
  task_intent,
  response_mode,
  entities,
  confidence,
  source,
  reason
}
```

其中 `response_mode` 是最关键字段，应该成为前端渲染和编排输出形态的主要依据。

### 2. 新旧 intent 兼容期建议引入 adapter

不要让旧 `intent` 和新 `decision` 同时成为真相。

建议增加 adapter：

```ts
function decisionToLegacyIntent(decision: IntentDecision): IntentType;

function legacyIntentToDecision(result: IntentResult): IntentDecision;
```

兼容期策略：

- 内部编排优先使用 `decision`
- 旧 `intent` 由 `decision` 派生
- 前端字段同时返回，但新字段为主
- 避免出现 `intent = ACTION_COACHING` 但 `response_mode = RESOURCE_ONLY` 后链路各看各的情况

### 3. `response_mode` 最终值应由 Policy 层兜底确定

LLM 可以初判，但最终输出模式不应完全依赖 LLM。

典型硬规则：

- 命中“只要视频 / 不用讲解 / 直接发链接”：
  - 强制 `RESOURCE_ONLY`
- `task_intent = TUTORIAL` 且 `needs_explanation = false`：
  - 禁止走动作讲解模板
- 低置信度且无强规则：
  - 使用 `TEXT_ONLY`
  - 不默认回 `ACTION_COACHING`
- `task_intent = COMPARE`：
  - 可设置 `COMPARISON_CARD`，但前端未支持时必须 fallback

Policy 层应该是业务规则的确定性控制点，而不是完全藏在 prompt 里。

### 4. `RESOURCE_ONLY` 场景建议短路 LLM 生成

对于“反手拧拉的视频教程”“直接发几个链接，不用讲”这类请求，最稳的做法不是换一个极简 prompt，而是直接模板化输出 + 教程列表。

建议：

- 仍然做 action/entity 识别
- 仍然调用 `recommendTutorials()`
- 但不调用大模型生成动作讲解
- 返回很短的系统文案和教程列表

这样可以彻底避免 LLM 又输出动作要领、训练建议。

### 5. `templateValidator` 必须支持 `response_mode`

当前模板校验器会给 `ACTION_COACHING` 强制补：

- 【动作要领】
- 【常见问题】
- 【训练建议】

如果 `response_mode = RESOURCE_ONLY`，必须跳过模板校验，否则 Phase 2-B 的目标会被后处理层抵消。

建议签名改为：

```ts
validateTemplate(text, intent, responseMode?)
```

规则：

- `RESOURCE_ONLY`：跳过校验
- `TEXT_ONLY`：按轻模板校验
- `TEXT_WITH_RESOURCES`：允许简讲 + 教程
- `REPORT_CARD`：不走普通文本模板校验

### 6. 前端建议新增 `TutorialListCard`

不建议复用 report 卡片再隐藏 summary。

`RESOURCE_ONLY` 是独立交付形态，不是“缺字段的报告”。

建议新增：

```ts
type MessagePart =
  | { type: 'text'; ... }
  | { type: 'report'; ... }
  | { type: 'tutorial-list'; tutorialVideos: RecommendedTutorial[] }
```

好处：

- UI 语义清楚
- 避免教程请求误渲染成报告卡
- 方便后续统计教程曝光和点击
- 和 `response_mode` 一一对应

### 7. eval 集建议拆成确定性测试和 LLM 离线评估

Phase 2-B 的 eval 很必要，但不建议把 live LLM 结果作为 CI 的唯一判断。

建议拆两类：

#### 确定性单测

覆盖：

- 规则命中
- policy 修正
- adapter 转换
- fallback 策略

这些应该可以稳定进 CI。

#### LLM 离线评估

覆盖：

- 教程只要资源
- 教程 + 简讲
- 动作解释
- 动作诊断
- 器材 QA
- 器材对比
- 器材推荐
- 模糊输入

这部分可通过脚本运行，输出 diff 和准确率，不一定阻塞 CI。

### 8. Step 1-2 范围控制是对的

建议 Phase 2-B 第一阶段只落地：

- schema 扩展
- policy 层
- 教程请求 `RESOURCE_ONLY / TEXT_WITH_RESOURCES`
- 前端 tutorial list 渲染
- fallback 不再默认 `ACTION_COACHING`

暂时不要承诺完整落地：

- `COMPARISON_CARD`
- 器材推荐卡
- 训练计划卡
- 多轮澄清状态机

枚举可以先定义，但 policy 不应返回前端尚未支持的模式，除非有明确 fallback。

---

## 三、Phase 2-A 与 Phase 2-B 的关系建议

A 和 B 不应完全独立设计。

建议最终形成统一协议：

### 视频上传入口

用户选择视频后：

```text
POST /api/v2/analysis/jobs
```

后端创建 job，worker 真实分析，前端轮询，最终渲染 `REPORT_CARD`。

### 文本视频分析请求

用户说“帮我分析一下视频”但没有上传文件：

```ts
domain_intent = VIDEO_ANALYSIS
task_intent = DIAGNOSE
response_mode = QUESTION_BACK
```

前端提示用户上传视频。

### 教程请求

用户说“反手拧拉的视频教程”：

```ts
domain_intent = ACTION
task_intent = TUTORIAL
response_mode = RESOURCE_ONLY
```

前端渲染 `TutorialListCard`。

### 视频 + 教程联动

A 的报告如果识别出：

```ts
action_ids_detected = ['bh_flick']
```

可以复用 B/现有教程推荐链路，把相关教程注入报告：

```ts
report.videoLinks = recommendTutorials(...)
```

---

## 四、建议实施顺序

建议按以下顺序推进，风险最低：

### Step 1：先做 Phase 2-B 基础协议

- 新增 `IntentDecision`
- 增加 adapter
- 增加 policy
- 修改 fallback
- 增加 eval set
- 暂不大改前端 UI

目标：让后端有稳定的新请求理解协议。

### Step 2：做 Phase 2-A 任务系统和真实视频分析

- 新增 `analysis_jobs`
- 新增上传接口
- 新增 worker
- 接 Gemini Files API
- 替换前端 mock `setTimeout`
- 渲染真实报告

目标：把核心产品能力做真。

### Step 3：切教程请求到新协议

- `RESOURCE_ONLY`
- `TEXT_WITH_RESOURCES`
- 新增 `TutorialListCard`
- `templateValidator` 支持 `response_mode`

目标：解决“只要视频却输出长篇动作讲解”的高频问题。

### Step 4：再扩展器材和动作复杂场景

- 器材对比
- 器材推荐
- 动作诊断
- 训练计划
- 澄清式问答

目标：逐步释放新协议能力，而不是一次性大爆炸。

---

## 五、关键风险清单

### Phase 2-A 风险

- 多实例 worker 重复消费 job
- 文件扩展名和 MIME 不一致
- Gemini 模型输出 JSON 不稳定
- Pass 1 时间戳不准确
- 长视频成本和延迟不可控
- 前端刷新后丢失 job 状态
- 本地磁盘上传目录不适合 serverless / 临时容器环境
- Gemini 文件异常未清理

### Phase 2-B 风险

- 新旧 intent 并存导致编排分裂
- `response_mode` 被 LLM 漂移影响
- policy 太弱，无法压住关键业务规则
- `templateValidator` 把 `RESOURCE_ONLY` 又补成动作讲解
- 前端继续用 `tutorialVideos.length` 猜渲染形态
- 过早返回前端尚未支持的卡片模式
- live LLM eval 导致测试不稳定

---

## 六、最终建议

Phase 2-A 可以推进，但建议先补：

- job lock / retry / heartbeat 字段
- 真实 MIME 和扩展名处理
- report schema version
- 统一 `reports[]`
- 结构化 JSON 输出
- `gemini-3.1-pro-preview` 默认模型配置
- job_id 前端保留和恢复预留

Phase 2-B 可以推进，但建议坚持：

- `decision` 作为单一真相
- 旧 intent 由 adapter 派生
- policy-first 决定 `response_mode`
- `RESOURCE_ONLY` 尽量短路 LLM
- `templateValidator` 尊重 `response_mode`
- 前端新增 `TutorialListCard`
- eval 拆成确定性测试和 LLM 离线评估

总体来看，A 是把产品核心能力做真，B 是把系统编排协议做稳。建议两者都做，但按“小步迁移、协议先行、任务可靠性优先”的方式推进。
