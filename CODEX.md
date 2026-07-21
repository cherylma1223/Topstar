# CODEX.md — Topstar（当家球星）项目指令

## 视频分析全链路追踪报告

当用户上传视频后要求「查看系统处理关键环节」时，按 `docs/video-analysis-report-template.md` 模板输出报告。

模板包含：完整报告结构（总览→上传→Pass 1切割→Pass 1.5分类→Pass 2诊断→教程推荐→清理）、耗时计算公式、完整示例、故障排查备忘。

### 数据提取命令

```bash
# 查最新任务
cd server && npx tsx -e "
const Database = require('better-sqlite3');
const db = new Database('./data/topstar.db', { readonly: true });
const rows = db.prepare('SELECT id, status, analysis_type, model, error, video_filename, created_at, completed_at FROM analysis_jobs ORDER BY created_at DESC LIMIT 5').all();
console.log(JSON.stringify(rows, null, 2));
db.close();
"

# 定位 Stage 标记
grep -n "<jobId>" server/video_analysis.log

# 查最新 Stage
grep -n "JOB_START\|JOB_FAILED\|JOB_SUCCESS" server/video_analysis.log | tail -5
```

### ⏰ 时区规则（重要）

`server/video_analysis.log` 时间戳是 **UTC**（末尾带 `Z`），用户在北京时区 UTC+8。展示前 **必须 +8 小时**转北京时间。

---

## 架构速览

| 服务 | 命令 | 端口 |
|------|------|------|
| 后端 | `cd server && npm run dev` | 3001 |
| 前端 | `cd client && npm run dev` | 3000 |

更多架构细节见 `CLAUDE.md`。
