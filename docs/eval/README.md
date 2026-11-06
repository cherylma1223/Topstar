# 测评与回归测试材料

本目录用于存放模型测评、A/B 对比、回归测试相关的报告与原始数据。

## 目录约定

```
docs/eval/
  README.md                 # 本索引
  YYYY-MM-DD-<topic>.md     # 测评/回归报告
  raw/
    YYYY-MM-DD/             # 与报告同日的原始结果（API 返回 JSON、日志摘录等）
```

- 报告文件按日期命名，一篇报告对应一次测评或一轮回归
- 原始结果必须保留，便于复核和后续 diff
- 报告中需注明：模型版本、视频样本、运行配置、判定标准、局限性

## 已有记录

| 日期 | 报告 | 内容 |
|---|---|---|
| 2026-11-06 | [Gemini 视频模型测评](2026-11-06-gemini-video-model-comparison.md) | `3.1-pro` / `4-argon` / `3.8-flash` 单视频 A/B |

## 待建设

最小回归测试集尚未搭建，规划结构：

```
eval/
  videos/      # 视频样本（覆盖不同动作、机位、光照、无效片段）
  labels/      # 人工标注：片段边界、动作 ID、已知问题点
  baseline/    # 冻结的 golden 输出（含模型版本）
  run.ts       # 批量执行、结果收集、与 baseline diff
  report.md    # 自动生成的对比报告
```

指标与门槛参见 `2026-11-06-gemini-video-model-comparison.md` 第 7 节。
