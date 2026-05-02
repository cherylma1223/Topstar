# OpenSpec in Topstar

本项目采用 OpenSpec 框架进行规格驱动开发 (SDD)。

## 目录结构

- `openspec/specs/`: 系统的长期规格说明书。反映了项目的当前“真实状态”。
- `openspec/changes/`: 正在进行或已完成的变更提案。
  - `archived/`: 已合入代码库并同步到 Specs 的历史变更。

## 工作流

1. **Propose**: 在 `changes/` 创建一个新的 `.md` 文件，定义变更目标、设计方案和任务列表。
2. **Apply**: AI 按照任务列表执行修改。
3. **Archive**: 任务完成后，将变更点同步更新到 `specs/` 中的相关文档，并将变更提案移至 `archived/`。
