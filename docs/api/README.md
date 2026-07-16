# API 文档

本目录包含对外 API 服务的接口文档。

---

## 文档索引

| 文档 | 描述 | 状态 | 最后更新 |
|------|------|------|----------|
| [tutorial-knowledge-api.md](./tutorial-knowledge-api.md) | 乒乓球知识库 & 教程推荐 API v1 | 📝 草稿 | 2026-07-16 |

---

## 约定

- **Base URL**: `https://api.topstar.ai/v1`（正式域名待定）
- **Content-Type**: `application/json`
- **认证方式**: `Authorization: Bearer <API_KEY>`
- **通用错误格式**: `{ "success": false, "error": { "code": "...", "message": "..." } }`

---

## 更新日志

| 日期 | 变更 |
|------|------|
| 2026-07-16 | 新增 `tutorial-knowledge-api.md` — 知识检索 + 教程推荐 API 初稿 |
