# Phase 1 实施计划：核心大脑与真实教程落地

> 基于设计文档 `Topstar_Product_Technical_Design_codex_v4.md` 与开发计划 `Topstar_Final_TODO_v1.1.md`
> 技术决策：TypeScript / SQLite WAL / 线性扫描 / 规则+LLM意图路由 / 模块化+模板校验 / eval set 延后

---

## 背景

当前服务端为单文件 `server/index.js`（282 行，纯 JS），只有 v1 API 和关键词检索。教程推荐完全缺失，模型会自由编造链接。Phase 1 目标：**建立结构化输出协议，实现来自真实数据的教程推荐，彻底消除模型编造链接**。

---

## 兼容性风险与迁移策略

> [!IMPORTANT]
> Phase 1 完成后，Topstar **可以正常运行**，但以下三个风险需要在编码时主动规避。

### 风险 1：响应字段名变化（最高风险）

| 接口 | 旧字段 | 新字段 |
|------|--------|--------|
| `/api/v1/ai/chat` | `{ content }` | **保持不变**，v1 路由不动 |
| `/api/v2/chat` | — | `{ answerText, tutorialVideos, ... }` |

前端 `ChatScreen.tsx` 等组件目前读 `response.content`。切换到 v2 时，必须同步将读取字段改为 `response.answerText`，否则聊天界面显示空白。

**应对**：Step 7（前端适配）中同步修改所有读取聊天响应字段的地方。

### 风险 2：意图路由增加响应延迟

v2 流程比 v1 多了一次 LLM 轻量调用（意图分类），会增加约 **0.5~2 秒**响应延迟。属于功能正常但体验有感知影响，可在 intent router 加计时日志，后续评估是否需要缓存/合并调用优化。

### 风险 3：TypeScript 迁移引入 bug

Step 0（TS 迁移）是整体重构，若类型不匹配导致运行时异常，会影响现有功能。

**应对**：TS 迁移完成后立即运行一次全量手动测试（TTS、图片生成、v1 聊天），确认一切正常再引入新模块。

---

### 安全迁移策略：前端适配放最后

> [!TIP]
> **Step 7（前端适配）必须在 Step 1–6 全部完成且 v2 接口验证通过后，最后一个做。**
>
> 这样在 v2 后端就绪之前，前端仍然通过 v1 接口正常运行，产品不中断。万一 v2 有问题，只需回滚 Step 7 的前端改动，v1 立即恢复。

---

## 技术决策备忘

| 决策项 | 结论 |
|--------|------|
| 语言 | TypeScript（服务端全面迁移） |
| 教程数据持久化 | SQLite（WAL + busy_timeout），用 `better-sqlite3` |
| 教程检索策略 | 线性扫描召回 + `scoreCandidate()` 排序，不建倒排索引 |
| 意图路由 | 规则层优先命中 + LLM 结构化分类兜底（两层都做） |
| 知识库模块化 | 拆目录结构 + 服务端输出模板校验，不改检索算法 |
| eval set | Phase 1 跳过，后期补充 |

---

## 目标目录结构（Phase 1 完成后）

```
server/
├── index.ts                    # [MODIFY] 入口，挂载所有路由 + 启动 cron
├── db.ts                       # [NEW] SQLite 初始化 + schema 定义
├── knowledge/
│   ├── loader.ts               # [NEW] 知识库加载（从现有 index.js 提取）
│   ├── matcher.ts              # [NEW] matchKnowledge() 关键词检索
│   ├── actions.ts              # [NEW] 动作域知识服务
│   ├── tactics.ts              # [NEW] 战术域知识服务
│   └── equipment.ts            # [NEW] 器材域知识服务
├── tutorials/
│   ├── loader.ts               # [NEW] 从 SQLite 加载教程库到内存
│   ├── scoreCandidate.ts       # [NEW] 候选评分函数
│   └── recommendTutorials.ts   # [NEW] 推荐主函数
├── intent/
│   └── intentRouter.ts         # [NEW] 意图路由（规则 + LLM 兜底）
├── orchestrator/
│   ├── handleChatEvent.ts      # [NEW] 编排层：意图→检索→LLM→模板校验→输出
│   └── templateValidator.ts    # [NEW] 输出模板校验
├── routes/
│   ├── v1.ts                   # [NEW] 原 v1 路由迁移
│   └── v2.ts                   # [NEW] v2 路由（chat, tutorials）
├── jobs/
│   └── linkHealthCheck.ts      # [NEW] 链接可用性定期探测
└── scripts/
    └── bootstrapQualityScores.ts # [NEW] 冷启动评分（一次性）
```

