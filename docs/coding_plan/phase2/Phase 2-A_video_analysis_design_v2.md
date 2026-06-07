# Phase 2-A 设计文档 v2：视频分析技术识别准确度优化

> 目标：在 Phase 2-A 已完成“视频上传 + 异步任务 + Gemini 多模态分析”的基础上，重点优化乒乓球技术动作识别准确度。核心原则是：**不要让诊断模型顺手猜技术；先用受约束、可验证、可降级的技术识别关卡确认 action_id，再进入诊断和教程推荐。**

---

## 更新日志

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-06-07 | 更新当前 Excel 填写状态 | 补充 `table_tennis_action_knowledge_v1.xlsx` 的审查结果：11 个动作、44 条识别线索、8 条混淆规则、3 条降级规则、29 条诊断规则。 |
| 2026-06-07 | 增加规则质量门槛 | 明确进入工程实现前需要修正 `followup` 非法 phase、清理 `🐧不确定 / 需要教练确认 / 示例`、补充降级规则、补齐 `receive` 混淆矩阵、增强发球类规则。 |
| 2026-06-07 | 明确 Markdown 与 Excel 边界 | 将 `actions/*.md` 明确为用户教学输出内容源，不作为正式视频识别规则来源；视频识别以 Excel 转换出的结构化 JSON 为准。 |
| 2026-06-07 | 强化 Excel -> JSON 校验要求 | 补充 phase / weight / priority / rule_type 枚举校验、重复 `issue_id` 校验、重复混淆 pair 校验、未确认标记 strict 检查。 |
| 2026-06-07 | 更新分阶段计划 | 将“请教练填写 3-5 个核心动作”改为“教练已填 11 个动作，下一步是清洗和补强”。 |
| 2026-06-07 | **v2 Excel 审核通过** | 教练已提交 `table_tennis_action_knowledge_v2.xlsx`：13 个动作（+`fh_flick`/`serve_nospin`）、54 条识别线索、17 对混淆矩阵、13 条降级规则、35 条诊断规则。v1 中标注的质量门槛问题（非法 phase、降级规则偏少、`receive` 缺混淆矩阵等）已在 v2 中基本解决。知识数据已达到启动全链路工程开发的质量标准。 |
| 2026-06-07 | 更新知识源文件引用 | 全文将 Excel 数据源引用从 `_v1.xlsx` 更新为 `_v2.xlsx`；同步标记需要新增 `fh_flick`、`serve_nospin` 到 `index.json` 和 `actions/*.md`。 |
| 2026-06-07 | 更新 Markdown fallback 定位 | 由于 v2 Excel 已全面覆盖 13 个动作的识别/诊断规则，Markdown fallback 降级为“开发调试用途”，不再作为生产环境的必要保障路径。 |

---

## 1. 背景

Phase 2-A v1 已经把视频分析从前端 mock 推进到真实后端任务：

- 前端上传视频到服务端。
- 后端创建 `analysis_jobs`。
- Worker 异步处理任务。
- 视频上传到 Gemini Files API。
- Pass 1 识别有效乒乓球片段。
- Pass 2 对有效片段生成结构化报告。

当前实现集中在：

- `server/orchestrator/handleAnalysisJob.ts`
- `server/jobs/analysisWorker.ts`
- `server/routes/v2.ts`
- `client/components/AnalysisReportCard.tsx`

但实际使用中发现：**技术动作识别是最关键也最容易出错的一步**。一旦把“反手拨球”识别成“反手拉球”，或者把“正手攻球”识别成“正手拉球”，后续诊断、训练建议、教程推荐都会被带偏。

因此 v2 的重点不是重新设计任务系统，而是补强视频分析链路中的“技术识别层”。

---

## 2. 当前问题

### 2.1 Pass 2 同时承担识别和诊断

当前 `handleAnalysisJob.ts` 的技术分析流程是：

```text
Pass 1：识别有效片段
Pass 2：直接生成技术诊断报告
```

Pass 2 prompt 大致要求模型：

```text
请分析这段视频中以下时间段的技术动作。
对有效片段中的技术动作进行诊断，指出问题并给出改进建议。
```

这会让模型在同一步里完成：

- 判断是什么技术。
- 判断动作问题。
- 生成训练建议。
- 输出 `action_ids_detected`。

这个设计会导致“第一步猜错，后面全错”。

### 2.2 技术识别是开放式猜测

当前 Pass 2 虽然返回 `action_ids_detected`，但 prompt 没有强约束：

