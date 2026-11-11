/**
 * 评测集标注工具（本地网页版）
 *
 * 给教练用：左边选视频，右边看片 + 下拉/勾选标注。改动自动保存回
 * eval/labels/annotations.csv —— 和 `npm run eval -- validate` 读的是同一个文件，
 * 序列化/校验直接复用 server/eval/lib 的代码，保证格式不会漂。
 *
 * 运行：
 *   cd server && npm run labeler           # 默认 http://127.0.0.1:3100
 *
 * 可选环境变量：
 *   LABELER_PORT=3100   LABELER_HOST=127.0.0.1
 *   LABELER_LABELS=...  标注文件路径（默认 eval/labels/annotations.csv）
 *   LABELER_VIDEOS=...  视频目录（默认 eval/videos）
 *   LABELER_NO_OPEN=1   不自动打开浏览器
 *
 * 特性：不引入新依赖、不连数据库、不调用任何模型。
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import {
  COLUMNS, parseAnnotationRows, validateAnnotations,
  type Annotation, type Interval, type Knowledge,
} from '../../server/eval/lib/annotations';
import { CSV_BOM, parseCsv, toCsvLine } from '../../server/eval/lib/csv';
import { annotationTemplate } from '../../server/eval/lib/template';

// ─── 路径与配置 ────────────────────────────────────────────────────
const LABELER_DIR = __dirname;
const REPO_ROOT = path.resolve(LABELER_DIR, '..', '..');
const PUBLIC_DIR = path.join(LABELER_DIR, 'public');
const SERVER_DIR = path.join(REPO_ROOT, 'server');

const VIDEOS_DIR = path.resolve(process.env.LABELER_VIDEOS || path.join(REPO_ROOT, 'eval', 'videos'));
const LABELS_FILE = path.resolve(process.env.LABELER_LABELS || path.join(REPO_ROOT, 'eval', 'labels', 'annotations.csv'));
const PORT = Number(process.env.LABELER_PORT) || 3100;
const HOST = (process.env.LABELER_HOST || '127.0.0.1').trim();

// ─── 知识库（动作名、问题点）──────────────────────────────────────
function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

const ACTION_ALIASES = readJson<{ actions: { id: string; title: string; aliases: string[] }[] }>(
  path.join(SERVER_DIR, 'data', 'action_aliases.json')
);
const DIAG = readJson<{ rules: { action_id: string; issue_id: string; problem: string; evidence: string; priority: number }[] }>(
  path.join(SERVER_DIR, 'data', 'action_diagnosis_rules.json')
);
const RECOG = readJson<{ actions: { id: string; title: string }[] }>(
  path.join(SERVER_DIR, 'data', 'action_video_analysis_knowledge.json')
);

const ACTIONS = ACTION_ALIASES.actions.map(a => ({ id: a.id, title: a.title, aliases: a.aliases || [] }));

const RULES_BY_ACTION: Record<string, { issueId: string; problem: string; evidence: string; priority: number }[]> = {};
for (const r of DIAG.rules) {
  (RULES_BY_ACTION[r.action_id] ||= []).push({
    issueId: r.issue_id, problem: r.problem, evidence: r.evidence, priority: r.priority,
  });
}
for (const list of Object.values(RULES_BY_ACTION)) list.sort((a, b) => a.priority - b.priority);

const KNOWLEDGE: Knowledge = {
  actionIds: RECOG.actions.map(a => a.id),
  issueIdsByAction: Object.fromEntries(
    Object.entries(RULES_BY_ACTION).map(([actionId, rules]) => [actionId, rules.map(r => r.issueId)])
  ),
};

// ─── 行数据模型 ────────────────────────────────────────────────────
/** 与 CSV 一一对应的行状态；segments/issues 的 'none' 表示「明确没有」，null 表示「没标注」 */
interface RowState {
  videoId: string;
  videoFile: string;
  actionId: string;                          // '' | 'none' | 动作 ID
  segments: Interval[] | 'none' | null;
  hasVoice: boolean | null;
  issues: string[] | 'none' | null;
  tags: string[];
  notes: string;
  sourceJob: string;
}

function toRowState(a: Annotation): RowState {
  return {
    videoId: a.videoId,
    videoFile: a.videoFile,
    actionId: a.actionId ?? '',
    segments: a.segments === undefined ? null : (a.segments.length === 0 ? 'none' : a.segments),
    hasVoice: a.hasVoice ?? null,
    issues: a.issues === undefined ? null : (a.issues.length === 0 ? 'none' : a.issues),
    tags: a.tags,
    notes: a.notes ?? '',
    sourceJob: a.sourceJob ?? '',
  };
}

