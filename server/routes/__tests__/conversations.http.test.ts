/**
 * 会话历史 HTTP 测试：真实 Express 路由 + 内存数据库
 *
 * 覆盖：
 *   - 未登录一律 401
 *   - 新建 / 列表 / 详情的字段形态
 *   - 标题模糊搜索（命中、未命中、% 转义）
 *   - 改标题
 *   - 追加消息（含参数校验）
 *   - 别人的会话一律 404（GET / PATCH / POST messages）
 *   - POST /chat 落库：自动建会话、回传 conversation_id、重试幂等
 *
 * /chat 的真实编排（LLM）被替换成桩，测试只关心落库行为。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';

process.env.VIDEO_ANALYSIS_LOG_DISABLED = '1';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';

// 1) ../db 换成内存库
const memdb = new Database(':memory:');
const dbPath = path.resolve(__dirname, '../../db.ts');
const dbModule = new Module(dbPath);
dbModule.exports = { __esModule: true, default: memdb };
(dbModule as any).loaded = true;
require.cache[dbPath] = dbModule;

// 2) 编排层换成桩：不调真实 LLM
const orchestratorPath = path.resolve(__dirname, '../../orchestrator/handleChatEvent.ts');
const orchestratorStub = new Module(orchestratorPath);
orchestratorStub.exports = {
  __esModule: true,
  handleChatEvent: async (req: { message: string }) => ({
    success: true,
    answerText: `回答：${req.message}`,
    intent: 'ACTION_COACHING',
    references: [{ type: 'actions_doc', id: 'bh_loop', title: '反手拧拉' }],
    tutorialVideos: [],
    report: null,
    meta: {
      request_id: 'test-request',
      cost: { input_tokens: 0, output_tokens: 0 },
      degraded: false,
      intent_source: 'rules',
      intent_confidence: 1,
    },
  }),
};
(orchestratorStub as any).loaded = true;
require.cache[orchestratorPath] = orchestratorStub;

import express from 'express';
import { AuthService } from '../../auth/service';
import { migrateAuthTables } from '../../auth/schema';
import { __setAuthServiceForTest } from '../../auth';
import type { SmsSender } from '../../auth/sms';
import { migrateConversationTables } from '../../conversations/schema';

const PHONE_A = '13900000001';
const PHONE_B = '13900000002';

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
  migrateConversationTables(memdb);

  __setAuthServiceForTest(new AuthService(memdb, {
    secret: 'http-test-secret-http-test-secret-0123',
    sender,
    now: () => nowMs,
    generateCode: () => String(300000 + seq++),
  }));

  const { default: v2Router } = require('../../routes/v2');
  const { default: authRouter } = require('../../routes/auth');
  const { default: conversationsRouter } = require('../../routes/conversations');

  const app = express();
  app.use(express.json());
  app.use('/api/v2/auth', authRouter);
  app.use('/api/v2/conversations', conversationsRouter);
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
  nowMs += 10 * 60 * 1000; // 每轮推进时间，避开短信冷却
  memdb.prepare('DELETE FROM conversation_messages').run();
  memdb.prepare('DELETE FROM conversations').run();
});

async function api(
  method: string,
  url: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${baseUrl}${url}`, { method, headers, body });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function loginAs(phone: string): Promise<string> {
  const send = await api('POST', '/api/v2/auth/sms/send', { body: { phone, consent: true } });
  assert.equal(send.status, 200, JSON.stringify(send.json));
  const code = sentCodes.filter(c => c.phone === phone).at(-1)!.code;
  const login = await api('POST', '/api/v2/auth/login', { body: { phone, code } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return login.json.token as string;
}

test('未登录：会话接口一律 401', async () => {
  assert.equal((await api('GET', '/api/v2/conversations')).status, 401);
  assert.equal((await api('POST', '/api/v2/conversations', { body: {} })).status, 401);
  assert.equal((await api('GET', '/api/v2/conversations/abc')).status, 401);
  assert.equal((await api('PATCH', '/api/v2/conversations/abc', { body: { title: 'x' } })).status, 401);
  assert.equal((await api('POST', '/api/v2/conversations/abc/messages', { body: { messages: [] } })).status, 401);

  const forged = await api('GET', '/api/v2/conversations', { token: 'forged' });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.error.code, 'UNAUTHORIZED');
});

test('新建 → 列表 → 详情 → 改标题 → 追加消息', async () => {
  const token = await loginAs(PHONE_A);

  const created = await api('POST', '/api/v2/conversations', {
    token,
    body: { title: '反手拧拉总下网怎么办', service: '当家球星' },
  });
  assert.equal(created.status, 201);
  const id = created.json.conversation.id as string;
  assert.equal(created.json.conversation.title, '反手拧拉总下网怎么办');
  assert.equal(created.json.conversation.message_count, 0);

  const list = await api('GET', '/api/v2/conversations', { token });
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.query, null);
  assert.equal(list.json.items[0].id, id);

  const appended = await api('POST', `/api/v2/conversations/${id}/messages`, {
    token,
    body: {
      messages: [
        { role: 'user', content: '反手拧拉总下网怎么办', client_msg_id: 'c-1' },
        { role: 'assistant', content: '触球点偏晚', payload: [{ type: 'text', content: '触球点偏晚' }] },
      ],
    },
  });
  assert.equal(appended.status, 200);
  assert.equal(appended.json.inserted, 2);
  assert.equal(appended.json.conversation.message_count, 2);

  // 幂等：同一个 client_msg_id 再来一次
  const again = await api('POST', `/api/v2/conversations/${id}/messages`, {
    token,
    body: { messages: [{ role: 'user', content: '反手拧拉总下网怎么办', client_msg_id: 'c-1' }] },
  });
  assert.equal(again.json.inserted, 0);
  assert.equal(again.json.skipped, 1);

  const detail = await api('GET', `/api/v2/conversations/${id}`, { token });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.conversation.messages.map((m: any) => m.seq), [1, 2]);
  assert.deepEqual(detail.json.conversation.messages.map((m: any) => m.role), ['user', 'assistant']);
  assert.ok(detail.json.conversation.messages[1].payload.includes('触球点偏晚'));

  const renamed = await api('PATCH', `/api/v2/conversations/${id}`, { token, body: { title: '反手 · 触球点' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.conversation.title, '反手 · 触球点');
});

test('模糊搜索：命中标题、大小写不敏感、% 不当通配符、无命中为空', async () => {
  const token = await loginAs(PHONE_A);
  await api('POST', '/api/v2/conversations', { token, body: { title: '反手拧拉总下网怎么办' } });
  await api('POST', '/api/v2/conversations', { token, body: { title: 'Forehand Loop 发力' } });
  await api('POST', '/api/v2/conversations', { token, body: { title: '命中率 100% 的训练' } });
  await api('POST', '/api/v2/conversations', { token, body: { title: '命中率 100 的训练' } });

  const hit = await api('GET', '/api/v2/conversations?q=' + encodeURIComponent('反手'), { token });
  assert.equal(hit.status, 200);
  assert.equal(hit.json.query, '反手');
  assert.equal(hit.json.total, 1);
  assert.equal(hit.json.items[0].title, '反手拧拉总下网怎么办');
  assert.ok(hit.json.items[0].snippet.includes('反手'));

  const ci = await api('GET', '/api/v2/conversations?q=forehand', { token });
  assert.equal(ci.json.total, 1);

  const pct = await api('GET', '/api/v2/conversations?q=' + encodeURIComponent('100%'), { token });
  assert.equal(pct.json.total, 1, '% 必须被转义');

  const none = await api('GET', '/api/v2/conversations?q=' + encodeURIComponent('不存在'), { token });
  assert.equal(none.status, 200);
  assert.equal(none.json.total, 0);
  assert.deepEqual(none.json.items, []);

  // 空搜索词退回列表
  const blank = await api('GET', '/api/v2/conversations?q=%20%20', { token });
  assert.equal(blank.json.total, 4);
  assert.equal(blank.json.query, null);
});

test('越权：别人的会话一律 404（详情 / 改标题 / 追加消息）', async () => {
  const tokenA = await loginAs(PHONE_A);
  const tokenB = await loginAs(PHONE_B);

  const created = await api('POST', '/api/v2/conversations', { token: tokenA, body: { title: 'A 的会话' } });
  const id = created.json.conversation.id as string;

  for (const [method, url, body] of [
    ['GET', `/api/v2/conversations/${id}`, undefined],
    ['PATCH', `/api/v2/conversations/${id}`, { title: '抢改' }],
    ['POST', `/api/v2/conversations/${id}/messages`, { messages: [{ role: 'user', content: '偷偷写' }] }],
  ] as const) {
    const res = await api(method as string, url as string, { token: tokenB, body });
    assert.equal(res.status, 404, `${method} ${url} 应该是 404`);
    assert.equal(res.json.error.code, 'CONVERSATION_NOT_FOUND');
  }

  // B 的列表里看不到 A 的会话
  const listB = await api('GET', '/api/v2/conversations', { token: tokenB });
  assert.equal(listB.json.total, 0);

  // A 自己还能正常读
  assert.equal((await api('GET', `/api/v2/conversations/${id}`, { token: tokenA })).status, 200);
});

test('参数校验：空标题 / 空 messages / 非法角色一律 400', async () => {
  const token = await loginAs(PHONE_A);
  const created = await api('POST', '/api/v2/conversations', { token, body: { title: '用例' } });
  const id = created.json.conversation.id as string;

  const emptyTitle = await api('PATCH', `/api/v2/conversations/${id}`, { token, body: { title: '   ' } });
  assert.equal(emptyTitle.status, 400);
  assert.equal(emptyTitle.json.error.code, 'INVALID_INPUT');

  const noMessages = await api('POST', `/api/v2/conversations/${id}/messages`, { token, body: { messages: [] } });
  assert.equal(noMessages.status, 400);

  const badRole = await api('POST', `/api/v2/conversations/${id}/messages`, {
    token,
    body: { messages: [{ role: 'system', content: 'x' }] },
  });
  assert.equal(badRole.status, 400);
});

test('POST /chat：自动建会话、回传 conversation_id、重试幂等', async () => {
  const token = await loginAs(PHONE_A);

  const first = await api('POST', '/api/v2/chat', {
    token,
    body: { message: '反手拧拉总是下网', history: [], client_msg_id: 'chat-1', service: '当家球星' },
  });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.ok(first.json.conversation_id, '必须回传 conversation_id');
  assert.ok(first.json.assistant_message_id);
  const conversationId = first.json.conversation_id as string;

  const detail = await api('GET', `/api/v2/conversations/${conversationId}`, { token });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.conversation.messages.length, 2);
  assert.equal(detail.json.conversation.messages[0].role, 'user');
  assert.equal(detail.json.conversation.messages[1].role, 'assistant');
  assert.equal(detail.json.conversation.messages[0].content, '反手拧拉总是下网');
  // 标题由首条消息派生（不足 10 字原样，超过才截断加省略号）
  assert.equal(detail.json.conversation.title, '反手拧拉总是下网');

  // 同一 client_msg_id 重试：不重复写
  const retry = await api('POST', '/api/v2/chat', {
    token,
    body: { message: '反手拧拉总是下网', history: [], client_msg_id: 'chat-1', conversation_id: conversationId },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.conversation_id, conversationId);
  assert.equal(
    (await api('GET', `/api/v2/conversations/${conversationId}`, { token })).json.conversation.messages.length,
    2,
  );

  // 继续追问：带 conversation_id 追加同一会话
  const second = await api('POST', '/api/v2/chat', {
    token,
    body: { message: '那怎么练', history: [], conversation_id: conversationId, client_msg_id: 'chat-2' },
  });
  assert.equal(second.json.conversation_id, conversationId);
  const after = await api('GET', `/api/v2/conversations/${conversationId}`, { token });
  assert.equal(after.json.conversation.messages.length, 4);
  assert.deepEqual(after.json.conversation.messages.map((m: any) => m.seq), [1, 2, 3, 4]);
});

test('POST /chat：别人的 conversation_id → 404，且不落库', async () => {
  const tokenA = await loginAs(PHONE_A);
  const tokenB = await loginAs(PHONE_B);

  const created = await api('POST', '/api/v2/conversations', { token: tokenA, body: { title: 'A 的会话' } });
  const id = created.json.conversation.id as string;

  const res = await api('POST', '/api/v2/chat', {
    token: tokenB,
    body: { message: '插一句', history: [], conversation_id: id },
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'CONVERSATION_NOT_FOUND');

  const detail = await api('GET', `/api/v2/conversations/${id}`, { token: tokenA });
  assert.equal(detail.json.conversation.messages.length, 0, '被拒绝的请求不能写进别人的会话');
});
