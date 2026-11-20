# Phase 4：历史会话入库 + 模糊搜索 — 设计与实施计划

> 目标：把「聊天记录」从**内存演示数据**升级为**按登录用户绑定的持久化会话**，侧边栏历史列表支持**标题模糊搜索**，且退出登录后本机历史立即清空。

## Change Log

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-11-20 | 初始版本 | 依据产品需求「要入库 + 用户绑定 + 模糊搜索 + 退出清空」编写；关键取舍已确认（见 §2） |
| 2026-11-20 | 实施完成 | S1~S4 全部落地，验收项与单测/接口验证结果见 §11 |

---

## 1. 现状（为什么必须改）

| 层 | 现状 | 位置 |
|---|---|---|
| 服务端 | **没有任何会话/消息表**，`/api/v2/chat` 只是无状态转发：`history` 从 body 读、拼上下文、回答完即丢弃 | `server/routes/v2.ts:198-237` |
| 数据库 | 只有 `users` / `sessions` / `sms_codes` / `analysis_jobs` / `tutorial_videos` | `server/db.ts`、`server/auth/schema.ts` |
| 客户端 | `history` 是 `useState` 里 **3 条硬编码假数据**，新会话只在内存 push；刷新即丢 | `client/App.tsx:60-64`、`297-315` |
| 搜索 | 侧边栏搜索框只对内存里的假数据做 `includes` 过滤 | `client/components/Sidebar.tsx:26-28` |
| 退出登录 | `logout()` 清令牌 + `handleResetToHome()` 清当前消息，但 `history` 数组不清 | `client/App.tsx:317-320` |

结论：会话表要新建，chat 链路要落库，客户端要从「本地数组」切到「服务端数据源」。

---

## 2. 已确认的语义取舍

| 议题 | 决定 | 理由 / 备选 |
|---|---|---|
| 退出登录清空范围 | **只清本机界面，服务端数据保留**；同一账号重新登录后历史可恢复 | 产品原话「退出登录后，最近历史对话清空」按「同一台设备不要让下一个人看到上一个人的历史」理解；删除服务端数据不可逆，风险高，故不采纳 |
| 模糊搜索范围 | **只搜会话标题**（`conversations.title`），不搜消息正文 | 已确认。正文搜索列为后续优化（§10） |
| 会话归属 | 会话与消息**必须带 `user_id`**，一切查询强制 `WHERE user_id = ?` | 与 `analysis_jobs` 的归属模型保持一致 |
| 越权访问语义 | 别人的 / 不存在的会话**一律 404 `conversation_not_found`**，不返回 403 | 避免通过错误码探测他人会话是否存在（同 `server/routes/v2.ts:494` 的既有约定） |
| 未登录 | `/api/v2/conversations*` 全部 401；侧边栏历史区显示「登录后查看历史对话」，搜索框禁用 | 与现有「对话需要登录」一致 |
| 落库时机 | 对话在 `POST /api/v2/chat` 内**同一次请求**落库（用户消息 + AI 回答），视频分析等其他入口走追加接口 | 少一次往返；但落库失败**不能让用户拿不到回答**，见 §7 决策 D4 |

---

## 3. 数据模型

新增两张表，全部在启动时幂等创建（`CREATE TABLE IF NOT EXISTS`），挂在 `server/db.ts` 里，与 `migrateAuthTables` 同批执行。

**时间列一律 INTEGER 毫秒时间戳**（`Date.now()`），与 `users` / `sessions` / `sms_codes` 保持一致；`analysis_jobs.created_at` 用的是 ISO TEXT，属于历史包袱，新表不跟随。