let rows: RowState[] = [];
let lastSavedAt = new Date().toISOString();
let loadErrors: string[] = [];

const DEFAULT_COMMENTS = annotationTemplate()
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .filter(l => l.trimStart().startsWith('#'));

function loadFromDisk(): void {
  if (!fs.existsSync(LABELS_FILE)) {
    fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true });
    fs.writeFileSync(LABELS_FILE, annotationTemplate(), 'utf8');
  }
  const parsed = parseAnnotationRows(parseCsv(fs.readFileSync(LABELS_FILE, 'utf8')));
  rows = parsed.annotations.map(toRowState);
  loadErrors = parsed.errors;
}

// ─── 序列化 / 保存 ─────────────────────────────────────────────────
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 秒 → mm:ss.s（保留一位小数，避免取整后起止相等） */
function fmtSeconds(t: number): string {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${pad2(m)}:${s.toFixed(1).padStart(4, '0')}`;
}

function cellSegments(v: RowState['segments']): string {
  if (v === null) return '';
  if (v === 'none') return 'none';
  return v.map(s => `${fmtSeconds(s.start)}-${fmtSeconds(s.end)}`).join('; ');
}

function rowToCells(r: RowState): string[] {
  return [
    r.videoId,
    r.videoFile,
    r.actionId,
    cellSegments(r.segments),
    r.hasVoice === null ? '' : (r.hasVoice ? 'yes' : 'no'),
    r.issues === null ? '' : (r.issues === 'none' ? 'none' : r.issues.join('; ')),
    r.tags.join('; '),
    r.notes,
    r.sourceJob,
  ];
}

function rowsToCsv(list: RowState[]): string {
  const body = list.map(r => toCsvLine(rowToCells(r))).join('\n');
  return CSV_BOM + DEFAULT_COMMENTS.join('\n') + '\n' + toCsvLine([...COLUMNS]) + '\n' + (body ? body + '\n' : '');
}

function saveRows(list: RowState[]): { ok: boolean; errors: string[]; warnings: string[] } {
  const text = rowsToCsv(list);
  const parsed = parseAnnotationRows(parseCsv(text));
  const report = validateAnnotations(parsed.annotations, KNOWLEDGE, { videosDir: VIDEOS_DIR });
  const errors = [...parsed.errors, ...report.errors];
  if (errors.length > 0) return { ok: false, errors, warnings: report.warnings };

  fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true });
  const tmp = `${LABELS_FILE}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  if (fs.existsSync(LABELS_FILE)) fs.copyFileSync(LABELS_FILE, `${LABELS_FILE}.bak`);
  fs.renameSync(tmp, LABELS_FILE);
  lastSavedAt = new Date().toISOString();
  return { ok: true, errors: [], warnings: report.warnings };
}

// ─── 视频文件 ──────────────────────────────────────────────────────
function listVideoFiles(): string[] {
  try {
    return fs.readdirSync(VIDEOS_DIR).filter(f => !f.startsWith('.'));
  } catch {
    return [];
  }
}

/** 先精确匹配，再大小写无关匹配（macOS 上 dppbl.MOV / dppbl.mov 常混） */
function resolveVideoFile(name: string, files = listVideoFiles()): string | null {
  if (!name) return null;
  if (files.includes(name)) return name;
  const hit = files.find(f => f.toLowerCase() === name.toLowerCase());
  return hit ?? null;
}

