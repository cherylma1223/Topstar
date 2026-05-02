# System Architecture Spec

## 1. 核心定位
Topstar AI Coach 是一款基于 Gemini 多模态能力的乒乓球 AI 教练 H5 应用，提供动作纠正、战术分析、器材建议及视频教程。

## 2. 总体架构 (BFF 模式)
- **Frontend**: React (TypeScript) + Vite
- **Backend (BFF)**: Node.js (Express)
- **Database**: SQLite (WAL 模式)
- **AI Engine**: Gemini 2.0 Flash / Pro

## 3. 核心模块
- **Knowledge Orchestrator**: 负责意图识别、知识库检索与回复组装。
- **Tutorial System**: 包含 ~5000 条标准化视频教程数据，支持质量分排序与死链检测。
- **Intent Layer**: (V2) 结构化请求理解层。包含 Domain Intent, Task Intent, Response Mode 和增强型 Entities。支持规则、模型、Policy 三段式识别流。

## 4. 数据协议
- **Chat V2**: 返回结构化 JSON，包含 `answerText`, `intent_decision` 和 `tutorialVideos[]`。
- **Analysis Report**: 包含 `problems`, `improvements`, `videoLinks` 的结构化报告。

## 5. 开发规范
- 详见 `docs/solutions/Topstar_Product_Technical_Design_codex_v6.md`