---

## Step 0：TypeScript 迁移（基础设施）

### [MODIFY] `server/package.json`

新增依赖：
- `typescript`, `tsx`（运行时，替代 `ts-node`，更快）
- `better-sqlite3`, `@types/better-sqlite3`
- `node-cron`, `@types/node-cron`
- `@types/node`, `@types/express`, `@types/cors`, `@types/morgan`

修改 `scripts`：
```json
{
  "scripts": {
    "dev": "tsx watch index.ts",
    "start": "tsx index.ts",
    "build": "tsc --noEmit"
  }
}
```

### [NEW] `server/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "."
  }
}
```

---

## Step 1：数据库初始化

### [NEW] `server/db.ts`

职责：
- 用 `better-sqlite3` 打开/创建 `topstar.db`
- 执行 WAL 模式设置（`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;`）
- 创建 `tutorial_videos` 表（如不存在）
- 导出 `db` 单例

**`tutorial_videos` 表字段**（来自设计文档 §4.4 + §17.3 + §19.4）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tutorial_id` | TEXT PRIMARY KEY | `platform:platform_item_id` |
| `platform` | TEXT | `bilibili` / `douyin` |
| `platform_item_id` | TEXT | |
| `title` | TEXT | |
| `url` | TEXT | |
| `author` | TEXT | 可空 |
| `source_folder_titles` | TEXT | JSON 字符串（数组） |
| `tags` | TEXT | JSON 字符串（数组） |
| `related_action_ids` | TEXT | JSON 字符串（数组） |
| `related_tactic_ids` | TEXT | JSON 字符串（数组） |
| `quality_score` | REAL | 默认 0 |
| `score_source` | TEXT | `auto_bootstrap_v1` / `human` 等 |
| `status` | TEXT | `active` / `suspect` / `dead` |
| `last_verified_at` | TEXT | 人工确认时间 |
| `last_checked_at` | TEXT | 系统探测时间 |
| `consecutive_failures` | INTEGER | 默认 0 |
| `failure_reported_by_user` | INTEGER | 0/1 |
| `click_count` | INTEGER | 默认 0 |
| `impression_count` | INTEGER | 默认 0 |
| `duration` | INTEGER | 视频时长（秒），可空 |
| `description` | TEXT | 视频简介，可空 |

---

## Step 2：教程库数据导入（P1-D1 + P1-D2）

> **P1-D2 已完成**：`server/scripts/normalize_pingpong_merged_tutorials.js` 和 `server/data/tutorials.pingpong-merged.normalized.json`（4.5MB，~4834 条）均已存在。

### [NEW] `server/scripts/importTutorials.ts`

职责：读取 `server/data/tutorials.pingpong-merged.normalized.json`，逐条写入 `tutorial_videos` 表。

关键逻辑：
- 使用 `INSERT OR IGNORE` 避免重复导入
- `source_folder_titles` / `tags` / `related_action_ids` 等数组字段序列化为 JSON 字符串存储
- 初始 `status = 'active'`，`quality_score = 0`（冷启动脚本后续覆盖）
- 打印导入结果：`Imported X / skipped Y (already exists)`

运行方式（一次性）：
```bash
cd server && npx tsx scripts/importTutorials.ts
```

---

## Step 3：冷启动评分（P1-D3）

### [NEW] `server/scripts/bootstrapQualityScores.ts`

实现设计文档 §19.2 的 `computeInitialScore()` 逻辑：

| 信号 | 权重 |
|------|------|
| 有 `author` | +1 |
| 有 `related_action_ids`（非空） | +2（最高权重） |
| 有 `description` | +0.5 |
| 有 `duration > 0` | +0.5 |
| `source_folder_titles` 数量（最多 +2） | `min(count-1, 2)` |
| 标题质量（纯 hashtag -0.5，过短 -0.5，>10字 +0.5） | 启发式 |

- 只更新 `quality_score = 0` 的记录
- 写入 `score_source = 'auto_bootstrap_v1'`
- 打印完成统计

运行方式（一次性，在 `importTutorials.ts` 后运行）：
```bash
cd server && npx tsx scripts/bootstrapQualityScores.ts
```

