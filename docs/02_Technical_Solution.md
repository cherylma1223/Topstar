# Topstar AI Coach - 技术实现方案 (生产级架构)

## 1. 总体架构设计
为了实现从 Demo 到真实产品的跃迁，我们将采用 **BFF (Backend For Frontend)** 模式。

* **前端**: React (TypeScript) + Vite
* **后端**: Node.js (Express/NestJS) - 负责鉴权、业务逻辑、API 中转。
* **数据库**: PostgreSQL (推荐，配合 Prisma ORM) 或 MongoDB - 存储用户信息、对话历史、分析报告。
* **认证**: JWT (jsonwebtoken) + 环境变量加密。

## 2. 数据库模型预设 (CRUD 准备)
我们将设计以下核心模型以支持未来迭代：
* **User**: id, email, password_hash, profile_info, created_at
* **ChatSession**: id, user_id, title, ai_service_type, last_message_at
* **ChatMessage**: id, session_id, sender(user/ai), content, type(text/image/video)
* **AnalysisReport**: id, message_id, video_url, coach_feedback_json

## 3. Gemini 集成策略 (生产级)
* **后端中转**: 前端不直接持有 API Key。所有请求通过后端接口 `/api/v1/ai/chat`。
* **流式响应**: 考虑支持 Stream 模式以提升用户体验。
* **Token 监控**: 记录每个用户的 Token 消耗量。

## 4. 部署与 CI/CD
* **GitHub**: 建立 Master/Dev 分支。
* **Vercel/Railway**: 前后端分离部署或 Monorepo 部署。
* **Secret Management**: API Key 和 Database URL 严格存放在生产环境环境变量中。

## 5. 开发分步计划 (待审批)
1. **Phase 1**: 搭建后端骨架，迁移 Gemini 调用逻辑至后端。
2. **Phase 2**: 接入数据库，实现对话历史持久化。
3. **Phase 3**: 实现用户注册/登录基础模块。
4. **Phase 4**: 整体 UI 适配与生产环境联调。
