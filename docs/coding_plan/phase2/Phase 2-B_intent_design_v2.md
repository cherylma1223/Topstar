# Phase 2 设计文档：意图识别层重构

> 目标：把当前“主题分类式”的意图识别，升级为“请求理解式”的编排入口，解决教程请求、器材咨询、动作指导等场景中常见的误判、过度讲解与错误渲染问题。

---

## 1. 背景

Phase 1 已经完成了基础的“规则优先 + LLM 兜底”意图路由，能够把用户请求大致分到：

- `ACTION_COACHING`
- `TACTIC_ADVICE`
- `EQUIPMENT_QA`
- `TUTORIAL_REQUEST`
- `VIDEO_ANALYSIS`
- `OFF_TOPIC`

这套方案适合 MVP 快速上线，但在真实交互中已经暴露出一个更深层的问题：

**系统能识别用户在问哪个主题，却不够稳定地识别用户到底想要什么交付形式。**

典型表现：

- 问“反手拧拉的视频教程”，系统容易返回动作要领等额外讲解
- 问器材时，系统不稳定区分“问参数 / 求推荐 / 求搭配 / 做对比”
- 不确定请求一旦低置信度，就被压回 `ACTION_COACHING`
- 前端渲染模式被粗粒度 intent 误导，进一步放大错误体验

因此，Phase 2 需要把“意图识别”从单层分类器升级为“结构化请求理解层”。

---

## 2. 当前架构问题

### 2.1 Intent 粒度过粗

当前 intent 更像“领域分类”而非“任务分类”。

例如 `TUTORIAL_REQUEST` 同时覆盖：

- 只要视频链接
- 要视频 + 1-2 句解释
- 想看示范视频用于纠错

这些请求的最终输出结构不同，但现在被归到同一个 intent。

### 2.2 Intent 与交付形态耦合

当前系统默认用一个 intent 同时决定：

- 用哪类知识
- 是否推荐教程
- 用哪个 prompt
- 前端渲染成哪种卡片

这会导致一个问题：**只要 intent 略有偏差，整条后链路都会偏。**

### 2.3 Fallback 有系统性偏置

当前低置信度默认回退到 `ACTION_COACHING`。这会把大量模糊请求解释成“请教我这个技术”，导致：

- 过度输出动作讲解
- 教程/资源类请求被教学化
- 边界场景无法维持中性输出

### 2.4 规则层只能命中关键词，不能表达约束

当前规则可以识别“提到了视频”，但难以识别：

- 只要视频，不要讲解
- 只做对比，不要推荐
- 只问价格，不问打法

也就是说，规则层只能识别信号，不能识别意图边界。

### 2.5 Entities 过弱

当前 `entities` 只有：

- `action_id`
- `equipment_query`
- `tactic_topic`

缺少真正影响编排的关键槽位，例如：

- 请求类型
- 输出偏好
- 是否只要资源
- 是否要推荐
- 是否要比较
- 用户水平 / 板型 / 预算

### 2.6 缺少“响应模式”层

系统当前没有独立的 `response_mode` 概念，因此“问什么”和“怎么回”混在了一起。

这会导致：

- 同样是 `ACTION_COACHING`，既可能要解释，也可能要训练计划
- 同样是 `EQUIPMENT_QA`，既可能要参数解读，也可能要搭配推荐
- 同样是 `TUTORIAL_REQUEST`，既可能只要列表，也可能接受简讲

---

## 3. Phase 2 目标

Phase 2 的重构目标不是让 intent 数量无限膨胀，而是建立一套更稳定的请求理解协议：

1. 把“领域识别”和“输出模式”拆开
2. 让编排层拿到更细粒度的控制信息
3. 避免低置信度时默认落入教学型回答
4. 让前端渲染依据结构化结果，而不是猜测 intent
5. 为后续评估、A/B、回归测试提供可观测输入

---

## 4. 目标架构

建议把当前单层 `intent` 升级为四层结构：

```json
{
  "domain_intent": "ACTION",
  "task_intent": "TUTORIAL",
  "response_mode": "RESOURCE_ONLY",
  "entities": {
    "action_id": "bh_flick",
    "equipment_query": null,
    "tactic_topic": null,
    "comparison_targets": [],
    "budget": null,
    "player_profile": null
  },
  "confidence": 0.91,
  "source": "rule+llm",
  "reason": "用户明确索要拧拉教学视频，未表达讲解诉求"
}
```

### 4.1 `domain_intent`

表示问题所属知识域，用于决定主要检索范围。

建议枚举：

- `ACTION`
- `TACTIC`
- `EQUIPMENT`
- `VIDEO_ANALYSIS`
- `GENERAL_PINGPONG`
- `OFF_TOPIC`

### 4.2 `task_intent`

表示用户要系统做什么。

建议首批支持：