---

## Step 4：教程推荐算法（P1-S1 + P1-S2）

### [NEW] `server/tutorials/scoreCandidate.ts`

完整实现设计文档 §11 的评分逻辑：
- `action_id` 精确命中：+5
- tag 命中数：`min(hits * 0.5, 2)`
- 标题关键词命中：+0.5

### [NEW] `server/tutorials/recommendTutorials.ts`

实现设计文档 §11 的推荐主函数：
1. 从 SQLite 召回候选（`status IN ('active', 'suspect')`，按 `related_action_ids` 和 `tags` 做线性扫描过滤，取 `limit * 10` 条）
2. 用 `scoreCandidate()` 评分 + `status`（active +1） + `quality_score * 0.3` 合并排序
3. 取前 `limit` 条（默认 3）
4. 若全为 `suspect`，在返回结果中附加 `_warn: 'links_unverified'`

**注意**：`status = 'dead'` 的条目**绝不进入**推荐结果。

### [NEW] `server/tutorials/loader.ts`

- 提供 `getTutorial(tutorialId)` 单条查询接口（后续上报、健康检查使用）

---

## Step 5：意图路由（P1-S3）

### [NEW] `server/intent/intentRouter.ts`

**第一层：规则强命中**（高置信度，无需 LLM）

| 触发条件 | → Intent |
|----------|----------|
| 含"视频教程/教学视频/示范视频/给我个视频/链接" | `TUTORIAL_REQUEST` |
| 含"上传视频/我拍了/我录了/帮我看视频" 或 event=video | `VIDEO_ANALYSIS` |
| 含明确器材实体（胶皮/底板/套胶型号关键词） | `EQUIPMENT_QA` |
| 含敏感词黑名单 | `OFF_TOPIC`（拒绝回复） |

**第二层：LLM 结构化分类**（处理规则未命中的情况）

- 独立调用一次轻量 Gemini 请求（prompt 要求只输出 JSON，枚举写死）
- 输出 schema：`{ intent, entities: { action_id, tactic_topic, equipment_query }, confidence, reason }`
- `action_id` 候选集从动作知识库的 `id` 列表注入（防止编造）
- 低置信度（`< 0.5`）或解析失败 → 降级为默认 intent（`ACTION_COACHING`）

导出：
```typescript
export async function classifyIntent(message: string, event?: string): Promise<IntentResult>
```

---

## Step 6：知识编排层 + v2 Chat API（P1-S5 + P1-S6）

### [NEW] `server/knowledge/loader.ts` + `server/knowledge/matcher.ts`

从 `index.js` 提取现有的 `loadKnowledgeBase()` 和 `matchKnowledge()` 逻辑，封装为模块。

### [NEW] `server/orchestrator/templateValidator.ts`

按 intent 类型校验 LLM 输出段落（设计文档 §7.3）：

| Intent | 必含段落 |
|--------|---------|
| `ACTION_COACHING` | `【动作要领】`、`【常见问题】`、`【训练建议】` |
| `TACTIC_ADVICE` | `【存在问题`、`【改进建议` |
| `EQUIPMENT_QA` | `【性能特点】`、`【适合打法】` |

若段落缺失：补入"暂无相关内容"占位，不让前端看到烂尾的回答。

### [NEW] `server/orchestrator/handleChatEvent.ts`

编排完整流程：
1. 调用 `classifyIntent(message)`
2. 根据 intent 调用对应知识域检索（`matchKnowledge()`）
3. 若 intent 含教程需求（`ACTION_COACHING` / `TUTORIAL_REQUEST`），调用 `recommendTutorials()`
4. 组装 `systemInstruction`（知识上下文 + 输出模板约束）
5. 调用 Gemini 生成 `answerText`
6. 调用 `templateValidator` 做后处理
7. 返回 `ChatResponse`（设计文档 §7.2 schema）

### [NEW] `server/routes/v2.ts`

```
POST /api/v2/chat
  Body: { message, history, prefs? }
  → handleChatEvent()
  → ChatResponse { success, answerText, intent, references, tutorialVideos, report, meta }

POST /api/v2/tutorials/recommend
  Body: { query, action_id?, limit? }
  → recommendTutorials()
  → Tutorial[]
```

统一错误响应遵循设计文档 §9.1 的 `ErrorResponse` schema。

