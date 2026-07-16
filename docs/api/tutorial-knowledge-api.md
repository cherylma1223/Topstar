# 乒乓球知识库 & 教程推荐 API v1

> **Base URL**: `https://api.topstar.ai/v1`（示例，正式域名待定）  
> **Content-Type**: `application/json`  
> **Auth**: `Authorization: Bearer <API_KEY>`  
> **Rate Limit**: 1000 req/min（Free）/ 10000 req/min（Pro）

---

## 目录

| 模块 | 端点 | 说明 |
|------|------|------|
| 知识检索 | `GET /knowledge/search` | 关键词搜索知识库 |
| 知识检索 | `GET /knowledge/entry/:id` | 获取单条知识详情 |
| 知识检索 | `GET /knowledge/actions` | 获取所有动作 ID 列表 |
| 知识检索 | `GET /knowledge/actions/:id` | 获取动作详情（识别线索+诊断规则） |
| 教程推荐 | `GET /tutorials/recommend` | 根据动作 ID 推荐教程 |
| 教程推荐 | `GET /tutorials/search` | 关键词搜索教程 |
| 教程推荐 | `GET /tutorials/:id` | 获取单条教程详情 |
| 系统 | `GET /health` | 健康检查 |

---

## 知识检索

### `GET /knowledge/search`

关键词搜索知识库，返回匹配条目按相关性排序。

**Query Parameters**:

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `q` | string | ✅ | — | 搜索关键词（如"正手拉球下网"） |
| `limit` | number | ❌ | 5 | 返回条数，最大 20 |
| `category` | string | ❌ | — | 过滤分类：`actions` / `tactics` / `equipment` |

**评分规则**：关键词命中 `+10 + 关键词长度`，标题命中 `+20`，按总分降序。

**Response** `200`:

```json
{
  "success": true,
  "data": {
    "query": "正手拉球下网",
    "total": 3,
    "items": [
      {
        "id": "fh_loop",
        "title": "正手拉球",
        "category": "actions",
        "keywords": ["正手", "拉球", "弧圈", "loop", "摩擦"],
        "content": "### 【动作要领】\n1. 引拍时…\n\n### 【常见问题与纠错建议库】\n…",
        "score": 48
      },
      {
        "id": "fh_drive",
        "title": "正手攻球",
        "category": "actions",
        "keywords": ["正手", "攻球", "快攻"],
        "content": "...",
        "score": 12
      }
    ]
  },
  "meta": {
    "took_ms": 2,
    "total_entries_in_base": 62
  }
}
```

**Non-VIP 注意**：`content` 中已剥离 `【核心秘诀】` 段落的条目，会额外返回 `has_vip_content: true` 标记。

**Response** `400`（缺少参数）:

```json
{
  "success": false,
  "error": { "code": "INVALID_PARAM", "message": "Query parameter 'q' is required" }
}
```

---

### `GET /knowledge/entry/:id`

获取单条知识库条目完整内容。

**Path Parameters**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 条目 ID，如 `fh_loop`、`bh_flick`、`tactics_short_ball` |

**Query Parameters**:

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `include_vip` | boolean | ❌ | false | 是否包含核心秘诀（需 VIP 权限） |

**Response** `200`:

```json
{
  "success": true,
  "data": {
    "id": "fh_loop",
    "title": "正手拉球（弧圈球）",
    "category": "actions",
    "keywords": ["正手", "拉球", "弧圈", "loop", "摩擦"],
    "content": "### 【动作要领】\n1. 引拍时…",
    "has_vip_content": true,
    "vip_section_title": "核心秘诀"
  }
}
```

**Response** `404`:

```json
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "Knowledge entry 'unknown_action' not found" }
}
```

---

### `GET /knowledge/actions`

获取所有已登记的技术动作 ID 列表，适合做下拉框 / 自动补全。

**Response** `200`:

```json
{
  "success": true,
  "data": {
    "total": 28,
    "actions": [
      { "id": "fh_loop", "title": "正手拉球", "aliases": ["正手弧圈", "前冲弧圈", "高吊弧圈"] },
      { "id": "fh_drive", "title": "正手攻球", "aliases": ["正手快攻", "正手抽球"] },
      { "id": "bh_flick", "title": "反手拧拉", "aliases": ["反手拧", "台内拧"] },
      { "id": "fh_serve", "title": "正手发球", "aliases": ["正手发下旋", "正手发侧旋"] }
    ]
  }
}
```

---

### `GET /knowledge/actions/:id`

获取指定动作的完整分析知识——包含识别线索和诊断规则，适用于视频分析场景。

**Response** `200`:

