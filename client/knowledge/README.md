# 知识库 (Knowledge Base)

本目录（`client/knowledge/`）是 Topstar 系统的知识库前端存储与展示层。它包含了乒乓球技术动作、器材、战术等相关的知识文档，供前端（如聊天助手、知识卡片等）直接读取和展示。

**⚠️ 重要规范（Single Source of Truth, SSOT）：**
关于“技术动作”的核心知识（包含定义、识别线索、诊断规则等），**唯一的数据来源是教练员填写的 Excel 文件**（位于 `0_coach_knowledge/` 目录下）。
**原则上，严禁直接手动修改 `actions/` 目录下的 Markdown 文件以及服务端相关的识别规则 JSON。** 所有的更新必须通过修改 Excel 源文件，并执行解析脚本来自动生成。

## 目录结构说明

### 1. `0_coach_knowledge/` (知识源头)
- **作用**：存放原始的教练知识模板及解析脚本，是系统动作识别和诊断规则的单一事实来源 (SSOT)。
- **核心文件**：
  - `table_tennis_action_knowledge_v2.xlsx`：教练员维护技术知识的 Excel 模板。
  - `export_action_recognition_knowledge.mjs`：知识编译脚本。负责读取 Excel 文件，生成后端的 JSON 规则文件以及前端 `actions/` 目录下的 Markdown 文件。
  - `README.md`：专门针对教练知识录入模板的详细填写说明。

### 2. `actions/` (技术动作文档)
- **来源**：由 `0_coach_knowledge/export_action_recognition_knowledge.mjs` 脚本根据 Excel 内容**自动生成**。
- **作用**：存放各个技术动作（如正手攻球、反手拉球等）的详细说明文档，包括动作要领、常见问题与纠错建议、以及 VIP 核心秘诀等。
- **⚠️ 注意**：**请勿手动修改此目录下的任何 `.md` 文件**。每次执行解析脚本时，此目录会被清空并重新生成。

### 3. `equipment/` (器材知识)
- **来源**：手工维护（目前）。
- **作用**：存放乒乓球底板、胶皮等器材相关的知识文档（如 `rubbers.md` 等），供前端展示或聊天助手检索。

### 4. `tactics/` (战术知识)
- **来源**：手工维护（目前）。
- **作用**：存放比赛战术、得分逻辑等相关的知识文档（如 `direct_match_logic.md` 等）。

### 5. `chat_knowledge_index.json` (聊天助手知识索引)
- **如何生成**：
  - **技术动作类（actions）**：完全由 `export_action_recognition_knowledge.mjs` 解析脚本自动生成并覆盖。脚本会在每次执行时，提取 Excel 动作清单中的“中文名称”和“别名/关键词”，拼装成 `keywords` 数组，并关联对应的 `actions/*.md` 文件路径。
  - **其他类（战术 tactics、器材 equipment等）**：在 JSON 文件中手工维护。解析脚本在重写文件时，会自动保留那些 `category` 不是 `actions` 的手工条目。
- **系统如何使用**：
  - 前端 AI 聊天助手在接收到用户的提问时，会检索该索引文件中的 `keywords`。
  - 如果匹配命中（例如用户问“正手拉球怎么拉”，匹配到正手拉球相关的关键词），系统会根据 `file` 字段加载对应的 Markdown 知识文件（如 `actions/fh_loop.md`）。
  - 这些准确的专业内容会被作为上下文（Context）注入给大模型，从而让 AI 能够基于教练录入的标准动作要领和纠错建议来回答用户，避免 AI “胡编乱造”。