- `EXPLAIN`
- `DIAGNOSE`
- `RECOMMEND`
- `COMPARE`
- `TUTORIAL`
- `PLAN`
- `QA`

### 4.3 `response_mode`

表示最终交付形态，直接供编排层和前端使用。

建议首批支持：

- `TEXT_ONLY`
- `TEXT_WITH_RESOURCES`
- `RESOURCE_ONLY`
- `REPORT_CARD`
- `COMPARISON_CARD`
- `QUESTION_BACK`

这里的关键价值是：**用户要什么内容** 与 **系统怎么交付** 被明确拆开。

### 4.4 `entities`

Entities 需要从“辅助信息”升级为“编排控制输入”。

首批建议包含：

- `action_id`
- `equipment_query`
- `tactic_topic`
- `comparison_targets`
- `budget`
- `player_profile`
- `needs_tutorials`
- `needs_explanation`
- `needs_recommendation`

其中后三个布尔位非常重要，可显著降低后续 prompt 和模板漂移。

---

## 5. 重点场景设计

### 5.1 教程请求

当前问题最明显，建议拆成：

- `domain_intent = ACTION`
- `task_intent = TUTORIAL`

再用 `response_mode` 区分：

- `RESOURCE_ONLY`
  例子：“反手拧拉的视频教程”“直接发我几个链接”

- `TEXT_WITH_RESOURCES`
  例子：“简单说下拧拉重点，再给我几个视频”

这意味着后端不需要引入新的顶层 intent 名称，也能稳定表达“只要教程”和“教程+简讲”。

### 5.2 器材咨询

建议拆分出至少三类任务：

- `QA`
  例子：“D09C 怎么样”

- `COMPARE`
  例子：“D09C 和 K3 哪个更适合我”

- `RECOMMEND`
  例子：“给我推荐一套 800 元横板配置”

它们可能都属于 `domain_intent = EQUIPMENT`，但输出模式完全不同。

### 5.3 动作指导

动作相关请求建议区分：

- `EXPLAIN`
  例子：“反手拧拉怎么练”

- `DIAGNOSE`
  例子：“反手拧拉总出界是为什么”

- `PLAN`
  例子：“给我一个 7 天拧拉训练计划”

这样编排层才能决定：

- 是走知识讲解
- 走问题归因
- 还是走训练方案模板

---

## 6. 新的识别流程

建议 Phase 2 的识别流程升级为三段式：

### Stage A：强规则预判

只处理高精度强约束：

- `event=video` -> `domain_intent = VIDEO_ANALYSIS`
- 明确“只要视频 / 不用讲 / 直接发链接” -> `response_mode = RESOURCE_ONLY`
- 敏感词 / 非乒乓球 -> `OFF_TOPIC`

规则层只做高精度拦截，不承担复杂语义分类。

### Stage B：LLM 结构化理解

LLM 输出完整 schema：

- `domain_intent`
- `task_intent`
- `response_mode`
- `entities`
- `confidence`

这里的模型职责不再只是“选一个大类”，而是做轻量的请求理解。

### Stage C：Policy 修正层

新增一个确定性 policy 层，对 LLM 结果做最后矫正。

示例策略：

- 如果命中“只要视频”，强制 `response_mode = RESOURCE_ONLY`
- 如果 `task_intent = TUTORIAL` 且 `needs_explanation = false`，禁止走动作讲解模板，**直接短路 LLM 生成**
- 如果低置信度且无强规则，不直接降级为教学，而改成中性 `TEXT_ONLY`
- **前端支持检查**：Policy 不应返回前端尚未支持的模式（如 `COMPARISON_CARD`），除非该模式有明确的文本 fallback。

### Stage D：兼容适配器 (Adapter)

为了平滑迁移，新增 Adapter 函数作为新旧协议的桥梁：

- `decisionToLegacyIntent(decision)`：从新 schema 派生旧 `IntentType`，确保后链路逻辑一致性。
- `legacyIntentToDecision(legacyIntent)`：为旧请求补全基础 schema。

**核心原则**：内部编排以 `decision` 为准，旧 `intent` 字段仅用于兼容。

---

## 7. 编排层接口调整

当前编排层主要依赖单个 `intent`。Phase 2 建议改成基于 `IntentDecision` 进行编排。

建议的接口结构：

```ts
interface IntentDecision {
  domain_intent: 'ACTION' | 'TACTIC' | 'EQUIPMENT' | 'VIDEO_ANALYSIS' | 'GENERAL_PINGPONG' | 'OFF_TOPIC';
  task_intent: 'EXPLAIN' | 'DIAGNOSE' | 'RECOMMEND' | 'COMPARE' | 'TUTORIAL' | 'PLAN' | 'QA';
  response_mode: 'TEXT_ONLY' | 'TEXT_WITH_RESOURCES' | 'RESOURCE_ONLY' | 'REPORT_CARD' | 'COMPARISON_CARD' | 'QUESTION_BACK';
  entities: {
    action_id: string | null;
    equipment_query: string | null;
    tactic_topic: string | null;
    comparison_targets: string[];
    budget: string | null;
    player_profile: string | null;
    needs_tutorials: boolean;
    needs_explanation: boolean;
    needs_recommendation: boolean;
  };
  confidence: number;
  source: 'rule' | 'llm' | 'policy' | 'fallback';
  reason?: string;
}
```