- 可选 action_id 集合没有完整注入。
- 不要求给出识别证据。
- 不要求给出置信度。
- 不要求输出 top candidates。
- 不要求在证据不足时返回 `unknown`。
- 不要求处理易混淆动作。

结果是模型容易根据语义印象直接生成技术名，而不是按教练定义的视觉规则判断。

### 2.3 现有 Markdown 知识更偏“用户教学输出”

当前运行时知识库来自：

```text
client/src/assets/knowledge/
  index.json
  actions/*.md
  tactics/*.md
  equipment/*.md
```

服务端加载逻辑在：

```text
server/knowledge/loader.ts
```

其中 `actions/*.md` 是真正会被聊天回答使用的教学内容，适合产品经理和教练共同维护：

- 动作要领
- 常见问题与纠错建议
- 核心秘诀

但它们缺少视频识别所需的结构化信息：

- 视觉识别线索
- 易混淆动作边界
- 不可判断 / 降级规则
- 诊断证据映射
- 权重和优先级

### 2.4 教练知识输入方式需要区分两类知识

本轮讨论后明确两类知识边界：

| 知识类型 | 维护方式 | 消费方 |
|---|---|---|
| 用户教学内容 | `client/src/assets/knowledge/actions/*.md`，由产品经理 + 教练维护 | 聊天回答、知识检索、用户展示 |
| 视频识别/诊断规则 | `client/src/assets/knowledge/0_coach_knowledge/*.xlsx`，由教练结构化填写 | 后续生成视频识别 JSON / 诊断 JSON |

短期内不把 Excel 自动生成 Markdown，避免把“教学表达”和“视觉判别规则”过早绑死。

---

## 3. 设计目标

### 3.1 功能目标

1. **新增独立技术识别关卡**  
   在 Pass 1 有效片段识别之后、Pass 2 诊断之前，新增 Pass 1.5：`Technique Classification`。

2. **让模型只能从合法 action_id 中选择**  
   技术识别只能输出 `client/src/assets/knowledge/index.json` 中已有的动作 ID，或输出 `unknown`。

3. **引入识别证据和置信度**  
   每个识别结果必须包含：
   - `action_id`
   - `confidence`
   - `top_candidates`
   - `evidence`
   - `contradictions`
   - `visibility_issues`

4. **识别不稳时不进入强诊断**  
   对低置信度或易混淆结果，报告要明确降级，不生成过度确定的技术诊断。

5. **用教练结构化知识补强模型判断**  
   由教练通过 Excel 模板维护：
   - 识别线索
   - 混淆矩阵
   - 降级规则
   - 诊断规则

6. **保持现有用户教学 Markdown 不变**  
   `actions/*.md` 暂时仍作为用户输出内容源，不由 Excel 生成。

### 3.2 非目标

本阶段不做：

- 不训练自有 CV 模型。
- 不引入姿态估计 / 球拍检测 / 球轨迹检测作为硬依赖。
- 不让 Excel 自动生成 `actions/*.md`。
- 不改变教程推荐主链路，教程继续由 `tutorial_videos` + `recommendTutorials()` 自动推荐。
- 不重构整个 `analysis_jobs` 任务系统。

---

## 4. 目标架构

### 4.1 v2 视频分析流程

```text
用户上传视频
  ↓
创建 analysis_jobs
  ↓
上传到 Gemini Files API
  ↓
Pass 1：有效片段识别
  ↓
Pass 1.5：技术动作识别
  - 输入：有效片段 + action 候选集 + 教练识别规则
  - 输出：primary_action_id / confidence / evidence / top_candidates
  ↓
置信度策略判断
  ├─ 高置信度：进入指定 action_id 的诊断
  ├─ 中置信度：进入保守诊断，报告标记“疑似”
  └─ 低置信度：不做强技术诊断，提示视频条件不足
  ↓
Pass 2：按已确认/疑似 action_id 诊断
  ↓
教程推荐
  - 只使用通过校验的 action_id
  ↓
存储 AnalysisReportPayload
  ↓
前端渲染报告
```

### 4.2 当前 v1 与 v2 对比

| 环节 | v1 当前实现 | v2 优化设计 |
|---|---|---|
| 有效片段识别 | Pass 1 | 保留 |
| 技术识别 | Pass 2 里顺手判断 | 新增 Pass 1.5 独立识别 |
| action_id 约束 | 弱约束，模型可漂移 | 只能从合法枚举或 unknown 选择 |
| 识别证据 | 无 | 必须输出 evidence / contradictions |
| 置信度 | 无 | 必须输出 confidence / top_candidates |
| 混淆处理 | 无 | 使用教练维护的混淆矩阵 |
| 降级策略 | 无 | 低置信度时不强诊断 |
| 教程推荐 | 使用模型输出的 `action_ids_detected` | 使用校验后的 `primary_action_id` |

