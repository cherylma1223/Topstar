# 乒乓球技术识别准确度优化整合方案 (V2.5)

## 更新日志

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-06-07 | 补充更新日志 | 记录本文档当前覆盖范围和后续需要同步补充的任务，方便和设计文档 v2 对照。 |
| 2026-06-07 | 确认已覆盖主干开发任务 | 本文档已覆盖 Excel -> JSON、识别知识加载器、Pass 1.5 `techniqueClassifier`、`recognitionDecision`、`handleAnalysisJob.ts` 改造、视频分析 E2E 验证等主干任务。 |
| 2026-06-07 | 标记待补充任务 | 需要在后续正文中进一步补充：Excel 清洗任务、严格校验细则、报告字段扩展、前端展示任务，以及弱化 Markdown fallback 的生产定位。 |
| 2026-06-07 | 对齐最新知识源边界 | 设计文档已明确 `actions/*.md` 是用户教学输出内容源，Excel/JSON 是视频识别规则源；implementation plan 中的 Markdown fallback 需要按此边界重新收敛。 |
| 2026-06-07 | **同步 V2 Excel 审核结果** | 教练已提供包含 13 个动作的 v2 Excel。更新文件引用，并将 Markdown Fallback 从“防卡死机制”降级为“开发调试机制”。增加任务：同步 `fh_flick`、`serve_nospin` 到 index.json。 |

---

## 方案设计背景

在 Phase 2-A 视频分析功能的基础上，为了从根本上解决技术动作识别“一错百错”的级联故障，我们需要重构视频分析 Pipeline。

本方案深度融合了**我方的 Markdown 知识检索思路**与**第三方的独立分类关卡（Pass 1.5）及置信度降级机制**，旨在设计一个高可信度、可维护且具备平滑过渡能力的乒乓球动作视频分析架构。

---

## 方案核心设计对比

| 维度 | 我方原始方案 | 第三方 v2 设计 | **融合整合方案 (本方案)** |
|---|---|---|---|
| **识别与诊断解耦** | 在 Pass 2 中同时进行识别与诊断，在 prompt 中注入规则。 | **彻底解耦**。新增独立的 Pass 1.5 关卡只作分类，Pass 2 只作基于该动作的诊断。 | **采纳第三方设计**。执行 Pass 1.5 独立识别，大幅减轻 Pass 2 认知负载，防止技术猜错导致诊断全错。 |
| **规则数据源** | 直接读取并解析现有的 `actions/*.md` 教学知识库。 | 引入 Excel 模板 (`table_tennis_action_knowledge_v2.xlsx`)，由教练填写识别/混淆/诊断规则并转成 JSON。 | **双轨制运行，以 Excel JSON 为主**：<br>1. **首选（生产环境）**：加载 Excel 生成的识别 JSON 规则。<br>2. **备选（开发调试）**：作为开发调试时的 fallback 机制，若 JSON 加载失败则从 `actions/*.md` 提取特征，但不作为生产环境的主链路。 |
| **可信度与容错** | 依靠 Schema 对 ID 进行强约束。 | 引入置信度数值、Top 2 候选、混淆矩阵、视频可见度影响，设计 `confirmed` / `tentative` / `unknown` / `ambiguous` 决策树。 | **采纳第三方设计**。若置信度低于 0.55 或主动作 ID 为 `unknown`，Pass 2 将自动降级为“拍摄建议报告”，不予虚假诊断，保护产品专业形象。 |
| **代码结构** | 全写在 `handleAnalysisJob.ts` 中。 | 建议在 `server/` 新增 `videoAnalysis/` 目录进行模块化拆分。 | **采纳模块化拆分**。将知识库加载、Pass 1.5 识别、降级决策、Pass 2 诊断逻辑彻底解耦，易于维护 and 扩展。 |

---

## 已确定的设计决策 (Resolved Design Decisions)

1. **开发调试 Fallback 机制**：采用“Excel JSON 为主，Markdown 解析作为开发兜底”的机制。由于 V2 Excel（13个动作）已就绪，系统优先加载其生成的 JSON。仅在调试环境 JSON 缺失时，才从 `client/src/assets/knowledge/actions/*.md` 中提取特征作为 fallback，防止开发流程阻断。
2. **Excel 读取依赖库**：在 `server/package.json` 中安装标准的 `xlsx` (SheetJS) 依赖，用于开发 Excel -> JSON 的解析编译脚本。
3. **多动作视频处理策略**：
   - **短期 (Phase 2-A)**：以**单一主导动作**为诊断核心，通过 Pass 1.5 提取 `primary_action_id` 进行针对性诊断，次要动作仅记录在 `top_candidates` 中。
   - **长期 (演进)**：支持**组合/衔接技术**（如正反手摆速、摆短接反手拉）。只需在 Excel 中将衔接动作注册为独立的 `action_id` 并编写特定识别与诊断规则，无需修改 Pipeline 代码。

---

## Proposed Changes

### 组件 1：编译与知识库加载层

#### [NEW] [export_action_recognition_knowledge.mjs](file:///Users/yingdongma/Documents/Dev/projects/Topstar/client/src/assets/knowledge/0_coach_knowledge/export_action_recognition_knowledge.mjs)
- 读取教练填写的 Excel 模板 `table_tennis_action_knowledge_v2.xlsx`。
- 校验合法性（如 `action_id` 必须在 `index.json` 中，权重范围合理等）。
- 输出两个 JSON 文件：
  1. [action_video_analysis_knowledge.json](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/data/action_video_analysis_knowledge.json)（识别与混淆降级规则）
  2. [action_diagnosis_rules.json](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/data/action_diagnosis_rules.json)（诊断规则映射）

