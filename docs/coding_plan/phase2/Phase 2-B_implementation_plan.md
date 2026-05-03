# Phase 2-B：意图识别层重构 — 实施计划

> 设计文档：[Phase 2-B_intent_design_v2.md](file:///Users/yingdongma/Documents/Dev/projects/Topstar/docs/coding_plan/phase2/Phase%202-B_intent_design_v2.md)
> 
> 目标：将单层 `IntentType` 升级为四层结构 (`domain_intent` / `task_intent` / `response_mode` / `entities`)，分4步迁移，先解决教程场景。

---

## User Review Required

> [!IMPORTANT]
> **迁移策略确认**：Step 1-2 先做（扩 schema + 教程场景切换），Step 3-4 后续迭代。本次实施只覆盖 Step 1 和 Step 2，不会删除旧字段。

> [!WARNING]
> **前端渲染逻辑变更**：`App.tsx` 中当前通过 `response.tutorialVideos.length > 0` 判断是否渲染报告卡。Phase 2-B 将改为读取 `response_mode` 字段。需确认是否接受此变更。

## Open Questions

1. **LLM prompt 语言**：LLM 结构化理解 prompt 是否继续用中文，还是切换为英文以提高 JSON 输出稳定性？
2. **前端兼容过渡期**：是否需要在 `response_mode` 未返回时做 fallback 兼容（即旧逻辑仍生效）？建议 Yes。

---

## Proposed Changes

按迁移 Step 顺序组织：

### Step 1：扩 Schema，保留旧字段

---

#### [NEW] [types.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/intent/types.ts)

新建类型定义文件，集中管理所有意图相关类型，替代当前散落在 `intentRouter.ts` 中的内联定义。

```ts
// 核心新增类型
export type DomainIntent = 'ACTION' | 'TACTIC' | 'EQUIPMENT' | 'VIDEO_ANALYSIS' | 'GENERAL_PINGPONG' | 'OFF_TOPIC';
export type TaskIntent = 'EXPLAIN' | 'DIAGNOSE' | 'RECOMMEND' | 'COMPARE' | 'TUTORIAL' | 'PLAN' | 'QA';
export type ResponseMode = 'TEXT_ONLY' | 'TEXT_WITH_RESOURCES' | 'RESOURCE_ONLY' | 'REPORT_CARD' | 'COMPARISON_CARD' | 'QUESTION_BACK';

export interface IntentEntities {
  action_id: string | null;
  equipment_query: string | null;
  tactic_topic: string | null;
  comparison_targets: string[];
  budget: string | null;
  player_profile: string | null;
  needs_tutorials: boolean;
  needs_explanation: boolean;
  needs_recommendation: boolean;
}

export interface IntentDecision {
  domain_intent: DomainIntent;
  task_intent: TaskIntent;
  response_mode: ResponseMode;
  entities: IntentEntities;
  confidence: number;
  source: 'rule' | 'llm' | 'policy' | 'fallback';
  reason?: string;
}

// 兼容适配器 (Adapter)
export function decisionToLegacyIntent(decision: IntentDecision): IntentType {
  // 根据 domain_intent + task_intent 映射回旧的 IntentType
  // 例如：ACTION + TUTORIAL -> TUTORIAL_REQUEST
  // 这是保证新旧逻辑一致性的关键
}
```

**关键设计**：`IntentResult.decision` 为可选字段。Step 1 阶段旧消费方不受影响，新逻辑通过 `decision` 获取细粒度信息。

---

#### [NEW] [policy.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/intent/policy.ts)

新建 Policy 修正层（Stage C），将业务策略从 prompt 剥离到代码中。

核心策略：

| # | 条件 | 修正动作 |
|---|------|---------|
| 1 | 命中"只要视频/不用讲/直接发链接" | 强制 `response_mode = RESOURCE_ONLY` |
| 2 | `task_intent = TUTORIAL` 且 `needs_explanation = false` | 禁止走动作讲解 prompt |
| 3 | 低置信度 (< 0.5) 且无强规则命中 | `response_mode = TEXT_ONLY`，不降级为 ACTION |
| 4 | `task_intent = COMPARE` | 强制 `response_mode = COMPARISON_CARD` |
| 5 | `task_intent = RECOMMEND` 且缺少 budget/player_profile | `response_mode = QUESTION_BACK` |

```ts
export function applyPolicy(decision: IntentDecision, rawMessage: string): IntentDecision {
  // ... 确定性策略逻辑，无 LLM 调用
}
```

---

#### [MODIFY] [intentRouter.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/intent/intentRouter.ts)

改动范围（按 Stage 组织）：

1. **导入重构**：类型定义迁移至 `types.ts`，本文件 re-export 保持兼容。
2. **Stage A（规则层）增强**：
   - 新增"只要视频"等约束型规则，输出 `response_mode` 而非仅 `intent`。
   - `ruleBasedClassify()` 返回值包含 `decision` 字段。
3. **Stage B（LLM）升级**：
   - prompt 改为要求 LLM 输出 `{ domain_intent, task_intent, response_mode, entities, confidence }` 完整 schema。
   - 验证逻辑扩展：校验三个新枚举字段的合法性。
4. **Stage C（Policy）接入**：
   - `classifyIntent()` 在 LLM 结果后调用 `applyPolicy()` 做最终矫正。
5. **Fallback 策略重做**：
   - 低置信度不再默认 `ACTION_COACHING`，改为 `domain_intent = GENERAL_PINGPONG` + `response_mode = TEXT_ONLY`。

关键代码变化示意：

```diff
 export async function classifyIntent(message: string, event?: string): Promise<IntentResult> {
   // Stage A: 规则强命中
   const ruleResult = ruleBasedClassify(message, event);
   if (ruleResult) return ruleResult;

   // Stage B: LLM 结构化理解
   const llmResult = await llmClassify(message);
+
+  // Stage C: Policy 修正
+  if (llmResult.decision) {
+    llmResult.decision = applyPolicy(llmResult.decision, message);
+  }
+
   return llmResult;
 }
```

---

### Step 2：教程场景切到新协议

---

#### [MODIFY] [handleChatEvent.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/orchestrator/handleChatEvent.ts)

改动点（按编排步骤编号）：

**步骤 3 — 教程推荐判断逻辑**（L208-235）：

```diff
-    const needsTutorials =
-      intentResult.intent === 'TUTORIAL_REQUEST' ||
-      intentResult.intent === 'ACTION_COACHING' ||
-      intentResult.secondaryIntents.includes('TUTORIAL_REQUEST');
+    const decision = intentResult.decision;
+    const needsTutorials =
+      decision?.entities.needs_tutorials === true ||
+      decision?.task_intent === 'TUTORIAL' ||
+      // 旧逻辑 fallback
+      intentResult.intent === 'TUTORIAL_REQUEST' ||
+      intentResult.intent === 'ACTION_COACHING' ||
+      intentResult.secondaryIntents.includes('TUTORIAL_REQUEST');
```

**步骤 4 — 模板 prompt 选择与短路逻辑**（L238）：

```diff
-    const templatePrompt = TEMPLATE_PROMPTS[intentResult.intent] || '';
+    if (decision?.response_mode === 'RESOURCE_ONLY') {
+      // 短路逻辑：跳过 LLM 生成动作讲解，直接返回固定系统文案
+      answerText = `为您找到以下关于“${decision.entities.action_id || '相关'}”的教学视频：`;
+    } else {
+      const templatePrompt = decision
+        ? resolveTemplatePrompt(decision)
+        : TEMPLATE_PROMPTS[intentResult.intent] || '';
+      // ... 调用 LLM 生成 answerText
+    }
```

新增 `resolveTemplatePrompt()` 函数：根据 `domain_intent + task_intent + response_mode` 三者组合选择 prompt。关键规则：
- `response_mode = TEXT_WITH_RESOURCES` → 简讲 prompt
- `task_intent = COMPARE` → 对比 prompt
- `task_intent = DIAGNOSE` → 问题归因 prompt

**步骤 8 — ChatResponse 扩展**（L312-326）：

```diff
     return {
       success: true,
       answerText,
       intent: intentResult.intent,
+      response_mode: decision?.response_mode || null,
+      domain_intent: decision?.domain_intent || null,
+      task_intent: decision?.task_intent || null,
       references,
       tutorialVideos,
```

> [!NOTE]
> `ChatResponse` 接口新增 `response_mode`, `domain_intent`, `task_intent` 三个可选字段。旧的 `intent` 字段保留。

---

#### [MODIFY] [templateValidator.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/orchestrator/templateValidator.ts)

- 当 `response_mode = RESOURCE_ONLY` 时，跳过模板校验（不应强制补【动作要领】等段落）。
- 函数签名扩展：`validateTemplate(text, intent, responseMode?)`。

---

### 前端适配（最小改动）

---

#### [MODIFY] [geminiService.ts](file:///Users/yingdongma/Documents/Dev/projects/Topstar/client/geminiService.ts)

`ChatResponseV2` 接口新增可选字段：

```diff
 export interface ChatResponseV2 {
   success: boolean;
   answerText: string;
   intent: string;
+  response_mode?: string | null;
+  domain_intent?: string | null;
+  task_intent?: string | null;
   references: { type: string; id: string; title: string }[];
   tutorialVideos: RecommendedTutorial[];
   report?: any;
 }
```

---

#### [MODIFY] [App.tsx](file:///Users/yingdongma/Documents/Dev/projects/Topstar/client/App.tsx)

核心改动在 `handleSendMessage`（L178-199）—— 渲染逻辑改为优先读取 `response_mode`：

```diff
-      if (response.tutorialVideos && response.tutorialVideos.length > 0) {
+      const responseMode = response.response_mode;
+      // RESOURCE_ONLY: 只展示教程列表，不走报告卡
+      if (responseMode === 'RESOURCE_ONLY' && response.tutorialVideos?.length) {
+        parts.push({
+          type: 'tutorial-list',   // 新卡片类型：简洁教程列表
+          tutorialVideos: response.tutorialVideos,
+          isTyping: true,
+        });
+      } else if (response.tutorialVideos && response.tutorialVideos.length > 0) {
         // 原有聚合模式（TEXT_WITH_RESOURCES 或无 response_mode 时的 fallback）
         parts.push({
           type: 'report',
           ...
```

> [!IMPORTANT]
> **必须新增** `TutorialListCard` 前端组件。
> - **用途**：`RESOURCE_ONLY` 模式下的专属展示。
> - **设计**：只包含标题和视频列表横向滑动卡片，**不渲染** summaryText 区域。
> - **位置**：`client/components/TutorialListCard.tsx`。

---

### 评估集

---

#### [NEW] [intent_eval_set_phase2.jsonl](file:///Users/yingdongma/Documents/Dev/projects/Topstar/server/data/intent_eval_set_phase2.jsonl)

至少 30 条测试用例，覆盖设计文档 §11.3 列出的关键案例：

| 用例 | 预期 domain | 预期 task | 预期 response_mode |
|------|------------|----------|-------------------|
| "反手拧拉的视频教程" | ACTION | TUTORIAL | RESOURCE_ONLY |
| "给我几个拧拉教学链接，不用讲解" | ACTION | TUTORIAL | RESOURCE_ONLY |
| "简单说下拧拉重点，再给我视频" | ACTION | TUTORIAL | TEXT_WITH_RESOURCES |
| "反手拧拉怎么练" | ACTION | EXPLAIN | TEXT_WITH_RESOURCES |
| "反手拧拉总出界怎么纠正" | ACTION | DIAGNOSE | TEXT_ONLY |
| "D09C 怎么样" | EQUIPMENT | QA | TEXT_ONLY |
| "D09C 和 K3 怎么选" | EQUIPMENT | COMPARE | COMPARISON_CARD |
| "推荐一套 800 元横板配置" | EQUIPMENT | RECOMMEND | TEXT_ONLY |
| "给我一个7天拧拉训练计划" | ACTION | PLAN | TEXT_ONLY |
| "赌博网站推荐" | OFF_TOPIC | — | — |

---

## 文件变更总览

| 文件 | 操作 | 改动量 |
|------|------|--------|
| `server/intent/types.ts` | **新建** | ~60 行 |
| `server/intent/policy.ts` | **新建** | ~80 行 |
| `server/intent/intentRouter.ts` | 修改 | 中等（LLM prompt + 流程 + fallback） |
| `server/orchestrator/handleChatEvent.ts` | 修改 | 中等（prompt 选择 + 教程判断 + 响应扩展） |
| `server/orchestrator/templateValidator.ts` | 修改 | 小（加 responseMode 旁路） |
| `client/geminiService.ts` | 修改 | 小（接口字段扩展） |
| `client/App.tsx` | 修改 | 中等（渲染分支） |
| `server/data/intent_eval_set_phase2.jsonl` | **新建** | ~30 条 |

---

## Verification Plan

### 1. 确定性单元测试 (Deterministic Tests)
- 编写 `server/tests/intentPolicy.test.ts`
- 覆盖：规则匹配、Policy 修正（如只要视频强转模式）、Adapter 映射。
- 命令：`npm test server/tests/intentPolicy.test.ts`

### 2. LLM 离线评估 (Offline Evaluation)
- 编写 `scripts/run_intent_eval.ts`
- 覆盖：读取 `intent_eval_set_phase2.jsonl` 跑全量回归。
- 命令：`npx tsx server/scripts/run_intent_eval.ts`

### 手动验证

3. **关键场景端到端测试**：启动开发服务器，手动输入设计文档 §11.3 的 7 个关键案例，验证：
   - "反手拧拉的视频教程" → 只返回视频列表，无动作要领段落
   - "D09C 和 K3 怎么选" → 返回对比结构
   - 低置信度输入 → 不默认回到教学模板
4. **前端渲染验证**：确认 `RESOURCE_ONLY` 场景下前端不渲染报告卡。