---

## 5. 知识库设计

### 5.1 运行时教学知识

现有教学知识继续保留：

```text
client/src/assets/knowledge/actions/*.md
client/src/assets/knowledge/index.json
```

用途：

- 用户问答中的专业知识上下文。
- 动作要领输出。
- 常见问题纠错建议。
- 核心秘诀。

维护方式：

- 产品经理和专业教练共同维护。
- 重点关注表达质量、用户理解成本、教学结构。

短期规则：

- 不由 Excel 自动生成。
- 不作为正式视频识别规则来源。视频识别应以 `0_coach_knowledge/*.xlsx` 转换出的结构化 JSON 为准。
- 不在视频识别 prompt 中整篇塞入，只可按需摘取动作标题、关键词或少量要点。

### 5.2 教练结构化识别知识

新增教练结构化模板已放在：

```text
client/src/assets/knowledge/0_coach_knowledge/
  README.md

  table_tennis_action_knowledge_v1.xlsx   ← 初始版本（11 个动作，已归档）
  table_tennis_action_knowledge_v2.xlsx   ← 当前版本（13 个动作，生产使用）
```

用途：

- 收集专业教练对视频识别和诊断的结构化判断规则。
- 后续由脚本转换成服务端可读取的 JSON。

当前 Excel 主要 Sheet：

| Sheet | 用途 |
|---|---|
| `填写说明` | 给教练的填写顺序和基础说明 |
| `数据字典` | 解释所有字段含义、范例和常见误填 |
| `动作清单` | action_id、中文名、别名、定义、适用场景、排除边界 |
| `识别线索` | 正向/反向视觉线索、动作阶段、权重 |
| `混淆矩阵` | 相似动作的关键区别和低置信度处理 |
| `降级规则` | 视频看不清或证据缺失时的处理策略 |
| `诊断规则` | 视觉证据到技术问题和训练建议的映射 |
| `枚举值` | 下拉框和脚本使用的枚举 |

### 5.3 Excel 与 Markdown 的边界

本阶段不把 Excel 作为所有知识的唯一源。

明确边界：

```text
actions/*.md
  = 用户教学输出内容源
  = 产品经理 + 教练维护

0_coach_knowledge/*.xlsx
  = 视频识别/诊断规则源
  = 教练结构化填写
```

未来如果要统一源文件，可另立专项方案：

```text
Excel -> actions/*.md + recognition JSON + diagnosis JSON + index.json
```

但本阶段不推进，避免影响现有聊天输出。

### 5.4 后续生成 JSON

后续需要新增转换脚本，例如：

```text
client/src/assets/knowledge/0_coach_knowledge/export_action_recognition_knowledge.mjs
```

输入：

```text
table_tennis_action_knowledge_v2.xlsx
```

输出建议：

```text
server/data/action_recognition_knowledge.json
server/data/action_diagnosis_rules.json
```

或者前期先合并为：

```text
server/data/action_video_analysis_knowledge.json
```

### 5.5 当前 Excel 填写状态与质量门槛

截至 2026-06-07，教练已提交两个版本：

```text
client/src/assets/knowledge/0_coach_knowledge/table_tennis_action_knowledge_v1.xlsx  ← 已归档
client/src/assets/knowledge/0_coach_knowledge/table_tennis_action_knowledge_v2.xlsx  ← 当前版本
```

#### V1 → V2 增量对比

| 维度 | V1 | V2 | 增量 |
|------|----|----|------|
| 动作清单 | 11 个动作 | **13 个动作** | +`fh_flick`(正手挑打), +`serve_nospin`(不转发球) |
| 识别线索 | 44 条 | **54 条** | +10 条（挑打 5 条 + 不转发球 4 条 + 下旋假动作 1 条） |
| 混淆矩阵 | 8 对 | **17 对** | +9 对（含挑打 vs 攻球/拉球/搓球，不转 vs 下旋等） |
| 降级规则 | 3 条 | **13 条** | +10 条（全局视角/帧率/球可见性 + 动作专属降级） |
| 诊断规则 | 29 条 | **35 条** | +6 条（挑打 3 条 + 不转发球 2 条 + 拉球击球点 1 条） |

#### V2 审查结论