编排层据此决定：

- 检索哪些知识域
- 是否注入完整知识正文
- 是否直接调用教程推荐
- 使用哪种 prompt
- 返回哪类结构化 UI 数据

---

## 8. 降级策略重做

当前“低置信度 -> `ACTION_COACHING`”会放大误判。Phase 2 建议改成分层降级：

### 8.1 一级降级：保守输出

当分类不稳定但仍属乒乓球域时：

- 不强行进入动作讲解
- 返回中性说明
- 必要时只做资源推荐或澄清式回答

### 8.2 二级降级：最小损害渲染

当 `response_mode` 不确定时：

- 优先 `TEXT_ONLY`
- 禁止渲染报告卡
- 禁止注入重型知识模板

### 8.3 三级降级：记录而不是猜测

对高风险未识别样本：

- 记日志
- 进入 eval set
- 后续修规则或 prompt

目标是让系统在不确定时“少做错”，而不是“自信地多做错”。

---

## 9. 前端配合原则

Phase 2 不应再让前端通过“有没有 tutorialVideos”去推断展示类型。

前端应该优先读取结构化的 `response_mode`：

- `RESOURCE_ONLY` -> 教程列表卡
- `TEXT_WITH_RESOURCES` -> 说明 + 教程卡
- `REPORT_CARD` -> 报告卡
- `COMPARISON_CARD` -> 对比卡

这样可以显著减少“本来只是要视频，却被包成技术报告卡”的问题。

---

## 10. 迁移策略

建议分 4 步做，避免一次性推翻：

### Step 1：扩 schema，不立刻删旧字段

新增：

- `domain_intent`
- `task_intent`
- `response_mode`
- 增强版 `entities`

同时保留旧 `intent` 一段时间，作为兼容字段。

### Step 2：先把教程场景切到新协议

优先解决最明显的问题：

- `TUTORIAL_REQUEST` 场景改走新结构
- 支持 `RESOURCE_ONLY` / `TEXT_WITH_RESOURCES`

### Step 3：再处理器材和动作场景

按收益排序建议先做：

1. 器材推荐 / 对比
2. 动作解释 / 诊断
3. 训练计划

### Step 4：最后移除旧单层 intent 依赖

当前后端和前端都稳定使用新 schema 后，再逐步删除旧字段和旧模板分支。

---

## 11. 评估与验收

### 11.1 评估体系拆分

不建议把 live LLM 结果作为 CI 的唯一判断。建议拆分为两类：

#### 1. 确定性单元测试 (Deterministic Tests)
- **覆盖范围**：规则命中、Policy 修正逻辑、Adapter 转换、Fallback 触发。
- **执行方式**：纳入 CI，必须 100% 通过。

#### 2. LLM 离线评估 (Offline Evaluation)
- **覆盖范围**：教程请求（只要资源/资源+简讲）、动作诊断、器材对比等。
- **执行方式**：通过 `intent_eval_set_phase2.jsonl` 运行，输出 Diff 和准确率报告，用于版本间效果比对。

### 11.2 核心验收指标

- `RESOURCE_ONLY` 场景中，不应输出动作要领段落
- 低置信度场景中，不应默认回到教学模板
- 教程类请求应稳定区分“只要视频”与“视频+说明”
- 前端教程请求不应误渲染为报告卡

### 11.3 关键案例

以下案例应重点回归：

- “反手拧拉的视频教程”
- “给我几个拧拉教学链接，不用讲解”
- “简单说下拧拉重点，再给我视频”
- “D09C 怎么样”
- “D09C 和 K3 怎么选”
- “推荐一套 800 元横板配置”
- “反手拧拉总出界怎么纠正”

---

## 12. 非目标

Phase 2 暂不追求：

- 一次性解决所有 prompt 漂移问题
- 引入复杂的多轮状态机
- 上 embedding 检索做意图分类
- 让前端支持所有高级卡片样式

Phase 2 的重点是先把“识别什么请求、以什么形态交付”这件事做对。

---

## 13. 结论

当前意图识别层的主要问题，不是模型能力不够，而是架构抽象还停留在“主题分类”。

Phase 2 应把它升级为一层结构化请求理解协议：

- 用 `domain_intent` 识别知识域
- 用 `task_intent` 识别任务类型
- 用 `response_mode` 决定交付方式
- 用增强版 `entities` 驱动编排

这样才能从根上解决教程请求过度讲解、器材问题混答、低置信度误入教学模板等一系列共性问题。