### [MODIFY] `server/index.ts`

- 挂载 `/api/v1` 和 `/api/v2` 路由
- 启动时加载知识库（`loadKnowledgeBase()`）
- 注册 `link-health-check` cron job

---

## Step 7：前端适配（P1-F1）⚠️ 最后执行

> [!IMPORTANT]
> 此步骤必须在 Step 1–6 全部完成、v2 接口通过手动 `curl` 验证后才能开始。

### [MODIFY] `client/src/geminiService.ts`（或调用层）

- 新增 `callV2Chat(message, history)` 函数，调用 `POST /api/v2/chat`
- 返回 `ChatResponse` 类型数据
- **保持 v1 接口调用不删除**，作为降级备用

### [MODIFY] `client/src/components/ChatScreen.tsx`（或聊天调用层）

- 将 `response.content` 字段改为 `response.answerText`（v2 响应字段名变更）
- **这是必须同步修改的地方，否则聊天界面显示空白**

### [MODIFY] `client/src/components/AnalysisReportCard.tsx`

- 将报告卡片中的 `videoLinks` 数据来源从 mock/模型文本改为 `ChatResponse.tutorialVideos[]`
- 渲染格式：`tutorial.title` + `tutorial.url`（按 platform 展示图标徽章）

---

## Step 8：链接健康检查 Job（P1-S7）

### [NEW] `server/jobs/linkHealthCheck.ts`

实现设计文档 §17.2 的三级状态机：

- `active → suspect`（单次探测失败）
- `suspect → dead`（连续失败 ≥ 3 次，`consecutive_failures >= DEAD_THRESHOLD=3`）
- `dead → active`（30 天后重探，探测成功）

速率控制：每次请求间隔 200-500ms 随机 jitter。

平台差异处理：
- B 站：HEAD 请求检查
- 抖音：GET 请求 + 检查响应 title 是否含"找不到/已删除"关键词，或依赖层 3 用户上报

触发方式：`node-cron`，每天凌晨 3 点（`0 3 * * *`）。

同时在 `server/routes/v2.ts` 新增：
```
POST /api/v2/tutorials/:tutorial_id/report-dead
  → 将该条目 status 改为 suspect，标记 failure_reported_by_user = 1
```

---

## 验收标准

与设计文档 §附录一致：

1. 问"反手拧拉怎么练/给我视频教程"，响应 `tutorialVideos[]` 中含真实 B 站/抖音链接
2. 模型不再在 `answerText` 中编造任何链接（所有链接来自教程库）
3. `status='dead'` 的条目不出现在推荐结果中
4. 有 `action_id` 关联的教程排在无关联教程之前（可通过评分日志验证）

---

## 验证计划

### 脚本验证（开发阶段）

```bash
# 1. 数据导入验证
cd server && npx tsx scripts/importTutorials.ts
# 预期输出：Imported ~4834 / skipped 0

# 2. 冷启动评分验证
npx tsx scripts/bootstrapQualityScores.ts
# 预期输出：Bootstrap complete: 4834 records updated
# 可用 SQLite CLI 抽检：sqlite3 topstar.db "SELECT tutorial_id, quality_score, score_source FROM tutorial_videos ORDER BY quality_score DESC LIMIT 10;"
```

### 手动接口验证

```bash
# 1. 启动服务
cd server && npm run dev

# 2. 测试 v2 chat 接口（应返回真实教程链接）
curl -X POST http://localhost:3001/api/v2/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "反手拧拉怎么练，给我一个视频教程", "history": []}'
# 验证响应中 tutorialVideos 数组非空，且 url 为真实 B 站/抖音域名

# 3. 测试教程推荐接口
curl -X POST http://localhost:3001/api/v2/tutorials/recommend \
  -H "Content-Type: application/json" \
  -d '{"query": "反手拧拉", "action_id": "bh_flick", "limit": 3}'
# 验证返回 3 条，有 action_id 关联的排在前面
```

### 前端手动验证

1. 启动前端 + 后端
2. 在聊天界面输入"反手拧拉怎么练"
3. 检查报告卡片中的视频链接是否为真实地址（B 站/抖音域名）
4. 点击链接确认可以跳转（非 404）

> [!NOTE]
> 抖音链接可能因登录限制无法直接访问，视为正常。验证 URL 格式正确（`https://www.douyin.com/video/xxxxx`）即可。