- ✅ `动作清单` 覆盖 13 个 active action_id，每个动作的“一句话定义”、“适用来球/场景”、“不属于本技术的情况”均已填写完整。
- ✅ `识别线索` 共 54 条，每个动作至少 3 条 positive + 1 条 negative，覆盖 preparation → contact → follow_through 全阶段，权重标注合理。
- ✅ `混淆矩阵` 共 17 对，覆盖所有高频易混淆场景（正反手攻/拉/拨、拧/挑、发球类型互混、搓球 vs 挑打等），且大部分已填写“示例提示词片段”。
- ✅ `降级规则` 共 13 条（6 条全局 + 7 条动作专属），覆盖视角（正后方/正面）、帧率、可见性、球台可见性、球可见性、身体遮挡以及发球类动作专属降级。
- ✅ `诊断规则` 共 35 条，每个动作 2–4 条，视觉证据→问题描述→训练建议三列均有具体可执行内容。
- ✅ 必填字段无缺失，action_id 引用无非法项，`issue_id` 无重复。

#### V1 遗留问题在 V2 中的解决状态

| V1 问题 | V2 状态 |
|---------|--------|
| `识别线索` 中存在非法 phase `followup` | ✅ 已修正为 `follow_through` 等合法枚举 |
| `降级规则` 偏少（仅 3 条） | ✅ 已扩充到 13 条，覆盖全局和动作专属 |
| `receive` 缺少混淆矩阵 | ✅ 已补充 receive↔bh_drive、receive↔fh_flick 两对 |
| 发球类规则偏薄 | ✅ 已补充 serve_nospin↔serve_spin 混淆对 + 发球专属降级规则 |
| `🐧不确定`/`示例` 等残留 | ⚠️ 部分诊断规则备注栏仍有“示例”标记，但均为可用内容，不影响 JSON 生成 |

#### 结论

**V2 Excel 知识数据已达到启动全链路工程开发的质量标准，不再阻塞任何开发任务。** 后续 Excel → JSON 解析脚本中应保留备注栏“示例”标记的兼容处理（非阻塞性 warning），但不需要再做教练侧的清洗轮次。

#### 待同步：index.json 和 actions/*.md

V2 新增的 `fh_flick`（正手挑打）和 `serve_nospin`（不转发球）需要同步到：

1. `client/src/assets/knowledge/index.json` — 添加对应条目和关键词。
2. `client/src/assets/knowledge/actions/` — 创建 `fh_flick.md` 和 `serve_nospin.md` 教学内容文件。

这两个动作在 Excel 的动作清单、识别线索、混淆矩阵、诊断规则中已有完整结构化数据，教学 Markdown 可参考 Excel 中的“一句话定义”和“诊断规则”生成初稿。

---

## 6. 数据结构设计

### 6.1 技术识别知识 JSON

建议生成结构：

```json
{
  "schema_version": "v1",
  "actions": [
    {
      "id": "bh_drive",
      "title": "反手拨球",
      "aliases": ["反手拨", "反手快拨", "拨球"],
      "definition": "近台反手位处理上旋或不转来球的基础进攻/衔接技术，以前臂向前弹击为主，动作小、节奏快。",
      "scope": {
        "scenario": "近台反手位；来球多为上旋、不转或轻微下旋；常用于相持衔接、快节奏压反手。",
        "exclusions": [
          "如果来球明显出台且引拍更充分、向上摩擦和随挥更明显，更可能是反手拉球。",
          "如果是台内短球且手腕内扣外展明显，更可能是反手拧拉。"
        ]
      },
      "positive_cues": [
        {
          "phase": "swing",
          "cue": "前臂以肘为轴向前弹出，挥拍幅度小",
          "weight": 3,
          "why": "区分反手拨球和反手拉球的核心线索",
          "missing_policy": "降低置信度，不要强判为反手拨球"
        }
      ],
      "negative_cues": [
        {
          "phase": "backswing",
          "cue": "引拍明显更低且向上摩擦充分",
          "weight": 3,
          "suggests": "bh_loop"
        }
      ]
    }
  ],
  "confusion_matrix": [
    {
      "action_id": "bh_drive",
      "confusable_with": "bh_loop",
      "key_difference": "拨球动作小且向前多；反手拉球引拍更充分、向上摩擦更多",
      "required_visible_info": ["引拍幅度", "挥拍方向", "触球阶段"],
      "low_confidence_policy": "同时输出 top2 候选，不进入强诊断"
    }
  ],
  "downgrade_rules": [
    {
      "scope": "global",
      "rule_type": "visibility",
      "condition": "看不到触球瞬间",
      "affects": "所有技术动作识别",
      "system_action": "lower_confidence",
      "user_message": "请尽量拍到击球前后完整动作。"
    }
  ]
}
```