function makeVideoId(file: string): string {
  const base = path.basename(file, path.extname(file));
  let id = base.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  if (!id) id = 'video';
  const taken = new Set(rows.map(r => r.videoId));
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) {
    const candidate = `${id}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function addVideo(file: string): { ok: boolean; error?: string; row?: RowState } {
  const real = resolveVideoFile(file);
  if (!real) return { ok: false, error: '找不到这个视频文件' };
  if (rows.some(r => r.videoFile.toLowerCase() === real.toLowerCase())) {
    return { ok: false, error: '这个视频已经在评测集里了' };
  }
  const row: RowState = {
    videoId: makeVideoId(real), videoFile: real, actionId: '',
    segments: null, hasVoice: null, issues: null, tags: [], notes: '', sourceJob: '',
  };
  rows.push(row);
  return { ok: true, row };
}

// ─── HTTP 工具 ──────────────────────────────────────────────────────
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function getState() {
  const files = listVideoFiles();
  const annotated = rows.filter(r => r.actionId && r.actionId !== '').length;
  return {
    labelsFile: path.relative(REPO_ROOT, LABELS_FILE),
    videosDir: path.relative(REPO_ROOT, VIDEOS_DIR),
    savedAt: lastSavedAt,
    progress: { done: annotated, total: rows.length },
    actions: ACTIONS,
    rulesByAction: RULES_BY_ACTION,
    rows: rows.map(r => ({ ...r, fileExists: !!resolveVideoFile(r.videoFile, files) })),
    unregistered: files
      .filter(f => !rows.some(r => r.videoFile.toLowerCase() === f.toLowerCase()))
      .map(f => {
        let sizeBytes = 0;
        try { sizeBytes = fs.statSync(path.join(VIDEOS_DIR, f)).size; } catch { /* ignore */ }
        return { file: f, suggestedId: makeVideoId(f), sizeBytes };
      })
      .sort((a, b) => a.file.localeCompare(b.file)),
    loadErrors,
  };
}

// ─── 视频流（支持 Range，浏览器才能拖进度条）────────────────────────
const MIME: Record<string, string> = {
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

function serveVideo(req: http.IncomingMessage, res: http.ServerResponse, name: string): void {
  const file = resolveVideoFile(name);
  if (!file) { sendJson(res, 404, { error: '视频不存在' }); return; }
  const full = path.join(VIDEOS_DIR, file);
  let stat: fs.Stats;
  try { stat = fs.statSync(full); } catch { sendJson(res, 404, { error: '视频不存在' }); return; }

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': stat.size,
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) { sendJson(res, 416, { error: 'Range 不合法' }); return; }
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : stat.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  end = Math.min(end, stat.size - 1);
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full, { start, end }).pipe(res);
}

// ─── 静态文件 ──────────────────────────────────────────────────────
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

function serveStatic(res: http.ServerResponse, p: string): void {
  const hit = STATIC[p];
  if (!hit) { sendJson(res, 404, { error: 'Not Found' }); return; }
  res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(path.join(PUBLIC_DIR, hit.file)));
}

// ─── 路由 ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'GET' && p === '/api/state') {
      sendJson(res, 200, getState());
      return;
    }

    if (req.method === 'GET' && p === '/api/validate') {
      const parsed = parseAnnotationRows(parseCsv(fs.readFileSync(LABELS_FILE, 'utf8')));
      const report = validateAnnotations(parsed.annotations, KNOWLEDGE, { videosDir: VIDEOS_DIR });
      sendJson(res, 200, { errors: [...parsed.errors, ...report.errors], warnings: report.warnings });
      return;
    }

    if (req.method === 'GET' && p === '/api/download') {
      const text = fs.readFileSync(LABELS_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="annotations.csv"',
      });
      res.end(text);
      return;
    }

    if (req.method === 'POST' && p === '/api/save') {
      const body = await readBody(req);
      if (!Array.isArray(body?.rows)) { sendJson(res, 400, { error: '缺少 rows' }); return; }
      const next = body.rows as RowState[];
      const result = saveRows(next);
      if (result.ok) rows = next;
      sendJson(res, result.ok ? 200 : 400, { ...result, savedAt: lastSavedAt, state: result.ok ? getState() : undefined });
      return;
    }

    if (req.method === 'POST' && p === '/api/add') {
      const body = await readBody(req);
      const result = addVideo(String(body?.file || ''));
      if (!result.ok) { sendJson(res, 400, { error: result.error }); return; }
      const saved = saveRows(rows);
      if (!saved.ok) {
        rows = rows.filter(r => r !== result.row);
        sendJson(res, 400, { error: saved.errors.join('；') });
        return;
      }
      sendJson(res, 200, { row: result.row, state: getState() });
      return;
    }

    if (req.method === 'GET' && p.startsWith('/videos/')) {
      serveVideo(req, res, p.slice('/videos/'.length));
      return;
    }

    serveStatic(res, p);
  } catch (err: any) {
    console.error('[labeler] 请求处理失败：', err?.message || err);
    sendJson(res, 500, { error: err?.message || '服务器内部错误' });
  }
});

// ─── 启动 ──────────────────────────────────────────────────────────
loadFromDisk();

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/ `;
  console.log('');
  console.log('  评测集标注工具已启动');
  console.log(`  浏览器打开：http://${HOST}:${PORT}/ `);
  console.log(`  标注文件：${path.relative(REPO_ROOT, LABELS_FILE)}`);
  console.log(`  视频目录：${path.relative(REPO_ROOT, VIDEOS_DIR)}`);
  console.log(`  已有视频 ${rows.length} 条（已标注动作 ${rows.filter(r => r.actionId).length} 条），改动自动保存`);
  console.log('  按 Ctrl+C 退出');
  console.log('');

  if (process.platform === 'darwin' && !process.env.LABELER_NO_OPEN) {
    try { spawn('open', [url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 打开失败不影响使用 */ }
  }
});

process.on('SIGINT', () => {
  console.log('\n[labeler] 已退出');
  server.close();
  process.exit(0);
});
