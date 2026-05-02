# Change: Phase 2 Core Refactoring

## 状态
- 状态: 规划中 (Proposed)
- 关联 TODO: Phase 2-A & Phase 2-B
- 日期: 2026-05-02

## 目标
1. **视频分析任务化 (Phase 2-A)**: 实现真实的异步任务队列，消灭 Mock 报告。
2. **意图识别层重构 (Phase 2-B)**: 升级为“请求理解式”编排，解决误判与渲染错误。

## 设计决策
- **异步任务化**: 引入 `analysis_jobs` 表与 `AnalysisWorker` 轮询器。
- **意图四层结构**: 拆分为 `domain_intent`, `task_intent`, `response_mode` 和增强型 `entities`。
- **识别流**: 实现 Stage A (Rules) -> Stage B (LLM) -> Stage C (Policy) 的逻辑流。
- **渲染驱动**: 前端严格遵循 `response_mode` 指令进行卡片选择。

## 任务列表
### Phase 2-A: 视频分析任务化
- [ ] **P2-D1** 创建 `analysis_jobs` 表 (SQLite)。
- [ ] **P2-S1** 实现 `AnalysisWorker` 处理逻辑。
- [ ] **P2-S2** 实现阶段 A 处理器（基于用户描述生成诊断）。
- [ ] **P2-F1/F2** 前端适配任务状态轮询与结果渲染。

### Phase 2-B: 意图识别层重构
- [ ] **P2-I1** 实现 `IntentDecision` Schema 及接口。
- [ ] **P2-I2** 升级识别逻辑流程 (Stage A/B/C)。
- [ ] **P2-I3** 实现 Policy 修正层，处理“只要资源”等硬规则。
- [ ] **P2-I4** 构建 50+ 样本的回归测试集 `intent_eval_set_phase2.jsonl`。
- [ ] **P2-F4** 前端适配 `response_mode` 渲染逻辑。