### 6.2 诊断规则 JSON

建议结构：

```json
{
  "schema_version": "v1",
  "rules": [
    {
      "action_id": "bh_drive",
      "issue_id": "bh_drive_elbow_unstable",
      "evidence": "肘部左右晃动，出球方向不稳定",
      "problem": "肘部不稳，导致拨球方向控制差",
      "priority": 1,
      "advice": "把肘部固定在身体前方，只让前臂以肘为轴向前弹出。",
      "related_cues": ["肘部稳定"]
    }
  ]
}
```

### 6.3 技术识别输出 Schema

新增 Pass 1.5 输出：

```ts
interface TechniqueClassificationResult {
  primary_action_id: string | 'unknown';
  primary_action_name?: string;
  overall_confidence: number;
  is_uncertain: boolean;
  uncertainty_reason?: string;
  events: TechniqueEvent[];
  top_candidates: TechniqueCandidate[];
  visibility_issues?: string[];
}

interface TechniqueEvent {
  timestamp: string;
  segment_start: string;
  segment_end: string;
  action_id: string | 'unknown';
  action_name?: string;
  confidence: number;
  evidence: string[];
  contradictions?: string[];
  visibility_issues?: string[];
  top_candidates: TechniqueCandidate[];
}

interface TechniqueCandidate {
  action_id: string;
  action_name: string;
  confidence: number;
  matched_cues?: string[];
  missing_required_info?: string[];
}
```

### 6.4 报告 Payload 扩展

当前：

```ts
interface TechniqueReport {
  techName: string;
  problems: { text: string; timestamp: string }[];
  improvements: string[];
  action_ids_detected?: string[];
  valid_segments?: VideoSegment[];
  summaryText?: string;
  videoLinks?: { title: string; url: string }[];
}
```

建议扩展：

```ts
interface TechniqueReport {
  techName: string;
  problems: { text: string; timestamp: string }[];
  improvements: string[];
  action_ids_detected?: string[];
  detected_action_id?: string | 'unknown';
  detected_action_name?: string;
  recognition_confidence?: number;
  recognition_evidence?: string[];
  recognition_uncertain?: boolean;
  recognition_uncertainty_reason?: string;
  top_action_candidates?: {
    action_id: string;
    action_name: string;
    confidence: number;
  }[];
  valid_segments?: VideoSegment[];
  summaryText?: string;
  videoLinks?: { title: string; url: string }[];
}
```

前端可先不展示所有字段，但需要保留数据，便于后续调试和体验优化。

---

## 7. Pipeline 详细设计

### 7.1 Pass 1：有效片段识别

保留现有设计：

- 找出正式回合、练习击球、发球练习、多球训练等有效片段。
- 过滤捡球、等待、休息、聊天、走动等无效片段。
- 使用 `validateSegments()` 校验时间戳。

建议增强：

- 合并相邻短片段。
- 限制总分析时长，优先保留击球密度高的片段。
- Pass 1 输出 `description` 时尽量要求包含“疑似动作类型”，但不作为最终识别结果。

### 7.2 Pass 1.5：技术动作识别

新增函数建议：

```ts
async function classifyTechnique(
  ai: any,
  fileData: { fileUri: string; mimeType: string },
  segments: VideoSegment[],
  recognitionKnowledge: ActionRecognitionKnowledge
): Promise<TechniqueClassificationResult>
```

输入：

- Gemini file data。
- Pass 1 有效片段。
- 合法 action_id 列表。
- 教练维护的识别线索、混淆矩阵、降级规则。

Prompt 原则：

```text
你不是在写诊断报告，只负责识别技术动作。
只能从给定 action_id 中选择，或者输出 unknown。
必须基于可见证据判断。
如果关键证据不可见，不要强行猜测。
对易混淆动作必须给出 top_candidates。
```

输出要求：

- JSON only。
- 使用 `responseMimeType: 'application/json'`。
- 使用 `responseSchema`。
- `temperature` 建议 `0.0 - 0.1`。

### 7.3 置信度策略

建议策略：

| 条件 | 系统行为 |
|---|---|
| `overall_confidence >= 0.75` 且 top1-top2 差距 >= 0.15 | 高置信度，进入正式诊断 |
| `0.55 <= overall_confidence < 0.75` | 中置信度，进入保守诊断，报告写“疑似” |
| `overall_confidence < 0.55` | 不进入强技术诊断，提示视频证据不足 |
| top1-top2 差距 < 0.15 | 判为易混淆，报告保留 top2，不强推荐某个专项教程 |
| `primary_action_id === 'unknown'` | 输出视频质量/拍摄建议，不输出具体技术纠错 |