#### [NEW] [analysisKnowledgeLoader.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/videoAnalysis/analysisKnowledgeLoader.ts)
- 实现知识统一加载器：
  1. 优先加载 `server/data/action_video_analysis_knowledge.json` 和 `action_diagnosis_rules.json`。
  2. 若上述文件不存在或加载失败，作为开发调试使用 **Markdown Fallback Parser**，动态解析 `client/src/assets/knowledge/actions/*.md`。
- 提供 `getRecognitionRules()`、`getDiagnosisRules()` 和 `getActionIds()` 接口。

#### [MODIFY] 同步新知识到基础库
- **任务**：V2 Excel 新增了 `fh_flick`（正手挑打）和 `serve_nospin`（不转发球）。
- 修改 `client/src/assets/knowledge/index.json`，补充这两个新动作的条目、标题和关键词。
- 在 `client/src/assets/knowledge/actions/` 目录下创建 `fh_flick.md` 和 `serve_nospin.md` 初稿（可根据 Excel 中的定义和规则填充）。

---

### 组件 2：视频分析 Pipeline 核心重构

#### 多动作/组合动作处理策略 (Multi-Action Strategy)
- **短期 (Phase 2-A)**：**仅识别并诊断主导动作 (Single Primary Action Focus)**。
  - 在 Pass 1.5 中，模型会输出视频中所有有效片段对应的 `action_id`，但会归纳出一个占比最高/置信度最高的 `primary_action_id`。
  - 次要动作（如发球后抢攻中的发球）将仅记录在 `top_candidates` 候选列表中。
  - Pass 2 诊断仅针对主导动作 `primary_action_id` 进行高精度诊断，以保持反馈的聚焦。
- **长期 (演进)**：**支持组合/衔接技术诊断 (Combo Actions Support)**。
  - 针对“正反手摆速” (`fh_bh_transition`)、“摆短接反手拉” (`push_to_bh_loop`)、“反手拧拉接快撕” (`bh_flick_to_counter`) 等复杂衔接技术。
  - 在 `index.json` 中将其注册为独立的 `action_id`，并在 Excel 中为其单独编写【识别线索】（如“两拍之间重心转移与步法移动”）和【诊断规则】。
  - 系统无需重构 Pipeline，仅通过在知识库中增加复合 `action_id` 及其规则，即可支持组合动作的整段识别与诊断。

#### [NEW] [techniqueClassifier.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/videoAnalysis/techniqueClassifier.ts)
- 执行 Pass 1.5 `Technique Classification`。
- 向 Gemini 传入视频有效片段、合法 `action_id` 集合及对应的识别规则（正向/反向线索、混淆特征）。
- 使用低 Temperature (0.0)，通过 Schema 强约束输出，格式见下文 `TechniqueClassificationResult`。
- 模型会评估每个片段并汇聚出 `primary_action_id`（主导动作 ID）。

#### [NEW] [recognitionDecision.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/videoAnalysis/recognitionDecision.ts)
- 实现置信度决策树：
  - 高置信度 (`overall_confidence >= 0.75` 且 top1-top2 差值 `>= 0.15`)：确定该动作，进入针对性诊断。
  - 中置信度 (`0.55 <= overall_confidence < 0.75` 或 top1-top2 差值 `< 0.15` 导致易混淆)：判定为“疑似”（`tentative` 或 `ambiguous`），进行保守诊断。
  - 低置信度 (`overall_confidence < 0.55` 或 `primary_action_id === 'unknown'`)：进入降级流，不进行强诊断。

#### [MODIFY] [handleAnalysisJob.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/orchestrator/handleAnalysisJob.ts)
- 重构 `uploadAndAnalyzeVideo` 执行流：
  1. Pass 1 找出 `validSegments`。
  2. 调用 `classifyTechnique` 执行 Pass 1.5 识别。
  3. 通过 `recognitionDecision` 得到分析模式（`confirmed`, `tentative`, `unknown` 等）。
  4. 构造 Pass 2 Prompt 并约束输出：
     - 若为 `unknown`，Prompt 要求模型：禁止强猜诊断；只分析画面质量（不可见原因），并给出具体的“拍摄改进建议”；
     - 若为已确认或疑似动作，Prompt 指导模型：聚焦分析该 `primary_action_id` 的动作规范，不要偏离；
  5. 教程推荐逻辑：只使用通过校验的 `primary_action_id`。如果为 `unknown` 则不推荐具体动作教程。
  6. 将 Pass 1.5 的识别置信度、核心证据等元数据写入最终的 Report Payload，以便前端开发扩展。

---

## Verification Plan

### 1. 自动化校验与解析测试
- 编写测试脚本（在 `server/scripts/testExcelParser.ts` 中），测试 Excel 解析、校验合法性、生成 JSON 文件的能力。
- 验证当 JSON 文件缺失时，Markdown Fallback 解析器是否能成功解析 `actions/*.md` 并生成结构相同的临时规则。

### 2. E2E 视频分析质量测试
- 提供以下典型视频进行回归测试，并与 v1 输出对比：
  - **正手拉球标准视频**：验证识别结果为 `fh_loop`，置信度高，诊断内容指向蹬转/发力问题，且正确推荐“正手拉球”教程。
  - **画质低劣/遮挡严重视频**：验证识别结果为 `unknown`，系统顺利降级，Pass 2 输出“视频不可见分析”，且没有生成虚假动作诊断，也不盲目推荐教程。
  - **易混淆视频（如拨球与拉球界限模糊）**：验证置信度低于 0.75，系统决策判定为疑似（`tentative`），诊断语气为“疑似反手拨球”。

### 3. 类型编译检查
- 运行类型检查，确保改造后的模块能顺利通过 TypeScript 编译：
  ```bash
  cd server && npx tsc --noEmit
  ```
