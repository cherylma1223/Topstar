# 会话历史 API（/api/v2/conversations）

> **Base URL**: `/api/v2`（开发环境经 Vite proxy 打到 `localhost:3001`）
> **Content-Type**: `application/json`
> **Auth**: `Authorization: Bearer <登录令牌>` — **所有端点都必须登录**，未登录返回 401
> **归属**: 每个会话/消息都带 `user_id`，服务端强制按登录用户过滤；别人的会话与不存在的会话对外表现一致（404）
> **时间**: 所有时间字段是 **毫秒时间戳**（`Date.now()`），客户端自行格式化

---

## 目录

| 方法 | 端点 | 说明 |
|---|---|---|
| `GET` | `/conversations` | 列表 + 标题模糊搜索 |
| `POST` | `/conversations` | 新建会话 |
| `GET` | `/conversations/:id` | 会话详情（含全部消息） |
| `PATCH` | `/conversations/:id` | 修改标题 |
| `POST` | `/conversations/:id/messages` | 批量追加消息 |
| `POST` | `/chat` | 对话（已扩展：可选落库到指定会话） |

---

## 通用错误格式

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "请先登录",
    "retryable": false,
    "request_id": ""
  }
}
```

| code | HTTP | 含义 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 没带令牌 / 令牌无效 / 已过期 |
| `INVALID_INPUT` | 400 | 参数缺失或格式不对 |
| `CONVERSATION_NOT_FOUND` | 404 | 会话不存在，或不属于当前登录用户 |
| `INTERNAL_ERROR` | 500 | 服务端异常（可重试） |

---

## `GET /conversations`

会话列表；带 `q` 时为**标题模糊搜索**。

**Query Parameters**

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `q` | string | ❌ | — | 模糊搜索关键词，1~50 字符，超长截断；trim 后为空视同不传 |
| `limit` | number | ❌ | 50 | 返回条数，最大 100 |

**搜索语义（模糊）**

- 子串匹配 `title LIKE '%q%'`，不区分 ASCII 大小写；中文按字符子串
- `%`、`_`、`\\` 会被转义，**不会**被当成通配符
- 只搜标题，不搜消息正文
- 排序：`updated_at DESC`（最近聊过的在前）

**Response** `200`

```json
{
  "success": true,
  "items": [
    {
      "id": "8f14e45f-ceea-4e2f-8b3c-1a2b3c4d5e6f",
      "title": "反手拧拉总下网怎么办",
      "service": "当家球星",
      "message_count": 4,
      "last_message_at": 1763625600000,
      "created_at": 1763625000000,
      "updated_at": 1763625600000,
      "snippet": "…反手**拧拉**总下网…"
    }
  ],
  "total": 1,
  "query": "拧拉"
}
```

| 字段 | 说明 |
|---|---|
| `items[].snippet` | **仅搜索时有值**：命中位置前后各 12 字的窗口（不含高亮标记，客户端用 `indexOf` 自行高亮）；标题没命中时为 `null` |
| `total` | 本次返回条数（不是全库总数） |
| `query` | 回显生效的搜索词（trim + 截断后的值） |

**空列表**（未登录已由 401 拦截；登录但没会话）：

```json
{ "success": true, "items": [], "total": 0, "query": null }
```

---

## `POST /conversations`

新建会话。一般不需要显式调用：`POST /chat` 不带 `conversation_id` 时服务端会自动建。

**Body**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | ❌ | 1~60 字符，默认「新对话」 |
| `service` | string | ❌ | 入口名，如 `当家球星` / `技术动作分析` / `AI 场外指导` / `器材推荐` |

```json
{ "title": "反手拧拉总下网怎么办", "service": "当家球星" }
```

**Response** `201`

```json
{
  "success": true,
  "conversation": {
    "id": "8f14e45f-ceea-4e2f-8b3c-1a2b3c4d5e6f",
    "title": "反手拧拉总下网怎么办",
    "service": "当家球星",
    "message_count": 0,
    "last_message_at": null,
    "created_at": 1763625000000,
    "updated_at": 1763625000000
  }
}
```

---

## `GET /conversations/:id`

会话详情 + 全量消息（按 `seq` 升序，单会话上限 500 条）。

**Response** `200`

```json
{
  "success": true,
  "conversation": {
    "id": "8f14e45f-ceea-4e2f-8b3c-1a2b3c4d5e6f",
    "title": "反手拧拉总下网怎么办",
    "service": "当家球星",
    "message_count": 2,
    "created_at": 1763625000000,
    "updated_at": 1763625600000,
    "messages": [
      {
        "id": "b7c2c0f0-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
        "seq": 1,
        "role": "user",
        "content": "反手拧拉总下网怎么办",
        "payload": null,
        "client_msg_id": "user-1763625000123",
        "analysis_job_id": null,
        "created_at": 1763625000123
      },
      {
        "id": "c8d3d1a1-2b3c-4d4e-8f90-1b2c3d4e5f60",
        "seq": 2,
        "role": "assistant",
        "content": "问题点在于触球点太晚…",
        "payload": "[{\"type\":\"report\",\"reportData\":{\"techName\":\"反手拧拉\",\"summaryText\":\"问题点在于触球点太晚…\",\"problems\":[],\"improvements\":[],\"variant\":\"gradient\"}}]",
        "client_msg_id": null,
        "analysis_job_id": null,
        "created_at": 1763625600456
      }
    ]
  }
}
```

| 字段 | 说明 |
|---|---|
| `role` | `user` / `assistant` |
| `content` | 纯文本回答（与拼给 LLM 的 `history[].content` 同形态） |
| `payload` | JSON **字符串**，内容是 `MessagePart[]`（报告卡片、视频气泡等富媒体）；`null` 表示纯文本消息 |
| `client_msg_id` | 客户端幂等键，原样回显 |
| `analysis_job_id` | 视频分析消息关联的 `analysis_jobs.id` |

**Response** `404`

```json
{
  "success": false,
  "error": { "code": "CONVERSATION_NOT_FOUND", "message": "会话不存在", "retryable": false, "request_id": "" }
}
```

---

## `PATCH /conversations/:id`

**Body**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | ✅ | 1~60 字符，trim 后为空返回 400 |

```json
{ "title": "反手拧拉 · 触球点问题" }
```

**Response** `200`

```json
{
  "success": true,
  "conversation": { "id": "8f14e45f-…", "title": "反手拧拉 · 触球点问题", "updated_at": 1763625700000 }
}
```

---

## `POST /conversations/:id/messages`

批量追加消息（`POST /chat` 之外的来源：视频分析结果、本地 mock 回复等）。

**Body**

```json
{
  "messages": [
    {
      "role": "user",
      "content": "[上传了视频] 反手练习.mp4",
      "payload": "[{\"type\":\"video\",\"videoUrl\":\"blob:…\",\"duration\":\"00:15\"}]",
      "client_msg_id": "u-1763626000456",
      "analysis_job_id": null
    },
    {
      "role": "assistant",
      "content": "问题点：触球点偏晚…",
      "payload": "[{\"type\":\"report\",\"reportData\":{…}}]",
      "client_msg_id": "ai-1763626040123",
      "analysis_job_id": "6215d70a-0f98-41cd-a243-a66bf8ea0d3a"
    }
  ]
}
```

**规则**

- `messages` 1~20 条；`role` 只能是 `user`/`assistant`；`content` 上限 8000 字符
- `payload` 序列化后上限 64KB，超限**丢弃该字段**（只保留 `content`），响应里 `dropped_payload` 计数
- `client_msg_id` 相同时幂等去重（不重复写）
- 写入同时更新会话 `message_count / last_message_at / updated_at`

**Response** `200`

```json
{
  "success": true,
  "inserted": 2,
  "skipped": 0,
  "dropped_payload": 0,
  "conversation": { "id": "8f14e45f-…", "message_count": 4, "updated_at": 1763626040500 }
}
```

---

## `POST /chat`（已扩展）

原有请求/响应结构不变，新增**可选**字段；不传时行为与旧版完全一致（不落库）。

**Body（新增部分）**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `conversation_id` | string | ❌ | 指定会话；不传则**自动新建**一个会话 |
| `service` | string | ❌ | 仅在建会话时生效，默认 `当家球星` |
| `client_msg_id` | string | ❌ | 用户消息的幂等键，用于重试去重 |

```json
{
  "message": "反手拧拉总下网怎么办",
  "history": [{ "sender": "user", "content": "…" }],
  "conversation_id": "8f14e45f-ceea-4e2f-8b3c-1a2b3c4d5e6f",
  "service": "当家球星",
  "client_msg_id": "user-1763625000123"
}
```

**Response（新增部分）**

```json
{
  "success": true,
  "answer_text": "…",
  "intent": "ACTION_COACHING",
  "conversation_id": "8f14e45f-ceea-4e2f-8b3c-1a2b3c4d5e6f",
  "assistant_message_id": "c8d3d1a1-2b3c-4d4e-8f90-1b2c3d4e5f60"
}
```

**落库行为**

1. 回答生成成功后，在**同一事务**里写入 `user` + `assistant` 两条消息
2. 落库失败**不影响**这次回答：记 `[Conversations] persist failed` 错误日志，响应不带 `conversation_id` / `assistant_message_id`（客户端据此判断这轮不进历史）
3. `success: false` 的错误响应不建会话、不落库
4. 新会话标题 = 首条消息前 10 字（超过 10 字才加 `…`）
5. `client_msg_id` 已存在（客户端重试）时不重复写，响应仍带 `conversation_id`、不带 `assistant_message_id`
6. **`conversation_id` 不属于当前用户 → 404 `CONVERSATION_NOT_FOUND`，且在调用 LLM 之前就拒绝**（不白花一次模型调用，也不会写进别人的会话）

**assistant 消息的 `payload`**

服务端按客户端渲染约定生成，便于历史还原：

- 有推荐教程 → `[{ "type": "report", "reportData": { techName, summaryText, problems: [], improvements: [], videoLinks, variant: "gradient" } }]`
- 无推荐教程 → `[{ "type": "text", "content": answerText }]`

`techName` 规则：取 `references` 里 `type === "actions_doc"` 的标题；`VIDEO_ANALYSIS` 意图下为 `<动作>技术动作诊断报告`，其余为 `<动作>技术指导`。

---

## 客户端落库约定（非 /chat 来源）

视频分析这类「消息由前端产生、服务端只做存储」的场景，客户端用下列形态调用 `POST /:id/messages`：

| 消息 | `content` | `payload` |
|---|---|---|
| 用户上传视频 | `[视频] 反手练习.mp4` | `[{ "type": "text", "content": "[视频] 反手练习.mp4" }]` |
| 分析报告 | 文本段落 + 报告综述/技术名 | 只保留 `text` / `report` 部件 |

> blob 视频地址、首帧截图 base64 刷新后必然失效，也会把 `payload` 撑爆 64KB 上限，因此**不入库**；历史里展示为文本气泡，点开不再回放当次上传的视频。

---

## 客户端调用示例

```ts
// 打开侧边栏：拉列表
const list = await authedFetch('/api/v2/conversations');

// 搜索（300ms 防抖后）
const found = await authedFetch(`/api/v2/conversations?q=${encodeURIComponent(kw)}`);

// 点开某个历史会话
const detail = await authedFetch(`/api/v2/conversations/${id}`);

// 发消息（首条不带 conversation_id）
const res = await authedFetch('/api/v2/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message, history, conversation_id: currentId, client_msg_id }),
});
// res.conversation_id → 保存到 activeConversationId，后续消息带上
```