```json
{
  "success": true,
  "data": {
    "action": {
      "id": "fh_loop",
      "title": "正手拉球",
      "definition": "以摩擦为主的正手弧圈球技术，分为前冲弧圈和高吊弧圈",
      "scope": { "scenario": "中远台进攻", "exclusions": ["近台快带", "扣杀"] }
    },
    "recognition": {
      "positive_cues": [
        { "phase": "引拍", "cue": "持拍手向后下方引拍，低于球台面", "weight": 3 },
        { "phase": "击球", "cue": "由下向上摩擦球体，有明显包球动作", "weight": 3 },
        { "phase": "随挥", "cue": "拍面收至额前或头顶", "weight": 2 }
      ],
      "negative_cues": [
        { "phase": "击球", "cue": "纯撞击无摩擦，出球无弧线", "weight": 3 }
      ],
      "confusable_with": [
        {
          "action_id": "fh_drive",
          "key_difference": "攻球以撞击为主，击球点更高更前；拉球以摩擦为主，引拍更低，随挥收至额前",
          "required_visible_info": ["击球瞬间拍面角度", "随挥终点位置"]
        }
      ]
    },
    "diagnosis": {
      "rules": [
        {
          "issue_id": "fh_loop_001",
          "evidence": "引拍时肘部外翻，远离身体",
          "problem": "肘部外翻导致发力分散，无法集中摩擦",
          "priority": 1,
          "advice": "腋下夹毛巾练习，限制大臂外展幅度",
          "related_cues": ["肘部位置", "大臂角度"]
        },
        {
          "issue_id": "fh_loop_002",
          "evidence": "击球后随挥停在胸前，未收至额前",
          "problem": "随挥不完整，摩擦不充分导致旋转不足",
          "priority": 2,
          "advice": "强调收小臂到额前，可用手机慢动作自拍对比",
          "related_cues": ["随挥终点"]
        }
      ]
    }
  }
}
```

---

## 教程推荐

### `GET /tutorials/recommend`

根据动作 ID 和标签推荐相关教学视频。

**Query Parameters**:

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `action_id` | string | ❌ | — | 技术动作 ID（如 `bh_flick`） |
| `tags` | string | ❌ | — | 搜索标签，逗号分隔（如 `正手,发球,下旋`） |
| `limit` | number | ❌ | 3 | 返回条数，最大 10 |
| `min_quality` | number | ❌ | 0 | 最低质量分过滤（0-5） |

> `action_id` 和 `tags` 至少提供一个。

**评分公式**：  
```
总分 = action_id精确命中(+5) + tag命中(min(0.5×n, 2)) + 标题命中(+0.5)
     + status_active(+1) + quality_score×0.3
```

**Response** `200`:

```json
{
  "success": true,
  "data": {
    "action_id": "bh_flick",
    "total": 2,
    "items": [
      {
        "tutorial_id": "tut_001",
        "title": "反手拧拉完整教学：从入门到进阶",
        "url": "https://www.bilibili.com/video/BV1xxx",
        "platform": "bilibili",
        "author": "乒乓大师",
        "tags": ["反手", "拧拉", "台内", "进阶"],
        "quality_score": 4.5,
        "status": "active",
        "score": 8.35
      },
      {
        "tutorial_id": "tut_002",
        "title": "张继科式反手拧拉慢动作解析",
        "url": "https://www.youtube.com/watch?v=yyy",
        "platform": "youtube",
        "author": "TT Analysis",
        "tags": ["反手", "拧拉", "张继科", "慢动作"],
        "quality_score": 3.8,
        "status": "active",
        "score": 6.64
      }
    ],
    "warning": null
  },
  "meta": {
    "took_ms": 15,
    "candidates_scanned": 8,
    "active_count": 2,
    "suspect_count": 0
  }
}
```

**全 suspect 降级**（链接未验证）:

```json
{
  "success": true,
  "data": {
    "action_id": "some_rare_action",
    "total": 1,
    "items": [{ "..." }],
    "warning": "links_unverified"
  }
}
```

**Response** `400`:

```json
{
  "success": false,
  "error": { "code": "INVALID_PARAM", "message": "At least one of 'action_id' or 'tags' is required" }
}
```

---

### `GET /tutorials/search`

关键词搜索教程库（标题 + 标签模糊匹配）。

**Query Parameters**:

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `q` | string | ✅ | — | 搜索关键词 |
| `platform` | string | ❌ | — | 过滤平台：`bilibili` / `youtube` |
| `status` | string | ❌ | — | 过滤状态：`active` / `suspect`（默认全部非 dead） |
| `page` | number | ❌ | 1 | 页码 |
| `per_page` | number | ❌ | 20 | 每页条数，最大 50 |

**Response** `200`:

