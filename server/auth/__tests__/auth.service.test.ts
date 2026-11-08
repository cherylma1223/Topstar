/**
 * 账号服务测试（内存数据库 + 假短信 + 可控时钟）
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { AuthService, getAuthSecret } from '../service';
import { AuthError } from '../errors';
import { migrateAuthTables } from '../schema';
import { maskPhone, normalizePhone } from '../phone';
import { createSmsSender, getFixedCode } from '../sms';
import type { SmsSender } from '../sms';

const SECRET = 'unit-test-secret-unit-test-secret-0123';
const PHONE = '13800138000';

let db: Database.Database;
let sent: { phone: string; code: string }[];
let nowMs: number;
let sendShouldFail: boolean;
let codeSeq: number;

const sender: SmsSender = {
  name: 'fake',
  async sendLoginCode(phone, code) {
    if (sendShouldFail) throw new Error('provider down');
    sent.push({ phone, code });
  },
};

function makeService(overrides: Partial<ConstructorParameters<typeof AuthService>[1]> = {}) {
  return new AuthService(db, {
    secret: SECRET,
    sender,
    now: () => nowMs,
    generateCode: () => String(100000 + codeSeq++),
    ...overrides,
  });
}

async function rejectsWith(promise: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (err) {
    assert.ok(err instanceof AuthError, `应该抛 AuthError，实际：${err}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`应该抛 ${code}，但没有抛错`);
}

beforeEach(() => {
  db = new Database(':memory:');
  migrateAuthTables(db);
  sent = [];
  nowMs = 1_800_000_000_000;
  sendShouldFail = false;
  codeSeq = 0;
  console.error = () => {};
});

// ─── 手机号 ────────────────────────────────────────────────────────────────

test('normalizePhone：接受 +86 / 86 / 空格 / 连字符，拒绝非大陆号码', () => {
  assert.equal(normalizePhone('13800138000'), '13800138000');
  assert.equal(normalizePhone('138 0013 8000'), '13800138000');
  assert.equal(normalizePhone('138-0013-8000'), '13800138000');
  assert.equal(normalizePhone('+8613800138000'), '13800138000');
  assert.equal(normalizePhone('8613800138000'), '13800138000');
  for (const bad of ['', '1380013800', '138001380000', '12800138000', '23800138000', 'abcdefghijk', null, undefined, 13800138000, {}]) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
  assert.equal(maskPhone('13800138000'), '138****8000');
});

// ─── 发送验证码 ────────────────────────────────────────────────────────────

test('没勾选同意：不发短信', async () => {
  const svc = makeService();
  for (const consent of [undefined, false, 'true', 1, null]) {
    await rejectsWith(svc.sendCode({ phone: PHONE, consent }), 'CONSENT_REQUIRED');
  }
  assert.equal(sent.length, 0);
});

test('手机号不对：不发短信', async () => {
  const svc = makeService();
  await rejectsWith(svc.sendCode({ phone: '123', consent: true }), 'INVALID_PHONE');
  assert.equal(sent.length, 0);
});

test('发送成功：验证码以哈希入库，不存明文', async () => {
  const svc = makeService();
  const r = await svc.sendCode({ phone: PHONE, consent: true, ip: '1.1.1.1' });
  assert.equal(r.resendAfterSeconds, 60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, PHONE);
  const rows = db.prepare('SELECT * FROM sms_codes').all() as any[];
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(sent[0].code), '数据库里不应出现验证码明文');
  assert.ok(!JSON.stringify(rows).includes(PHONE), '数据库里不应出现手机号明文');
});

test('同一手机号 60 秒内只能发一次，过了冷却可以再发', async () => {
  const svc = makeService();
  await svc.sendCode({ phone: PHONE, consent: true });
  const err = await rejectsWith(svc.sendCode({ phone: PHONE, consent: true }), 'SMS_TOO_FREQUENT') as AuthError;
  assert.ok((err.retryAfterSeconds ?? 0) > 0 && (err.retryAfterSeconds ?? 0) <= 60);
  assert.equal(sent.length, 1);

  nowMs += 61_000;
  await svc.sendCode({ phone: PHONE, consent: true });
  assert.equal(sent.length, 2);
});

test('并发连发两次：只有一条短信发出去', async () => {
  const svc = makeService();
  const results = await Promise.allSettled([
    svc.sendCode({ phone: PHONE, consent: true }),
    svc.sendCode({ phone: PHONE, consent: true }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(sent.length, 1);
});

test('同一手机号每天最多 10 条', async () => {
  const svc = makeService();
  for (let i = 0; i < 10; i++) {
    await svc.sendCode({ phone: PHONE, consent: true });
    nowMs += 61_000;
  }
  await rejectsWith(svc.sendCode({ phone: PHONE, consent: true }), 'SMS_DAILY_LIMIT');
  assert.equal(sent.length, 10);

  nowMs += 24 * 60 * 60 * 1000; // 第二天恢复
  await svc.sendCode({ phone: PHONE, consent: true });
  assert.equal(sent.length, 11);
});

test('同一 IP 每天最多 30 条（换手机号也一样）', async () => {
  const svc = makeService();
  for (let i = 0; i < 30; i++) {
    await svc.sendCode({ phone: `1380000${String(1000 + i)}`, consent: true, ip: '9.9.9.9' });
  }
  await rejectsWith(svc.sendCode({ phone: '13900000000', consent: true, ip: '9.9.9.9' }), 'SMS_DAILY_LIMIT');
  await svc.sendCode({ phone: '13900000000', consent: true, ip: '8.8.8.8' }); // 别的 IP 不受影响
});

test('短信服务商失败：返回 SMS_SEND_FAILED，不占用冷却和每日次数', async () => {
  const svc = makeService();
  sendShouldFail = true;
  await rejectsWith(svc.sendCode({ phone: PHONE, consent: true }), 'SMS_SEND_FAILED');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sms_codes').get() as any).n, 0);

  sendShouldFail = false;
  await svc.sendCode({ phone: PHONE, consent: true }); // 马上重试可以成功
  assert.equal(sent.length, 1);
});

// ─── 登录 ──────────────────────────────────────────────────────────────────

async function sendAndGetCode(svc: AuthService, phone = PHONE) {
  await svc.sendCode({ phone, consent: true });
  return sent.at(-1)!.code;
}

test('正确验证码：新手机号自动注册并返回令牌；老用户再登录是同一个账号', async () => {
  const svc = makeService();
  const code = await sendAndGetCode(svc);
  const first = svc.login({ phone: PHONE, code });
  assert.equal(first.isNewUser, true);
  assert.equal(first.user.phoneMasked, '138****8000');
  assert.ok(first.token.length >= 40);
  assert.equal(first.expiresAt, nowMs + 30 * 24 * 60 * 60 * 1000);

  nowMs += 61_000;
  const code2 = await sendAndGetCode(svc);
  const second = svc.login({ phone: '+86 138 0013 8000', code: code2 });
  assert.equal(second.isNewUser, false);
  assert.equal(second.user.id, first.user.id);
  assert.notEqual(second.token, first.token);
});

test('令牌以哈希存储：数据库里没有令牌明文', async () => {
  const svc = makeService();
  const { token } = svc.login({ phone: PHONE, code: await sendAndGetCode(svc) });
  const rows = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
  assert.ok(!rows.includes(token));
});

test('验证码只能用一次', async () => {
  const svc = makeService();
  const code = await sendAndGetCode(svc);
  svc.login({ phone: PHONE, code });
  await rejectsWith(() => svc.login({ phone: PHONE, code }), 'CODE_INVALID');
});

test('没发过验证码就登录：失败', async () => {
  const svc = makeService();
  await rejectsWith(() => svc.login({ phone: PHONE, code: '123456' }), 'CODE_INVALID');
});

test('验证码格式不对：失败', async () => {
  const svc = makeService();
  await sendAndGetCode(svc);
  for (const code of ['', '12345', '1234567', 'abcdef', undefined, 123456]) {
    await rejectsWith(() => svc.login({ phone: PHONE, code }), 'CODE_INVALID');
  }
});

test('验证码 5 分钟后过期', async () => {
  const svc = makeService();
  const code = await sendAndGetCode(svc);
  nowMs += 5 * 60 * 1000 + 1;
  await rejectsWith(() => svc.login({ phone: PHONE, code }), 'CODE_EXPIRED');
});

test('验证码错 5 次后锁定：即使第 6 次输对也不行，必须重新获取', async () => {
  const svc = makeService();
  const code = await sendAndGetCode(svc);
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) {
    await rejectsWith(() => svc.login({ phone: PHONE, code: wrong }), 'CODE_INVALID');
  }
  await rejectsWith(() => svc.login({ phone: PHONE, code }), 'CODE_LOCKED');

  nowMs += 61_000;
  const fresh = await sendAndGetCode(svc);
  assert.ok(svc.login({ phone: PHONE, code: fresh }).token);
});

test('重新获取验证码后，旧验证码立即作废', async () => {
  const svc = makeService();
  const oldCode = await sendAndGetCode(svc);
  nowMs += 61_000;
  const newCode = await sendAndGetCode(svc);
  assert.notEqual(oldCode, newCode);
  await rejectsWith(() => svc.login({ phone: PHONE, code: oldCode }), 'CODE_INVALID');
  assert.ok(svc.login({ phone: PHONE, code: newCode }).token);
});

test('验证码绑定手机号：A 的验证码不能登录 B', async () => {
  const svc = makeService();
  const codeA = await sendAndGetCode(svc, '13800000001');
  await sendAndGetCode(svc, '13800000002');
  await rejectsWith(() => svc.login({ phone: '13800000002', code: codeA }), 'CODE_INVALID');
});

test('被停用的账号不能登录，已有会话也失效', async () => {
  const svc = makeService();
  const { token, user } = svc.login({ phone: PHONE, code: await sendAndGetCode(svc) });
  db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(user.id);
  assert.equal(svc.authenticate(token), null);

  nowMs += 61_000;
  const code = await sendAndGetCode(svc);
  await rejectsWith(() => svc.login({ phone: PHONE, code }), 'ACCOUNT_DISABLED');
});

// ─── 登录态 ────────────────────────────────────────────────────────────────

test('authenticate：有效令牌返回用户；伪造、空、超长令牌返回 null', async () => {
  const svc = makeService();
  const { token, user } = svc.login({ phone: PHONE, code: await sendAndGetCode(svc) });
  assert.deepEqual(svc.authenticate(token), { id: user.id, phoneMasked: '138****8000' });
  for (const bad of [null, undefined, '', 'forged-token', token + 'x', 'a'.repeat(500)]) {
    assert.equal(svc.authenticate(bad as any), null, String(bad));
  }
});

test('令牌 30 天后过期，且过期会话被清掉', async () => {
  const svc = makeService();
  const { token } = svc.login({ phone: PHONE, code: await sendAndGetCode(svc) });
  nowMs += 30 * 24 * 60 * 60 * 1000 - 1;
  assert.ok(svc.authenticate(token));
  nowMs += 2;
  assert.equal(svc.authenticate(token), null);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n, 0);
});

test('logout：令牌立即失效，其他设备的令牌不受影响', async () => {
  const svc = makeService();
  const a = svc.login({ phone: PHONE, code: await sendAndGetCode(svc) });
  nowMs += 61_000;
  const b = svc.login({ phone: PHONE, code: await sendAndGetCode(svc) });
  svc.logout(a.token);
  assert.equal(svc.authenticate(a.token), null);
  assert.ok(svc.authenticate(b.token));
});

test('cleanup：清掉一天前的验证码和过期会话', async () => {
  const svc = makeService();
  const { token } = svc.login({ phone: PHONE, code: await sendAndGetCode(svc) });
  nowMs += 31 * 24 * 60 * 60 * 1000;
  const r = svc.cleanup();
  assert.equal(r.codes, 1);
  assert.equal(r.sessions, 1);
  assert.equal(svc.authenticate(token), null);
});

// ─── 配置 ──────────────────────────────────────────────────────────────────

test('AUTH_SECRET 缺失或太短：拒绝', () => {
  assert.throws(() => getAuthSecret({}), /AUTH_SECRET/);
  assert.throws(() => getAuthSecret({ AUTH_SECRET: 'short' }), /AUTH_SECRET/);
  assert.equal(getAuthSecret({ AUTH_SECRET: SECRET }), SECRET);
  assert.throws(() => makeService({ secret: 'short' }), /secret/);
});

test('不同密钥哈希不同：换密钥后同一手机号是新用户', async () => {
  const a = makeService();
  const userA = a.login({ phone: PHONE, code: await sendAndGetCode(a) }).user;
  nowMs += 61_000;
  const b = makeService({ secret: SECRET + '-other' });
  const userB = b.login({ phone: PHONE, code: await sendAndGetCode(b) }).user;
  assert.notEqual(userA.id, userB.id);
});

test('短信配置：生产环境禁用 console 和固定验证码；开发环境默认 console', () => {
  assert.equal(createSmsSender({ NODE_ENV: 'development' }).name, 'console');
  assert.equal(createSmsSender({}).name, 'console');
  assert.throws(() => createSmsSender({ NODE_ENV: 'production' }), /SMS_PROVIDER/);
  assert.throws(() => createSmsSender({ NODE_ENV: 'production', SMS_PROVIDER: 'console' }), /生产环境/);
  assert.throws(() => createSmsSender({ SMS_PROVIDER: 'aliyun' }), /尚未实现/);
  assert.throws(() => createSmsSender({ SMS_PROVIDER: 'whatever' }), /未配置短信服务/);

  assert.equal(getFixedCode({}), null);
  assert.equal(getFixedCode({ SMS_FIXED_CODE: '123456' }), '123456');
  assert.throws(() => getFixedCode({ NODE_ENV: 'production', SMS_FIXED_CODE: '123456' }), /生产环境/);
  assert.throws(() => getFixedCode({ SMS_FIXED_CODE: '12345' }), /6 位数字/);
});