```sql
-- 会话（一条 = 侧边栏里的一行）
CREATE TABLE IF NOT EXISTS conversations (
  id               TEXT PRIMARY KEY,              -- uuid v4
  user_id          TEXT NOT NULL,                 -- 归属用户（users.id）
  title            TEXT NOT NULL DEFAULT '新对话',
  service          TEXT,                          -- 入口名：当家球星 / 技术动作分析 / AI 场外指导 / 器材推荐
  message_count    INTEGER NOT NULL DEFAULT 0,    -- 冗余计数，列表页不 JOIN
  last_message_at  INTEGER,                       -- 最后一条消息时间
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,              -- 排序键（= 最后一条消息时间，无消息时 = created_at）
  deleted_at       INTEGER                        -- 软删除；本期不出接口，仅预留列
);

-- 消息（一条 = 一个气泡；富媒体放 payload）
CREATE TABLE IF NOT EXISTS conversation_messages (
  id               TEXT PRIMARY KEY,              -- uuid v4
  conversation_id  TEXT NOT NULL,
  user_id          TEXT NOT NULL,                 -- 冗余：越权校验与按用户清理不必 JOIN
  role             TEXT NOT NULL,                 -- 'user' | 'assistant'
  content          TEXT NOT NULL,                 -- 纯文本，形态与发给 LLM 的 history[].content 一致
  payload          TEXT,                          -- JSON：MessagePart[]（report / video / action-card 等）
  client_msg_id    TEXT,                          -- 客户端幂等键（可空）
  analysis_job_id  TEXT,                          -- 视频分析消息关联的 analysis_jobs.id
  seq              INTEGER NOT NULL,              -- 会话内单调递增，客户端时间不可信，靠它排序
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv_seq          ON conversation_messages (conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_user              ON conversation_messages (user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_client      ON conversation_messages (conversation_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;
```

**字段约束（写入时校验）**

- `title`：trim 后 1~60 字符，超长截断；默认由服务端从首条用户消息取前 10 字 + `…`
- `content`：trim 后非空，上限 8000 字符（超出截断并记 warn）
- `payload`：JSON 序列化后上限 64KB（超出则丢弃 payload、只留 content，避免报告 JSON 撑爆库）
- `role`：只允许 `user` / `assistant`
- `seq`：`SELECT MAX(seq)+1` 在同一个写事务里取，避免并发插空

---

## 4. API 契约