伪代码：

```ts
function classifyConfidence(result: TechniqueClassificationResult): RecognitionDecision {
  const [top1, top2] = result.top_candidates;
  const margin = top2 ? top1.confidence - top2.confidence : 1;

  if (result.primary_action_id === 'unknown') return { mode: 'unknown' };
  if (result.overall_confidence < 0.55) return { mode: 'unknown' };
  if (margin < 0.15) return { mode: 'ambiguous' };
  if (result.overall_confidence < 0.75) return { mode: 'tentative' };
  return { mode: 'confirmed' };
}
```

### 7.4 Pass 2：受约束诊断

Pass 2 不再重新猜技术，而是接收识别结论：

```ts
function buildPass2Prompt(
  analysisType: string,
  segments: VideoSegment[],
  recognition: TechniqueClassificationResult,
  diagnosisRules: DiagnosisRules
): string
```

对于高置信度：

```text
已识别本视频主要技术为：bh_drive / 反手拨球。
请只围绕该技术诊断。
不要改判为其他技术。
如果发现证据不足，只能在报告中说明不确定。
```

对于中置信度：

```text
本视频疑似为 bh_drive / 反手拨球，但存在不确定性。
请以保守语气输出，不要使用绝对判断。
```

对于低置信度：

```text
不要输出具体技术诊断。
请总结为什么无法识别，并给出拍摄建议。
```

### 7.5 教程推荐

当前教程推荐：

```ts
recommendTutorials(actionId, [], 2)
```

v2 规则：

- 只使用经过校验的 `primary_action_id`。
- 不再信任 Pass 2 自由生成的 `action_ids_detected`。
- 低置信度或 `unknown` 不推荐专项教程。
- 易混淆场景可不推荐，或推荐“基础综合”内容，避免误导。

---

## 8. 教练知识模板落地方式

### 8.1 当前模板位置

```text
client/src/assets/knowledge/0_coach_knowledge/
  README.md

  table_tennis_action_knowledge_v1.xlsx   ← 初始版本（已归档）
  table_tennis_action_knowledge_v2.xlsx   ← 当前版本（生产使用）
```

### 8.2 当前职责

当前 Excel 只负责：

- 视频识别规则。
- 技术混淆边界。
- 不可判断/降级规则。
- 诊断证据和训练建议。

不负责：

- 生成用户教学 Markdown。
- 维护教程视频列表。

### 8.3 为什么不维护视频教程 Sheet

视频教程当前由系统自动推荐：

```text
tutorial_videos 表
  ↓
recommendTutorials(actionId, tags, limit)
```

因此不在 Excel 中单独维护教程 Sheet，避免出现第二套教程来源。

未来如果产品需要“教练精选教程”，应单独设计：

- 是否覆盖自动推荐。
- 是否只作为人工加权。
- 是否写入 `tutorial_videos`。

本阶段不做。

### 8.4 为什么不让 Excel 生成 Markdown

`actions/*.md` 属于用户输出内容，需要产品经理和教练共同打磨：

- 语气。
- 表达结构。
- 用户理解成本。
- 产品调性。

Excel 的识别规则更偏工程结构化：

- 权重。
- 置信度。
- 可见线索。
- 降级策略。

两者短期不合并，降低风险。

---

## 9. 代码改造建议

### 9.1 新增模块

建议新增：

```text
server/videoAnalysis/recognitionKnowledgeLoader.ts
server/videoAnalysis/techniqueClassifier.ts
server/videoAnalysis/recognitionDecision.ts
server/videoAnalysis/diagnosisKnowledgeLoader.ts
```

职责：

| 模块 | 职责 |
|---|---|
| `recognitionKnowledgeLoader.ts` | 加载 `action_video_analysis_knowledge.json` |
| `techniqueClassifier.ts` | 调用 Gemini 执行 Pass 1.5 |
| `recognitionDecision.ts` | 置信度门槛、top1/top2 margin、降级策略 |
| `diagnosisKnowledgeLoader.ts` | 加载诊断规则，供 Pass 2 prompt 使用 |

如果希望保持改动更小，也可以先都放在 `handleAnalysisJob.ts`，但长期建议拆开。

注意：`actions/*.md` 不作为正式识别规则 fallback。由于 V2 Excel 已全面覆盖 13 个动作的识别/诊断规则，Markdown fallback 降级为仅在开发调试环境中使用。若 JSON 缺失，服务端应 graceful fallback 到“识别知识不可用/低置信度模式”，不能把 Markdown 正则解析作为生产识别规则来源。