```json
{
  "success": true,
  "data": {
    "query": "拧拉",
    "total": 12,
    "page": 1,
    "per_page": 20,
    "items": [
      {
        "tutorial_id": "tut_001",
        "title": "反手拧拉完整教学",
        "url": "https://www.bilibili.com/video/BV1xxx",
        "platform": "bilibili",
        "author": "乒乓大师",
        "tags": ["反手", "拧拉", "台内"],
        "related_action_ids": ["bh_flick"],
        "quality_score": 4.5,
        "status": "active"
      }
    ]
  }
}
```

---

### `GET /tutorials/:id`

获取单条教程完整信息。

**Response** `200`:

```json
{
  "success": true,
  "data": {
    "tutorial_id": "tut_001",
    "platform": "bilibili",
    "platform_item_id": "BV1xxx",
    "title": "反手拧拉完整教学：从入门到进阶",
    "url": "https://www.bilibili.com/video/BV1xxx",
    "author": "乒乓大师",
    "tags": ["反手", "拧拉", "台内", "进阶"],
    "related_action_ids": ["bh_flick"],
    "quality_score": 4.5,
    "status": "active",
    "last_health_check": "2026-07-15T03:00:00Z"
  }
}
```

---

## 系统

### `GET /health`

无需认证。

**Response** `200`:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "knowledge_entries": 62,
  "tutorial_videos": 240,
  "uptime_seconds": 86400
}
```

---

## 错误码

| HTTP Status | Code | 说明 |
|-------------|------|------|
| 400 | `INVALID_PARAM` | 缺少必填参数或参数格式错误 |
| 401 | `UNAUTHORIZED` | 缺少或无效的 API Key |
| 403 | `FORBIDDEN` | 权限不足（如非 VIP 请求 include_vip） |
| 404 | `NOT_FOUND` | 资源不存在 |
| 429 | `RATE_LIMITED` | 请求频率超限 |
| 500 | `INTERNAL_ERROR` | 服务端错误 |

所有错误响应格式统一：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": {}
  }
}
```

---

## 认证

所有 API 请求（除 `/health`）须携带 API Key：

```bash
curl -H "Authorization: Bearer sk_live_xxxxxxxxxx" \
     "https://api.topstar.ai/v1/knowledge/search?q=正手拉球"
```

### API Key 类型

| 类型 | 前缀 | 说明 |
|------|------|------|
| 测试 Key | `sk_test_` | 100 req/day，仅返回摘要 |
| 生产 Key | `sk_live_` | Free 1000/月，Pro 10000/月 |
| VIP Key | `sk_vip_` | 含 `【核心秘诀】` 完整内容 |

---

## 套餐计划（参考）

| | Free | Pro | Enterprise |
|------|------|------|------|
| 月请求量 | 1,000 | 10,000 | 自定义 |
| 知识库条目 | 摘要（300字截断） | 全文 | 全文 |
| 动作识别线索 | ❌ | ✅ | ✅ |
| 诊断规则 | ❌ | ✅ | ✅ |
| VIP 核心秘诀 | ❌ | ❌ | ✅ |
| 教程推荐 | 前 1 条 | 前 5 条 | 全量 |
| SLA | — | 99.5% | 99.9% |
| 支持 | 社区 | 邮件 | 专属群 + 远程 |
| 价格 | 免费 | ¥XXX/月 | 议价 |

---

## 调用示例

**场景：AI 教练应用集成**

```typescript
// 1. 用户问"正手拉球老是下网"，先搜知识库
const kb = await fetch(
  "https://api.topstar.ai/v1/knowledge/search?q=正手拉球下网&limit=3",
  { headers: { Authorization: "Bearer sk_live_xxx" } }
).then(r => r.json());

// 2. 知识库返回 fh_loop 条目，把 content 注入 AI prompt

// 3. 顺便推荐相关教程
const tuts = await fetch(
  "https://api.topstar.ai/v1/tutorials/recommend?action_id=fh_loop&limit=3",
  { headers: { Authorization: "Bearer sk_live_xxx" } }
).then(r => r.json());

// 4. 把教程链接附在 AI 回复末尾
```

**场景：视频分析平台集成**

```typescript
// 1. 用户上传视频，先获取动作库列表让用户选择
const actions = await fetch(
  "https://api.topstar.ai/v1/knowledge/actions",
  { headers: { Authorization: "Bearer sk_live_xxx" } }
).then(r => r.json());

// 2. 视频分析识别到 fh_loop，获取完整诊断知识
const detail = await fetch(
  "https://api.topstar.ai/v1/knowledge/actions/fh_loop",
  { headers: { Authorization: "Bearer sk_vip_xxx" } }
).then(r => r.json());

// detail.data.recognition.positive_cues  → 传给视频分析 AI 做识别
// detail.data.diagnosis.rules            → 传给视频分析 AI 做诊断
// detail.data.recognition.confusable_with → 传给视频分析 AI 做混淆判断
```
