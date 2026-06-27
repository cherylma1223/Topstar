# Phase 3 设计文档：知识库编译器与 SSOT 架构重构

> 目标：**将教练维护的 Excel 确立为全系统唯一真相源（Single Source of Truth），通过「知识编译器」一次编译、多处分发，彻底消灭关键词/动作映射散落、硬编码、手工双写的问题。**

## 更新日志

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-06-27 | 初始版本 | 基于关键词→技术动作映射散落问题分析，完成知识库编译器架构设计 |

---

## 目录

1. [背景](#1-背景)
2. [当前问题](#2-当前问题)
3. [设计目标](#3-设计目标)
4. [目标架构](#4-目标架构)
5. [知识编译器设计](#5-知识编译器设计)
6. [下游消费方改造](#6-下游消费方改造)
7. [Excel 模板升级](#7-excel-模板升级)
8. [文件更名与路径规范](#8-文件更名与路径规范)
9. [风险与缓解](#9-风险与缓解)

---

## 1. 背景

### 1.1 问题发现

项目中「关键词 → 技术动作 action_id」的映射关系散落在以下四处独立维护的数据源中：

| 数据源 | 文件 | 维护方式 | 消费方 |
|---|---|---|---|
| ① Excel | `0_coach_knowledge/table_tennis_action_knowledge_v2.xlsx` | 教练结构化填写 | 仅视频分析链路 |
| ② index.json | `client/src/assets/knowledge/index.json` | 开发者手工维护 | 对话知识检索 + 意图路由 |
| ③ 硬编码 JS | `server/scripts/normalize_pingpong_merged_tutorials.js` 的 `buildActionMatcher()` | 开发者硬编码 | 教程同步打标 |
| ④ 硬编码 TS | `server/orchestrator/handleChatEvent.ts` 的 `commonTerms` | 开发者硬编码 | 对话编排标签提取 |

### 1.2 业务影响

- Excel v2 中已有 13 个动作，但教程清洗脚本（数据源③）只认识 11 个，导致 `fh_flick`（正手挑打）和 `serve_nospin`（不转发球）相关教程**永远无法被打上标签**，教程推荐为空集。
- index.json（数据源②）的关键词与 Excel 存在漂移，缺少"霸王拧"等核心触发词，导致对话知识检索遗漏。
- index.json 中注册了 `fh_flick` 和 `serve_nospin` 两个条目，但其引用的 Markdown 文件在磁盘上**不存在**，knowledge loader 报错跳过。
- `actions/*.md`（对话知识正文）中的【常见问题】与 Excel 的 `诊断规则` Sheet 存在业务重合，教练需要双写维护。

---

## 2. 当前问题

### 2.1 映射散落：四源不同步

四处数据源各自独立，没有任何自动化机制保证它们之间的同步。每当教练在 Excel 中新增动作或修改别名，其余三处均无感知。

### 2.2 教程打标缺失

`buildActionMatcher()` 是一个纯硬编码的 JavaScript 函数，只包含 11 个动作和极少量的模式词（如 `bh_flick` 仅 4 个 patterns，而 Excel 中有 10 个 aliases）。大量教程视频因为描述中的关键词未被覆盖而打不上标签。

### 2.3 知识文档双写

`actions/*.md` 文档中的内容（动作要领、常见问题、训练建议、VIP 秘诀）由教练手写。但其中的「常见问题」和「训练建议」与 Excel 的 `诊断规则` Sheet 高度重合。教练新增一条纠错规则后，必须手动在 MD 文件中再写一遍，否则视频分析能诊断出的错误，对话场景却回答不出来。

### 2.4 索引文件命名歧义

`index.json` 名称过于通用，无法看出它是专门为对话场景设计的知识检索索引。

---

## 3. 设计目标

### 3.1 功能目标

1. **Excel 为唯一真相源**：全系统的技术动作清单、别名/关键词、纠错规则、教学内容统一由教练在 Excel 中维护。
2. **一次编译，多处分发**：运行一次知识编译器脚本，自动生成视频分析 JSON、别名映射 JSON、对话知识索引 JSON、对话知识 Markdown 文档四类产物。
3. **消灭所有硬编码**：代码中不再存在任何硬编码的关键词列表，全部改为动态读取编译产物。
4. **消灭文档双写**：`actions/*.md` 降级为纯粹的构建产物（Generated Artifact），教练不再需要手写 Markdown。

### 3.2 非目标

- 不改变 `equipment/`（器材）和 `tactics/`（战术）类知识条目的维护方式，它们仍保持 Markdown 手工维护。
- 不改变视频分析链路的工作逻辑（Pass 1 / 1.5 / 2），仅统一其上游数据源。
- 不引入 embedding 语义检索（留给后续阶段）。

---

## 4. 目标架构

### 4.1 数据流转全景图

```
┌────────────────────────────────────────────────────────────────────┐
│                     Excel v2（教练唯一真相源）                       │
│  Sheet: 动作清单 │ 识别线索 │ 混淆矩阵 │ 降级规则 │ 诊断规则          │
│  新增字段: 动作要领详细说明 │ VIP核心秘诀                             │
└────────────────────────────┬───────────────────────────────────────┘
                             │ 运行: 知识编译器 (export_script.mjs)
                             ▼
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐
  │ 产物 1 & 2   │  │ 产物 3       │  │ 产物 4 & 5          │
  │ 视觉规则 JSON │  │ 别名映射 JSON│  │ 对话知识索引 + MD    │
  │ 诊断规则 JSON │  │              │  │                     │
  └──────┬───────┘  └──────┬───────┘  └──────────┬──────────┘
         │                 │                     │
         ▼                 ▼                     ▼
  视频分析引擎      教程打标脚本 +         对话知识检索 (RAG) +
  (Pass 1.5/2)     对话编排标签提取       意图路由白名单
```

### 4.2 编译器产物清单

| 产物 | 输出路径 | 消费方 | 来源 Sheet |
|---|---|---|---|
| `action_video_analysis_knowledge.json` | `server/data/` | 视频分析 `analysisKnowledgeLoader.ts` | 动作清单 + 识别线索 + 混淆矩阵 + 降级规则 |
| `action_diagnosis_rules.json` | `server/data/` | 视频分析 `analysisKnowledgeLoader.ts` | 诊断规则 |
| `action_aliases.json` | `server/data/` | `normalize...js` + `handleChatEvent.ts` | 动作清单（id + 别名/关键词列 + 中文名称） |
| `chat_knowledge_index.json` | `client/src/assets/knowledge/` | `knowledge/loader.ts` + `intentRouter.ts` | 动作清单（id + 别名/关键词列） |
| `actions/*.md` | `client/src/assets/knowledge/actions/` | `knowledge/loader.ts` → LLM 上下文 | 动作清单 + 诊断规则 + 新增的两个字段 |

---

## 5. 知识编译器设计

### 5.1 编译器定位

当前的 `export_action_recognition_knowledge.mjs` 仅导出视频分析相关的 2 个 JSON 文件。Phase 3 将其升级为**全局知识编译器**，负责从 Excel 一次性编译出上述 5 类产物。

### 5.2 编译流程

```
Step 1: 读取 Excel
  ├─ 解析 动作清单 Sheet → actionsMap
  ├─ 解析 识别线索 Sheet → 填充 actionsMap.positive_cues / negative_cues
  ├─ 解析 混淆矩阵 Sheet → confusionMatrix
  ├─ 解析 降级规则 Sheet → downgradeRules
  └─ 解析 诊断规则 Sheet → diagnosisRules

Step 2: 写入视觉规则产物（已有逻辑，保持不变）
  ├─ → server/data/action_video_analysis_knowledge.json
  └─ → server/data/action_diagnosis_rules.json

Step 3: 写入别名映射（新增）
  └─ → server/data/action_aliases.json

Step 4: 写入对话知识索引（新增）
  ├─ 读取现有 chat_knowledge_index.json
  ├─ 保留 equipment / tactics 条目不变
  ├─ 清空 actions 类条目，根据 actionsMap 重新生成
  └─ → client/src/assets/knowledge/chat_knowledge_index.json

Step 5: 生成对话知识 Markdown 文档（新增）
  ├─ 遍历 actionsMap 中的每个动作
  ├─ 组装 Markdown 正文：
  │   ├─ 【动作要领】← 动作清单 Sheet 的「动作要领详细说明」列
  │   ├─ 【常见问题】← 诊断规则 Sheet 筛选当前 action_id 的所有规则
  │   ├─ 【训练建议】← 诊断规则 Sheet 的 advice 字段
  │   └─ 【核心秘诀】← 动作清单 Sheet 的「VIP核心秘诀」列（选填）
  ├─ 在文件头部插入自动生成警告注释
  └─ → client/src/assets/knowledge/actions/{action_id}.md
```

### 5.3 `action_aliases.json` 产物格式

```json
{
  "schema_version": "v1",
  "generated_from": "table_tennis_action_knowledge_v2.xlsx",
  "generated_at": "2026-06-27T...",
  "actions": [
    {
      "id": "bh_flick",
      "title": "反手拧拉",
      "aliases": ["拧拉", "反手拧", "霸王拧", "台内拧", "拧拉技术", "张继科招牌技术", "反手台内", "内扣", "架肘", "顶肘"]
    }
  ]
}
```

### 5.4 自动生成 Markdown 格式规范

每个生成的 `actions/{action_id}.md` 文件遵循以下模板：

```markdown
<!-- ⚠️ 本文件由知识编译器自动生成，请勿手动修改。 -->
<!-- 源文件: table_tennis_action_knowledge_v2.xlsx -->
<!-- 生成时间: 2026-06-27T10:00:00Z -->

# {中文名称}

### 【动作要领】
{动作要领详细说明}

### 【常见问题与纠错建议库】
- **技术问题：{issue_1_problem}**
  - **视觉证据**：{issue_1_evidence}
  - **训练建议**：{issue_1_advice}

- **技术问题：{issue_2_problem}**
  - **视觉证据**：{issue_2_evidence}
  - **训练建议**：{issue_2_advice}

### 【核心秘诀】
{VIP核心秘诀内容}
```

> [!IMPORTANT]
> 如果 Excel 中某动作的「VIP核心秘诀」列为空，则生成时不输出【核心秘诀】段落，避免空段影响 LLM 的输出结构。

---

## 6. 下游消费方改造

### 6.1 教程清洗脚本 (`normalize_pingpong_merged_tutorials.js`)

**当前状态**：`buildActionMatcher()` 函数硬编码了 11 个动作的关键词列表。

**改造方案**：
- 删除 `buildActionMatcher()` 函数。
- 脚本启动时读取 `server/data/action_aliases.json`。
- 若 JSON 文件不存在，打印明确错误信息并 `process.exit(1)`，不做静默降级。
- 使用 JSON 中的 `aliases` 列表动态构建匹配规则。

### 6.2 对话编排层 (`handleChatEvent.ts`)

**当前状态**：L225 硬编码了一个 `commonTerms` 数组。

**改造方案**：
- 删除 `commonTerms` 硬编码。
- 在服务端启动时从 `action_aliases.json` 加载所有 aliases 到内存（可通过 `knowledge/loader.ts` 提供统一的 `getActionAliasMap()` 接口）。
- 运行时从内存中获取所有别名词汇作为教程搜索标签。

### 6.3 知识加载器 (`knowledge/loader.ts`)

**改造方案**：
- 将 `index.json` 的文件名引用更新为 `chat_knowledge_index.json`。
- 新增 `getActionAliasMap(): Map<string, string[]>` 方法，从 `action_aliases.json` 加载数据，供 `handleChatEvent.ts` 和 `normalize` 脚本使用。

### 6.4 知识匹配器 (`knowledge/matcher.ts`)

无需改动。它从 `knowledgeStore`（由 loader 加载）中读取 keywords，只要 loader 读取的 `chat_knowledge_index.json` 被编译器正确同步，matcher 自动受益。

### 6.5 意图路由器 (`intent/intentRouter.ts`)

无需改动。它调用 `getActionIds()` 获取候选动作列表，该函数从 `chat_knowledge_index.json` 中提取，编译器同步后自动覆盖。

---

## 7. Excel 模板升级

### 7.1 `动作清单` Sheet 新增字段

在现有 `table_tennis_action_knowledge_v2.xlsx` 的 `动作清单` Sheet 中追加以下两列：

| 新增字段名 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `动作要领详细说明` | 多行文本 | 必填 | 对应原 MD 中的【动作要领】，长篇散文式教学，LLM 对话场景专用 |
| `VIP核心秘诀` | 多行文本 | 选填 | 对应原 MD 中的【核心秘诀】，仅 VIP 用户可见的高级技巧 |

### 7.2 数据迁移

升级 Excel 模板时，需要将现有 `actions/*.md` 文件中的【动作要领】和【核心秘诀】内容**反向回填**到 Excel 的新增列中，确保迁移过程不丢失教练已编写的内容。

> [!IMPORTANT]
> 反向回填应在编译器开发完成前手动执行一次。回填完成并验证后，`actions/*.md` 即可被编译器覆写。

---

## 8. 文件更名与路径规范

### 8.1 更名

| 原文件名 | 新文件名 | 原因 |
|---|---|---|
| `index.json` | `chat_knowledge_index.json` | 原名太通用，无法体现其仅服务于对话知识检索的定位 |

### 8.2 全局引用更新

以下文件中的 `index.json` 引用需同步更新：

| 文件 | 更新内容 |
|---|---|
| `server/knowledge/loader.ts` | `const indexPath = path.join(KNOWLEDGE_DIR, 'chat_knowledge_index.json')` |
| `CLAUDE.md` | 更新知识库描述中的文件名引用 |
| 总设计文档 v6 | §4.1 中的 `index.json` 引用更新 |

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Excel 中「动作要领详细说明」列长文本超出 Excel 单元格易用性上限 | 教练填写体验下降 | 在 Excel 的 `填写说明` Sheet 中加入多行文本填写指导（Alt+Enter 换行）；或后续迁移到 Google Sheets / Notion，编译器适配新格式 |
| 反向回填 MD → Excel 过程中内容丢失或格式损坏 | 教练知识内容回退 | 回填前备份所有现有 MD 文件；回填后运行编译器生成新 MD，与原始 MD 做 diff 对比验证 |
| 编译器 Bug 导致生成的 MD 文件缺段或格式错误 | 对话知识检索质量下降 | 编译器增加输出校验步骤：检查每个 MD 文件是否包含必要段落（【动作要领】、【常见问题与纠错建议库】） |
| 编译器产物未及时提交版本控制 | 线上与开发不一致 | 在 README 和 CLAUDE.md 中明确记录"修改 Excel 后须运行编译器并提交产物" |

---