### 9.2 修改 `handleAnalysisJob.ts`

当前主流程：

```text
upload video
wait active
Pass 1
validateSegments
Pass 2
recommend tutorials
wrap payload
```

v2 主流程：

```text
upload video
wait active
Pass 1
validateSegments
load recognition knowledge
Pass 1.5 classify technique
decide recognition mode
load diagnosis rules
Pass 2 constrained diagnosis
recommend tutorials by validated action_id
wrap payload with recognition metadata
```

### 9.3 Schema 校验

必须校验：

- Excel 转 JSON 阶段：
  - 必填字段不能为空。
  - `action_id` / `confusable_with` 必须存在于 `index.json` 的动作集合中。
  - `phase` 必须来自 `枚举值`，例如 `preparation`、`backswing`、`contact`、`swing`、`follow_through`、`recovery`、`ball_flight`、`footwork`。
  - `weight` 只能是 1/2/3。
  - `priority` 只能是 1/2/3。
  - `issue_id` 不允许重复。
  - `action_id + confusable_with` 不允许重复。
  - 正式模式下不允许残留 `🐧`、`不确定`、`需要教练确认`、`示例` 等未确认标记。
- 模型输出阶段：
- `primary_action_id` 是否在 `getActionIds()` 中，或为 `unknown`。
- `top_candidates[].action_id` 是否合法。
- `confidence` 是否为 `0..1`。
- `events[].timestamp` 是否落在有效片段内。
- `evidence` 不能为空；如果为空，置信度不得高于 0.55。
- `unknown` 时不得推荐专项教程。

### 9.4 错误码扩展

建议新增：

```ts
const ERROR_CODES = {
  ...
  RECOGNITION_PARSE_FAILED: 'RECOGNITION_PARSE_FAILED',
  RECOGNITION_KNOWLEDGE_MISSING: 'RECOGNITION_KNOWLEDGE_MISSING',
  RECOGNITION_NO_CONFIDENT_ACTION: 'RECOGNITION_NO_CONFIDENT_ACTION'
}
```

注意：`RECOGNITION_NO_CONFIDENT_ACTION` 不一定是 job failed。多数情况下应生成“无法可靠识别”的报告，而不是失败。

---

## 10. 前端展示建议

### 10.1 MVP 展示

前端现有 `AnalysisReportCard` 可先保持不变，只使用：

- `techName`
- `summaryText`
- `problems`
- `improvements`
- `videoLinks`

后端把识别信息写入 `summaryText` 即可：

```text
我能较清楚地看到这是反手拨球，主要依据是前臂向前弹出、动作幅度较小、击球点在上升期。
```

低置信度：

```text
这段视频暂时无法稳定判断具体技术，主要原因是看不到触球瞬间和球台区域。建议下次从侧前方拍摄，保留击球前后完整动作。
```

### 10.2 后续增强展示

后续可以增加：

- 技术识别置信度。
- top2 候选。
- “为什么这么判断”证据列表。
- “视频条件不足”提示卡。

示例：

```text
识别结果：反手拨球
置信度：78%
主要证据：
- 前臂以肘为轴向前弹出
- 挥拍幅度较小
- 近台反手位击球
易混淆项：反手拉球
```

---

## 11. 测试与评估

### 11.1 单元测试

覆盖：

- Excel 转 JSON 后的 schema 校验。
- action_id 合法性。
- 置信度策略。
- top1/top2 margin 判断。
- `unknown` 时不推荐教程。
- 低置信度时不进入强诊断。

### 11.2 Prompt 回归测试

准备一组固定视频或人工标注样例：

```text
fixtures/video_analysis/
  bh_drive_01.mp4
  bh_loop_01.mp4
  fh_drive_01.mp4
  fh_loop_01.mp4
  bh_flick_01.mp4
```

每个样例维护人工标注：

```json
{
  "video": "bh_drive_01.mp4",
  "expected_action_id": "bh_drive",
  "acceptable_candidates": ["bh_drive", "bh_loop"],
  "must_not_classify_as": ["fh_loop"],
  "notes": "正面视角，能看到前臂向前拨，但触球瞬间略模糊。"
}
```

### 11.3 评估指标

| 指标 | 说明 |
|---|---|
| top1 accuracy | 第一候选是否等于教练标注 |
| top2 recall | 正确技术是否出现在 top2 |
| overconfident error rate | 错误识别但 confidence >= 0.75 的比例 |
| unknown precision | 输出 unknown 的样例是否确实证据不足 |
| diagnosis relevance | 诊断问题是否匹配已识别技术 |
| tutorial correctness | 推荐教程是否匹配确认 action_id |

