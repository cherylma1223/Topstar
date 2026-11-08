/**
 * 账号 HTTP 测试：真实 Express 路由 + 内存数据库
 *
 * 覆盖：
 *   - 登录流程（发码 → 登录 → /me → 退出）
 *   - 所有耗额度的接口（对话 / TTS / 创建任务 / 读任务）没登录一律 401
 *   - 任务只能由创建者读取（别人的、历史无主的都是 404）
 *   - 未登录的上传在读取视频内容之前就被拒绝
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';

process.env.VIDEO_ANALYSIS_LOG_DISABLED = '1';

// 路由引入的 ../db 换成内存数据库：既给账号服务用，也给任务路由用
const memdb = new Database(':memory:');
const dbPath = path.resolve(__dirname, '../../db.ts');
const dbModule = new Module(dbPath);
dbModule.exports = { __esModule: true, default: memdb };
(dbModule as any).loaded = true;
require.cache[dbPath] = dbModule;

import express from 'express';
import { AuthService } from '../../auth/service';
import { migrateAuthTables } from '../../auth/schema';
import { __setAuthServiceForTest } from '../../auth';
import type { SmsSender } from '../../auth/sms';

const PHONE_A = '13800000001';
const PHONE_B = '13800000002';

let server: Server;
let baseUrl = '';
let sentCodes: { phone: string; code: string }[] = [];
let nowMs = Date.now();
let seq = 0;

const sender: SmsSender = {
  name: 'fake',
  async sendLoginCode(phone, code) { sentCodes.push({ phone, code }); },
};

before(async () => {
  console.log = () => {};
  console.error = () => {};
  migrateAuthTables(memdb);
  memdb.exec(`
    CREATE TABLE analysis_jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued', analysis_type TEXT NOT NULL DEFAULT 'technique',
      video_path TEXT, video_filename TEXT, video_size INTEGER, video_duration INTEGER, mime_type TEXT,
      report TEXT, error TEXT, user_id TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
    );
  `);
  __setAuthServiceForTest(new AuthService(memdb, {
    secret: 'http-test-secret-http-test-secret-0123',
    sender,
    now: () => nowMs,
    generateCode: () => String(200000 + seq++),
  }));

  const { default: v2Router } = require('../../routes/v2');
  const { default: authRouter } = require('../../routes/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/v2/auth', authRouter);
  app.use('/api/v2', v2Router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  __setAuthServiceForTest(null);
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  sentCodes = [];
  nowMs += 10 * 60 * 1000; // 每个用例之间推进时间，避开发送冷却
  memdb.prepare('DELETE FROM analysis_jobs').run();
});

async function api(method: string, url: string, opts: { body?: unknown; token?: string; raw?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${baseUrl}${url}`, { method, headers, body });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

async function loginAs(phone: string): Promise<string> {
  const send = await api('POST', '/api/v2/auth/sms/send', { body: { phone, consent: true } });
  assert.equal(send.status, 200, JSON.stringify(send.json));
  const code = sentCodes.filter(c => c.phone === phone).at(-1)!.code;
  const login = await api('POST', '/api/v2/auth/login', { body: { phone, code } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return login.json.token as string;
}

test('登录全流程：发码 → 登录 → /me → 退出 → 令牌失效', async () => {
  const send = await api('POST', '/api/v2/auth/sms/send', { body: { phone: PHONE_A, consent: true } });
  assert.equal(send.status, 200);
  assert.equal(send.json.resend_after, 60);
  assert.ok(!JSON.stringify(send.json).includes(sentCodes[0].code), '接口响应里不能带验证码');

  const login = await api('POST', '/api/v2/auth/login', { body: { phone: PHONE_A, code: sentCodes[0].code } });
  assert.equal(login.status, 200);
  assert.equal(login.json.is_new_user, true);
  assert.equal(login.json.user.phone_masked, '138****0001');
  assert.ok(!JSON.stringify(login.json).includes(PHONE_A), '响应里不能出现完整手机号');
  const token = login.json.token as string;

  const me = await api('GET', '/api/v2/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, login.json.user.id);

  const out = await api('POST', '/api/v2/auth/logout', { token });
  assert.equal(out.status, 200);
  assert.equal((await api('GET', '/api/v2/auth/me', { token })).status, 401);
});

test('错误响应：没勾选同意 / 手机号不对 / 验证码错 / 发送太频繁', async () => {
  const noConsent = await api('POST', '/api/v2/auth/sms/send', { body: { phone: PHONE_A } });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.json.error.code, 'CONSENT_REQUIRED');

  const badPhone = await api('POST', '/api/v2/auth/sms/send', { body: { phone: '123', consent: true } });
  assert.equal(badPhone.status, 400);
  assert.equal(badPhone.json.error.code, 'INVALID_PHONE');

  await api('POST', '/api/v2/auth/sms/send', { body: { phone: PHONE_A, consent: true } });
  const wrong = await api('POST', '/api/v2/auth/login', { body: { phone: PHONE_A, code: '000000' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error.code, 'CODE_INVALID');

  const again = await api('POST', '/api/v2/auth/sms/send', { body: { phone: PHONE_A, consent: true } });
  assert.equal(again.status, 429);
  assert.equal(again.json.error.code, 'SMS_TOO_FREQUENT');
  assert.ok(Number(again.headers.get('retry-after')) > 0);

  // 请求体不是 JSON 对象时也不能 500
  const empty = await api('POST', '/api/v2/auth/login', { body: {} });
  assert.equal(empty.status, 400);
});

test('/me、/logout：没带令牌或令牌错误一律 401', async () => {
  for (const [method, url] of [['GET', '/api/v2/auth/me'], ['POST', '/api/v2/auth/logout']] as const) {
    assert.equal((await api(method, url)).status, 401);
    assert.equal((await api(method, url, { token: 'forged' })).status, 401);
    assert.equal((await api(method, url, { headers: { Authorization: 'Basic abc' } })).status, 401);
  }
});

test('耗额度的接口：没登录一律 401（对话 / TTS / 创建任务 / 读任务）', async () => {
  const cases: [string, string, unknown?][] = [
    ['POST', '/api/v2/chat', { message: '你好' }],
    ['POST', '/api/v2/tts', { contentType: 'text', text: '你好' }],
    ['POST', '/api/v2/analysis/jobs'],
    ['GET', '/api/v2/analysis/jobs/any-id'],
  ];
  for (const [method, url, body] of cases) {
    for (const token of [undefined, 'forged-token']) {
      const r = await api(method, url, { body, token });
      assert.equal(r.status, 401, `${method} ${url} token=${token}`);
      assert.equal(r.json.success, false);
      assert.equal(r.json.error.code, 'UNAUTHORIZED');
    }
  }
});

test('不需要登录的接口仍然公开：教程推荐（不会返回 401；内存库里没有教程表，业务层报错与登录无关）', async () => {
  const r = await api('POST', '/api/v2/tutorials/recommend', { body: { query: '正手拉球' } });
  assert.notEqual(r.status, 401);
  const invalid = await api('POST', '/api/v2/tutorials/recommend', { body: {} });
  assert.equal(invalid.status, 400); // 参数校验先于一切，且无需登录
});

test('登录后能通过校验到达业务逻辑（对话缺 message → 400；上传 mimetype 不对 → 400）', async () => {
  const token = await loginAs(PHONE_A);

  const chat = await api('POST', '/api/v2/chat', { token, body: {} });
  assert.equal(chat.status, 400);
  assert.equal(chat.json.error.code, 'INVALID_INPUT');

  const form = new FormData();
  form.append('video', new Blob(['not a video'], { type: 'text/plain' }), 'x.txt');
  const upload = await api('POST', '/api/v2/analysis/jobs', { token, raw: form });
  assert.equal(upload.status, 400);
  assert.equal(upload.json.error.code, 'INVALID_FILE_TYPE');
});

test('任务只能由创建者读取：别人 / 历史无主任务一律 404', async () => {
  const tokenA = await loginAs(PHONE_A);
  const tokenB = await loginAs(PHONE_B);
  const userA = (await api('GET', '/api/v2/auth/me', { token: tokenA })).json.user.id;

  const insert = memdb.prepare(
    `INSERT INTO analysis_jobs (id, status, analysis_type, report, user_id, created_at) VALUES (?, 'done', 'technique', ?, ?, ?)`
  );
  insert.run('job-of-a', JSON.stringify({ techName: '正手拉球' }), userA, new Date().toISOString());
  insert.run('job-legacy', JSON.stringify({ techName: '历史' }), null, new Date().toISOString());

  const own = await api('GET', '/api/v2/analysis/jobs/job-of-a', { token: tokenA });
  assert.equal(own.status, 200);
  assert.equal(own.json.report.techName, '正手拉球');

  const others = await api('GET', '/api/v2/analysis/jobs/job-of-a', { token: tokenB });
  assert.equal(others.status, 404);
  assert.equal(others.json.error.code, 'JOB_NOT_FOUND');
  assert.ok(!JSON.stringify(others.json).includes('正手拉球'), '404 响应里不能带报告内容');

  for (const token of [tokenA, tokenB]) {
    assert.equal((await api('GET', '/api/v2/analysis/jobs/job-legacy', { token })).status, 404);
  }
  assert.equal((await api('GET', '/api/v2/analysis/jobs/job-of-a')).status, 401);
});

test('未登录的上传：在读取视频内容之前就被拒绝，服务器上不留文件', async () => {
  const fs = await import('node:fs');
  const uploadsDir = path.resolve(__dirname, '../../uploads');
  const listing = () => (fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []);
  const before = new Set(listing());

  const form = new FormData();
  form.append('video', new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'video/mp4' }), 'big.mp4');
  const r = await api('POST', '/api/v2/analysis/jobs', { raw: form });

  // 万一鉴权失效导致文件落盘，先清理掉，避免测试在真实 uploads 目录留下垃圾，再断言
  const leaked = listing().filter(name => !before.has(name));
  for (const name of leaked) fs.rmSync(path.join(uploadsDir, name), { force: true });

  assert.equal(r.status, 401);
  assert.deepEqual(leaked, [], '未登录的请求不应该有任何文件落盘');
  assert.equal((memdb.prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get() as any).n, 0);
});