完整请求/响应示例见 [docs/api/conversation-history-api.md](../../api/conversation-history-api.md)。全部挂在 `/api/v2/conversations`，**全部经过 `requireAuth`**。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v2/conversations?q=&limit=` | 列表 + 模糊搜索（`q` 为空即列表） |
| `POST` | `/api/v2/conversations` | 新建会话（也可由 `/chat` 隐式创建） |
| `GET` | `/api/v2/conversations/:id` | 会话详情 + 全量消息 |
| `PATCH` | `/api/v2/conversations/:id` | 改标题 |
| `POST` | `/api/v2/conversations/:id/messages` | 批量追加消息（视频分析结果、本地 mock 回复等） |
| `POST` | `/api/v2/chat`（改造） | body 增加 `conversation_id` / `service` / `client_msg_id`，服务端落库并回传 `conversation_id` |

### 4.1 搜索语义（模糊 = 子串）

- 输入 trim 后为空 → 走普通列表，按 `updated_at DESC`
- 匹配：`title LIKE '%<q>%'`，**不区分大小写**（SQLite `LIKE` 对 ASCII 默认不敏感；中文按字符子串）
- 转义：`%`、`_`、`\` 用 `ESCAPE '\\'` 转义，避免用户输入 `%` 变成通配
- 长度：1~50 字符，超出直接按 50 截断，不报错
- 不做：分词、拼音、多关键词 AND、正文搜索（见 §10）
- 返回：命中会话列表，附带 `snippet`（命中词前后各 12 字的窗口，客户端用 `indexOf` 高亮）
- 上限：`limit` 默认 50，最大 100

### 4.2 与 chat 的关系

- 客户端首条消息不带 `conversation_id` → 服务端**自动建会话**，标题取该条消息前 10 字，`service` 取 body 里的 `service`（缺省 `当家球星`）
- 响应新增字段：`conversation_id`、`assistant_message_id`；`success:false` 的错误响应不建会话、不落库
- 服务端在同一事务里写 `user` + `assistant` 两条消息，并更新 `conversations.message_count / last_message_at / updated_at`

---

## 5. 关键设计决策

### D1 为什么消息要存两份（`content` + `payload`）

`content` 是纯文本，直接拿去拼下轮的 LLM `history`（现在客户端就是这么组装的，见 `client/App.tsx:168-190`）；`payload` 存 `MessagePart[]`，用于还原视频封面、报告卡片等富媒体气泡。只存 `payload` 会让文本检索和上下文组装都要解 JSON；只存 `content` 则还原不出卡片。

### D2 为什么不给消息正文建 FTS5

搜索范围已确认只搜标题，`conversations` 单用户量级在千条以内；FTS5 的 `unicode61` 分词器对中文按整段切，效果差，`trigram` 又要求 ≥3 字符。当前用 `LIKE` 全表扫足够（§10 记录了升级路径）。

### D3 越权一律 404

`GET /conversations/:id` 与 `PATCH`、`POST /messages` 都先按 `(id, user_id)` 查；查不到就 404。这样「别人的会话」与「不存在的会话」对外不可区分。

### D4 落库是 best-effort，但不能静默脏数据

对话回答已经产生，落库失败不应让用户看不到回答。约定：

1. 先调 LLM 得到结果，再在**同一个写事务**里落库
2. 事务抛错 → `console.error('[Conversations] persist failed', err)`，响应照常返回（不带 `conversation_id`）
3. 客户端收到无 `conversation_id` 的响应 → 该轮不记入历史，下一条消息重新建会话（用户可见行为：历史里少一条，不报错）
4. 幂等靠 `uq_messages_client`：客户端重试（网络抖动）不会写重复消息

### D5 退出登录清空的本机范围

`handleLogout` 需要清：`messages`、`history`、`activeConversationId`、搜索词与已加载的会话详情缓存。**不清**：外观设置（`topstar-appearance-mode`，属于设备偏好）。

若后续加入本地会话缓存，key 必须带 `user_id`（`topstar-conversations:<userId>`），本期不做本地缓存。

### D6 未登录 / 令牌过期

- `getToken()` 为 null（含过期自动清除）→ 侧边栏历史区显示空态文案「登录后查看历史对话」，搜索框 `disabled`
- 任意会话接口返回 401 → `authedFetch` 已有逻辑会清登录态并弹登录窗（`client/utils/auth.ts:210-227`）；`App.tsx` 随即清空本机历史

---

## 6. 改动清单

### 6.1 服务端（新增）

| 文件 | 内容 |
|---|---|
| `server/conversations/schema.ts` | `migrateConversationTables(db)`：建表建索引（幂等）；在 `server/db.ts` 里调用 |
| `server/conversations/store.ts` | 纯数据访问，不碰 HTTP：`createConversation` / `getConversation` / `listConversations` / `searchByTitle` / `renameConversation` / `appendMessages`（事务 + `seq` 自增 + 幂等去重）/ `touchConversation` |
| `server/conversations/search.ts` | `normalizeQuery`（trim/截断）、`escapeLike`、`buildSnippet`（中文按字符窗口，不用字节切片） |
| `server/routes/conversations.ts` | 5 个端点，全部 `requireAuth`；错误体沿用 `{ success:false, error:{ code, message, retryable, request_id } }` |

### 6.2 服务端（修改）

| 文件 | 改动 |
|---|---|
| `server/db.ts` | 调用 `migrateConversationTables(db)`，启动日志打印新增表 |
| `server/index.ts` | `app.use('/api/v2/conversations', conversationsRouter)` |
| `server/routes/v2.ts` | `/chat`：接收 `conversation_id`/`service`/`client_msg_id`，回答成功后事务落库两条消息，响应加 `conversation_id`/`assistant_message_id` |

### 6.3 客户端（修改）

| 文件 | 改动 |
|---|---|
| `client/types.ts` | 新增 `ConversationSummary`、`ConversationDetail`、`PersistedMessage`；把 `HistoryEntry` 从 `App.tsx` 内联类型搬到这里，增加 `conversationId`、`updatedAt` |
| `client/geminiService.ts` | 新增 `listConversations(q)` / `getConversation(id)` / `renameConversation(id, title)` / `appendConversationMessages(id, msgs)`；`getAIResponseV2` 增加 `conversationId? / service? / clientMsgId?` 三个**可选**参数并原样透传，返回类型增加 `conversationId?` |
| `client/App.tsx` | ① `history` 初值改为 `[]`（删掉 3 条假数据）；② 登录后 `useEffect` 拉列表；③ 新增 `activeConversationId`；④ `handleSendMessage` 传 `conversationId`，用响应里的 `conversation_id` 回填并在首条消息后重建列表；⑤ `handleUpdateTitle` 改为本地 + `PATCH` 双写；⑥ 新增 `handleSearchHistory(q)`（300ms 防抖）；⑦ 新增 `openConversation(id)`：拉详情 → `setMessages`（把 `payload` 还原成 `MessagePart[]`）→ 切到 CHAT；⑧ `handleLogout` 清 `history`/`activeConversationId`；⑨ 视频分析消息通过 `onPersistMessages` 落库 |
| `client/components/Sidebar.tsx` | 搜索框 `:disabled={!user}`、`onChange` 走 `onSearch`（服务端搜索）；列表项展示相对时间；空态区分「未登录」与「未找到匹配记录」；移除内部 `filter`（改为服务端结果） |

### 6.4 不做（本期）

- 会话删除/重命名 UI 的除标题外操作、分享、导出
- 消息正文搜索、拼音、分词
- 多设备实时推送（依赖刷新/切页时拉取）
- 老数据回填（历史上从未落库，无数据可回填）

---

## 7. 验收标准

1. **持久化**：登录 → 发一条消息 → 得到回答 → 刷新页面 → 侧边栏出现该会话，点进去用户消息与 AI 回答（含报告卡片/视频气泡）完整还原
2. **用户绑定**：A 账号的会话在 B 账号登录后不可见；直接 `GET /conversations/<A 的 id>`（带 B 的令牌）返回 404
3. **标题**：首条消息自动生成标题（前 10 字 + `…`）；`PATCH` 改标题后刷新仍是新标题
4. **模糊搜索**：输入「反手」命中标题含「反手」的会话；输入大小写混排/前后空格结果一致；输入 `%` 不返回全部记录；无命中显示「未找到匹配记录」
5. **退出登录**：退出后侧边栏历史区清空、消息区清空；同一账号重新登录后历史恢复
6. **未登录**：侧边栏不显示任何历史条目，搜索框禁用；直接调会话接口返回 401
7. **幂等**：同一 `client_msg_id` 重复提交只落一条
8. **不回归**：`cd server && npm test` 全绿（含新增用例）、`cd server && npm run build`、`cd client && npm run build` 通过；视频分析链路照常可用

### 测试计划（新增）

| 文件 | 覆盖 |
|---|---|
| `server/conversations/__tests__/store.test.ts` | 建会话/追加消息（seq 递增、幂等）/计数与 `updated_at` 更新/越权读不到/软删除不影响 |
| `server/conversations/__tests__/search.test.ts` | `escapeLike`（`% _ \`）、`buildSnippet`（中文窗口、命中在开头/结尾）、`normalizeQuery` 截断 |
| `server/routes/__tests__/conversations.http.test.ts` | 真路由 + 内存库：401（无令牌）/ 列表 / 搜索命中与未命中 / 详情 / 改标题 / 追加消息 / 别人的 id → 404 / `/chat` 落库与响应字段 |

测试沿用 `server/routes/__tests__/auth.http.test.ts` 的写法（内存 `better-sqlite3` + `require.cache` 替换 `../db`）。

---

## 8. 实施步骤（每步可独立验收）

| 步骤 | 内容 | 验收 |
|---|---|---|
| S1 | 建表 + `store.ts` + 单测 | `npm test` 通过；启动日志出现 `[DB] conversation tables ready` |
| S2 | 路由 + `/chat` 落库 + HTTP 测试 | curl 全流程：登录 → chat → 列表 → 搜索 → 详情 → 改标题 |
| S3 | 客户端读：列表 / 详情还原 / 搜索 / 未登录空态 | 刷新后历史仍在；搜索可用 |
| S4 | 客户端写：发消息带 `conversation_id`、视频分析消息落库、退出清空 | 验收标准 1/5/6 全过 |

---

## 9. 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 落库失败被吞 | 历史少一条，用户无感 | `console.error` + §7 决策 D4；`message_count` 与实际不一致由 `GET /:id` 返回真实消息数兜底 |
| `LIKE '%q%'` 全表扫 | 会话极多时搜索变慢 | 单用户千条量级无影响；超阈值上 FTS5 trigram（§10） |
| `payload` 过大 | 库膨胀 | 64KB 上限 + 超限降级只存文本 |
| 回滚 | — | 新表独立、`/chat` 只是**追加**可选字段（老客户端不传 `conversation_id` 时行为完全不变）；回滚只需撤路由挂载与客户端改动，数据表留在库里不影响旧代码 |

---

## 10. 后续优化（不在本期）

1. **消息正文搜索**：`conversation_messages` 加 FTS5 `trigram` 虚表（`contents=conversation_messages`），`MATCH` 与 `LIKE` 双路召回
2. **分页**：列表改 cursor（`updated_at` + `id`），详情消息按 `seq` 分页（当前一次拉全量，上限 500 条）
3. **删除/重命名 UI**：`DELETE` 走软删除（`deleted_at` 列已预留）
4. **跨设备同步**：登录/切页拉取之外，增加 SSE 或轮询
5. **会话标题的 LLM 摘要**：取首轮问答生成更可读的标题（当前是截断）

---

## 11. 实施记录（2026-11-20 完成）

### 11.1 实际改动的文件

**服务端（新增）**

| 文件 | 内容 |
|---|---|
| `server/conversations/schema.ts` | `migrateConversationTables(db)`：建表 + 3 个普通索引 + 1 个条件唯一索引 |
| `server/conversations/search.ts` | `normalizeQuery` / `escapeLike` / `buildSnippet`（按 Unicode 码位切窗，不做字节切） |
| `server/conversations/store.ts` | 全部数据访问：`createConversation` / `getConversation` / `listConversations` / `searchConversations` / `renameConversation` / `appendMessages` / `persistChatTurn` / `conversationExists` |
| `server/routes/conversations.ts` | 5 个端点，`router.use(requireAuth)` |
| `server/conversations/__tests__/search.test.ts`、`store.test.ts` | 纯函数 + 数据层单测（24 条） |
| `server/routes/__tests__/conversations.http.test.ts` | 真路由 + 内存库 + 编排层桩（7 条） |

**服务端（修改）**

- `server/db.ts`：启动时调 `migrateConversationTables`，日志 `[DB] conversation tables ready`
- `server/index.ts`：挂载 `/api/v2/conversations`
- `server/routes/v2.ts`：`/chat` 接收 `conversation_id` / `service` / `client_msg_id`；先校验会话归属；回答成功后 `persistChatTurn` 并在响应里补 `conversation_id` / `assistant_message_id`；新增 `buildAssistantParts` 生成落库用的富媒体部件
- `server/package.json`：`npm test` 增加 `conversations/__tests__/*.test.ts`

**客户端**

- `client/types.ts`：新增 `ConversationSummary` / `PersistedMessage` / `ConversationDetail` / `NewConversationMessage`
- `client/geminiService.ts`：`getAIResponseV2` 增加第 4 个可选参数 `ChatConversationContext`；新增 `listConversations` / `getConversation` / `createConversation` / `renameConversation` / `appendConversationMessages`（401 / 404 一律降级成空值，不打断 UI）
- `client/App.tsx`：删掉 3 条硬编码假数据；`history` 改为服务端数据 + `historyQuery` 防抖搜索；新增 `activeConversationId`（配 ref 避免闭包旧值）；`openConversation` 还原消息；`persistLocalMessages` 负责非 /chat 消息落库；`handleUpdateTitle` 改为 PATCH 回写；`handleLogout` 清空本机历史
- `client/components/Sidebar.tsx`：搜索框改受控 + 服务端搜索（输入即触发，App 内 300ms 防抖）；列表展示相对时间、当前会话高亮；空态区分「未登录 / 没有历史 / 未找到匹配」
- `client/components/ChatScreen.tsx`：视频分析拆成 `buildReportMessage` + `renderReportMessage`，渲染前先落库（拿到会话 id 后 `onUpdateTitle` 才能改对标题）；失败路径也留痕

### 11.2 与设计稿的差异（都已回写进 API 文档）

| 设计稿原话 | 实现 | 原因 |
|---|---|---|
| `/chat` 带别人的 `conversation_id` 未定义 | 返回 **404**，并且在调 LLM 之前拒绝 | 不白花一次模型调用；行为与会话接口一致 |
| 视频消息的 `payload` = `MessagePart[]` | 只存文本部件，blob 视频地址与首帧 base64 **不入库** | 刷新后必然失效，且 base64 会撑爆 64KB 上限 |
| 未提及 | `'assistant'` 字面量会触发 `check-icons`（它恰好是 Material 图标名），相关行加 `// icon-check-ignore` | 保持 `npm run build` 通过 |

### 11.3 验证结果

| 验证项 | 结果 |
|---|---|
| `cd server && npm test` | 192 passed / 0 failed / 1 skipped（193 条，含新增 31 条） |
| `cd server && npx tsc --noEmit` | 通过 |
| `cd client && npx tsc --noEmit` | 通过 |
| `cd client && npm run build` | 通过（图标子集检查 + 产物检查） |
| 真机接口联调（本地 dev，真实 LLM） | chat 返回 `conversation_id`/`assistant_message_id`；列表 2 条；`?q=正手` 命中且带 snippet；`?q=%` 命中 0 条（转义生效）；详情 2 条消息、assistant `payload` 含 reportData；PATCH 改标题生效；追加消息 inserted=1、重复 client_msg_id inserted=0/skipped=1；带 conversation_id 续聊 seq 连续 1~5 |
| 越权联调（第二个账号） | GET / PATCH / POST messages / POST chat 全部 404，B 的列表为空 |

> 联调用的临时账号与测试会话已从 `server/data/topstar.db` 清理，库里 `conversations` / `conversation_messages` 为 0 行。