最重要指标不是单纯 top1 accuracy，而是：

```text
降低高置信度错误
```

宁可低置信度降级，也不要高置信度误导用户。

---

## 12. 分阶段落地计划

### 阶段 1：文档和知识模板完善 ✅ 已完成

已完成：

- 新增教练 Excel 模板。
- 新增数据字典。
- 明确 Excel 只维护视频识别/诊断规则。
- 明确 `actions/*.md` 继续作为用户教学输出源。
- 教练已填写 v1（11 个动作）并迭代到 v2（13 个动作）。
- V2 已解决 V1 遗留质量问题（非法 phase、降级规则不足、缺失混淆矩阵等）。
- V2 Excel 审核通过，知识数据已达到启动全链路工程开发的质量标准。

待做（非阻塞）：

- 将 `fh_flick`（正手挑打）和 `serve_nospin`（不转发球）同步到 `index.json` 和 `actions/*.md`。
- 后续可选优化：补充 `fh_drive↔fh_block`、`hook_serve↔reverse_pendulum_serve` 混淆矩阵。

### 阶段 2：Excel 转 JSON

新增脚本：

```text
client/src/assets/knowledge/0_coach_knowledge/export_action_video_analysis_knowledge.mjs
```

输出：

```text
server/data/action_video_analysis_knowledge.json
```

脚本能力：

- 读取 Excel。
- 校验必填字段。
- 校验 action_id 引用。
- 校验 phase / weight / priority / rule_type 等枚举。
- 校验重复 `issue_id` 和重复混淆 pair。
- 检查未确认标记残留。
- 输出 JSON。
- 对缺失字段、非法枚举、非法引用给出清晰错误。
- 支持 `--strict` 模式：严格模式下遇到未确认标记直接失败。

### 阶段 3：新增 Pass 1.5

改造：

- 新增 classifier schema。
- 新增 prompt builder。
- 新增 `classifyTechnique()`。
- 新增识别结果校验。
- 新增置信度策略。

### 阶段 4：约束 Pass 2

改造：

- Pass 2 接收 classification result。
- 高置信度时按指定 action_id 诊断。
- 中置信度时保守诊断。
- 低置信度时输出拍摄建议。
- 教程推荐只使用 validated action_id。

### 阶段 5：前端展示优化

改造：

- 报告中展示识别结果和置信度。
- 展示识别证据。
- 展示视频条件不足提示。

---

## 13. 风险与取舍

### 13.1 风险：Excel 增加维护成本

缓解：

- 只让教练填视频识别相关字段。
- 用户教学 Markdown 仍由产品经理和教练维护。
- Excel 有数据字典和示例。

### 13.2 风险：模型仍可能看错

缓解：

- 强制 action_id 枚举。
- 要求证据。
- 引入置信度和 top2。
- 低置信度不强诊断。
- 优先优化“高置信度错误率”。

### 13.3 风险：Prompt 过长

缓解：

- Pass 1.5 只注入候选动作摘要、核心线索、混淆规则。
- 不整篇注入 Markdown。
- 只注入与当前候选相关的 top N 动作。

### 13.4 风险：视频质量差导致识别频繁 unknown

缓解：

- 前端上传前提示拍摄规范。
- 报告中给明确拍摄建议。
- 后续可加入视频质量预检。

---

## 14. 拍摄建议标准化

为了减少低质量视频导致的识别失败，建议在上传入口或低置信度报告中提示：

- 尽量从侧前方拍摄。
- 拍到球员上半身、持拍手、球台和击球点。
- 保留击球前后完整动作。
- 不要只拍随挥结果。
- 发球和台内球需要拍到球台近网区域。
- 尽量使用 60fps 或更高帧率。

这些建议也可以进入 `降级规则` 的用户提示字段。

---

## 15. 结论

Phase 2-A v1 解决了“视频分析是真的”。

Phase 2-A v2 要解决的是：

```text
视频分析是否可信
```

核心改造是：

```text
Pass 1：找有效片段
Pass 1.5：受约束技术识别
Pass 2：基于已识别 action_id 的诊断
```

配套原则：

- 技术识别必须独立。
- action_id 必须受约束。
- 识别必须有证据和置信度。
- 低置信度必须降级。
- 教练知识通过 Excel 结构化录入。
- 用户教学 Markdown 暂时继续人工维护。

这样可以把系统从“模型自由猜动作”推进到“按教练规则识别动作”，显著降低错误技术识别对后续报告和教程推荐的连锁影响。
