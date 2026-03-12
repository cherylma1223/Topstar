# Topstar 加固技术设计方案 (Tech Spec)

## 1. 概述
本文档为 Topstar 项目的架构加固与安全改造技术方案。旨在通过引入 Supabase Auth 和持久化存储，重构当前的无状态对话机制，实现高安全性的会话管理。

## 2. Supabase Auth 集成方案

### 2.1 前端 Token 传递机制
- **Header 规范**: `Authorization: Bearer <Supabase_Access_Token>`
- **Token 获取**: 通过 `@supabase/supabase-js` 客户端的 `supabase.auth.getSession()` 获取。

### 2.2 Express 后端 JWT 校验中间件 (`auth.middleware.ts`)
- **处理逻辑**:
  1. 提取 `Authorization` header 中的 Bearer Token。
  2. 使用 Supabase JWT Secret 验证签名。
  3. 校验失败返回 `401 Unauthorized`。
  4. 校验成功将 `user_id` 挂载至 `req.user`。

## 3. 数据库 Schema 设计 (PostgreSQL / Supabase)

### 3.1 `public.users` (业务扩展表)
- `id`: `uuid` PRIMARY KEY REFERENCES `auth.users`(id) ON DELETE CASCADE
- `created_at`: `timestamptz` DEFAULT now()

### 3.2 `public.sessions` (会话记录)
- `id`: `uuid` PRIMARY KEY DEFAULT uuid_generate_v4()
- `user_id`: `uuid` NOT NULL REFERENCES `public.users`(id) ON DELETE CASCADE
- `title`: `varchar(255)` DEFAULT 'New Chat'
- `created_at`: `timestamptz` DEFAULT now()
- `updated_at`: `timestamptz` DEFAULT now()
- **索引**: `(user_id, updated_at)` 复合索引。

### 3.3 `public.messages` (消息明细)
- `id`: `uuid` PRIMARY KEY DEFAULT uuid_generate_v4()
- `session_id`: `uuid` NOT NULL REFERENCES `sessions`(id) ON DELETE CASCADE
- `role`: `varchar(20)` NOT NULL (user/assistant/system)
- `content`: `text` NOT NULL
- `created_at`: `timestamptz` DEFAULT now()
- **索引**: `(session_id, created_at)` 复合索引。

## 4. API 协议变更说明

### 4.1 核心对话接口：`/api/v1/ai/chat` (POST)
- **Request Body**: `{ "sessionId": "uuid", "prompt": "string" }`
- **处理流转**:
  1. 鉴权并提取 `user_id`。
  2. 校验或创建 `sessionId`。
  3. 用户消息入库 (`messages`)。
  4. 从数据库拉取上下文对话历史。
  5. 调用 Gemini API。
  6. AI 回复入库并更新会话时间。
  7. 响应结果。

## 5. 实施路径建议
- **Phase 1**: 基础设施与数据基座 (SQL 脚本、RLS 策略)。
- **Phase 2**: 后端核心改造 (JWT Middleware、Chat API 重构)。
- **Phase 3**: 前端联调与闭环 (Auth UI、请求拦截器)。

---
*Architect: 老马 (Lao Ma)*
*Status: Pending Review*
*Date: 2026-03-10*
