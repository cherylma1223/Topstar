/**
 * 账号服务：手机号 + 短信验证码登录
 *
 * 不依赖具体数据库实例和短信服务商（构造时传入），方便用内存库做测试。
 *
 * 安全要点：
 * - 手机号只存 HMAC 哈希（密钥 AUTH_SECRET）+ 脱敏展示；验证码和登录令牌只存哈希
 * - 发送频率：同一手机号 60 秒 1 条、每天 10 条；同一 IP 每天 30 条（防短信被刷，短信要花钱）
 * - 验证码 6 位、5 分钟有效、同一个验证码最多试 5 次；新验证码发出后旧的立即作废
 * - 验证码比较用常量时间；验证码用 crypto.randomInt 生成
 * - 登录令牌 32 字节随机数，有效期 30 天（可配），退出登录立即失效
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import { AuthError } from './errors';
import { maskPhone, normalizePhone } from './phone';
import type { SmsSender } from './sms';

export interface AuthUser {
  id: string;
  phoneMasked: string;
}

export interface LoginResult {
  token: string;
  expiresAt: number;
  user: AuthUser;
  isNewUser: boolean;
}

export interface AuthServiceOptions {
  /** 哈希手机号和验证码用的密钥，至少 32 个字符。**更换后所有用户会变成「新用户」，上线后不要改** */
  secret: string;
  sender: SmsSender;
  /** 测试用：固定当前时间（毫秒） */
  now?: () => number;
  /** 测试 / 开发用：固定验证码；默认用 crypto.randomInt 生成 6 位数字 */
  generateCode?: () => string;
  sessionTtlMs?: number;
  codeTtlMs?: number;
  resendCooldownMs?: number;
  maxAttemptsPerCode?: number;
  phoneDailyLimit?: number;
  ipDailyLimit?: number;
}

export const AUTH_SECRET_MIN_LENGTH = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

/** 从环境变量读取密钥；缺失或太短直接抛错（让服务启动失败，而不是带着弱密钥上线） */
export function getAuthSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = (env.AUTH_SECRET || '').trim();
  if (secret.length < AUTH_SECRET_MIN_LENGTH) {
    throw new Error(
      `AUTH_SECRET 未配置或太短（至少 ${AUTH_SECRET_MIN_LENGTH} 个字符）。` +
      `可以用这条命令生成：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return secret;
}

export class AuthService {
  private readonly secret: string;
  private readonly sender: SmsSender;
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private readonly sessionTtlMs: number;
  private readonly codeTtlMs: number;
  private readonly resendCooldownMs: number;
  private readonly maxAttemptsPerCode: number;
  private readonly phoneDailyLimit: number;
  private readonly ipDailyLimit: number;

  constructor(private readonly db: DatabaseType, opts: AuthServiceOptions) {
    if (!opts.secret || opts.secret.length < AUTH_SECRET_MIN_LENGTH) {
      throw new Error(`AuthService: secret 至少 ${AUTH_SECRET_MIN_LENGTH} 个字符`);
    }
    this.secret = opts.secret;
    this.sender = opts.sender;
    this.now = opts.now ?? Date.now;
    this.generateCode = opts.generateCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'));
    this.sessionTtlMs = opts.sessionTtlMs ?? 30 * DAY_MS;
    this.codeTtlMs = opts.codeTtlMs ?? 5 * 60 * 1000;
    this.resendCooldownMs = opts.resendCooldownMs ?? 60 * 1000;
    this.maxAttemptsPerCode = opts.maxAttemptsPerCode ?? 5;
    this.phoneDailyLimit = opts.phoneDailyLimit ?? 10;
    this.ipDailyLimit = opts.ipDailyLimit ?? 30;
  }

  // ─── 哈希 ────────────────────────────────────────────────────────────────

  private hashPhone(phone: string): string {
    return createHmac('sha256', this.secret).update(`phone:${phone}`).digest('hex');
  }

  private hashCode(phoneHash: string, code: string): string {
    return createHmac('sha256', this.secret).update(`code:${phoneHash}:${code}`).digest('hex');
  }

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // ─── 发送验证码 ──────────────────────────────────────────────────────────

  async sendCode(input: { phone: unknown; consent: unknown; ip?: string | null }): Promise<{ resendAfterSeconds: number; expiresInSeconds: number }> {
    if (input.consent !== true) {
      throw new AuthError('CONSENT_REQUIRED', '请先阅读并同意《用户协议》和《隐私政策》');
    }
    const phone = normalizePhone(input.phone);
    if (!phone) throw new AuthError('INVALID_PHONE', '请输入正确的 11 位手机号');

    const phoneHash = this.hashPhone(phone);
    const ip = input.ip || null;
    const now = this.now();

    const last = this.db.prepare(
      `SELECT created_at FROM sms_codes WHERE phone_hash = ? ORDER BY id DESC LIMIT 1`
    ).get(phoneHash) as { created_at: number } | undefined;
    if (last && now - last.created_at < this.resendCooldownMs) {
      const wait = Math.ceil((this.resendCooldownMs - (now - last.created_at)) / 1000);
      throw new AuthError('SMS_TOO_FREQUENT', `发送太频繁，请 ${wait} 秒后再试`, { retryAfterSeconds: wait });
    }

    const since = now - DAY_MS;
    const phoneCount = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM sms_codes WHERE phone_hash = ? AND created_at > ?`
    ).get(phoneHash, since) as { n: number }).n;
    if (phoneCount >= this.phoneDailyLimit) {
      throw new AuthError('SMS_DAILY_LIMIT', '该手机号今天获取验证码的次数已达上限，请明天再试');
    }
    if (ip) {
      const ipCount = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM sms_codes WHERE ip = ? AND created_at > ?`
      ).get(ip, since) as { n: number }).n;
      if (ipCount >= this.ipDailyLimit) {
        throw new AuthError('SMS_DAILY_LIMIT', '当前网络今天获取验证码的次数已达上限，请明天再试');
      }
    }

    const code = this.generateCode();
    // 先落库再发送：并发请求能立刻被冷却时间挡住；发送失败再回滚这一行
    const inserted = this.db.prepare(
      `INSERT INTO sms_codes (phone_hash, ip, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`
    ).run(phoneHash, ip, this.hashCode(phoneHash, code), now, now + this.codeTtlMs);
    const rowId = Number(inserted.lastInsertRowid);

    try {
      await this.sender.sendLoginCode(phone, code);
    } catch (err: any) {
      this.db.prepare(`DELETE FROM sms_codes WHERE id = ?`).run(rowId);
      console.error(`[Auth] 短信发送失败（${maskPhone(phone)}，${this.sender.name}）：${err?.message || err}`);
      throw new AuthError('SMS_SEND_FAILED', '验证码发送失败，请稍后再试');
    }

    // 新验证码发出后，之前没用掉的作废
    this.db.prepare(
      `UPDATE sms_codes SET consumed_at = ? WHERE phone_hash = ? AND consumed_at IS NULL AND id <> ?`
    ).run(now, phoneHash, rowId);

    return {
      resendAfterSeconds: Math.ceil(this.resendCooldownMs / 1000),
      expiresInSeconds: Math.ceil(this.codeTtlMs / 1000),
    };
  }

  // ─── 登录 ────────────────────────────────────────────────────────────────

  login(input: { phone: unknown; code: unknown; ip?: string | null; userAgent?: string | null }): LoginResult {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new AuthError('INVALID_PHONE', '请输入正确的 11 位手机号');
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!/^\d{6}$/.test(code)) throw new AuthError('CODE_INVALID', '请输入 6 位数字验证码');

    const phoneHash = this.hashPhone(phone);
    const now = this.now();

    const row = this.db.prepare(
      `SELECT id, code_hash, expires_at, attempts FROM sms_codes
        WHERE phone_hash = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`
    ).get(phoneHash) as { id: number; code_hash: string; expires_at: number; attempts: number } | undefined;

    if (!row) throw new AuthError('CODE_INVALID', '验证码错误或已失效，请重新获取');
    if (row.expires_at <= now) throw new AuthError('CODE_EXPIRED', '验证码已过期，请重新获取');
    if (row.attempts >= this.maxAttemptsPerCode) {
      throw new AuthError('CODE_LOCKED', '验证码错误次数过多，请重新获取');
    }

    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(this.hashCode(phoneHash, code), 'hex');
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!matches) {
      this.db.prepare(`UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
      const left = this.maxAttemptsPerCode - row.attempts - 1;
      throw new AuthError('CODE_INVALID', left > 0 ? `验证码错误，还可以尝试 ${left} 次` : '验证码错误次数过多，请重新获取');
    }

    // 一个验证码只能用一次
    const consumed = this.db.prepare(
      `UPDATE sms_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`
    ).run(now, row.id);
    if (consumed.changes !== 1) throw new AuthError('CODE_INVALID', '验证码错误或已失效，请重新获取');

    let isNewUser = false;
    let user = this.db.prepare(
      `SELECT id, phone_masked, status FROM users WHERE phone_hash = ?`
    ).get(phoneHash) as { id: string; phone_masked: string; status: string } | undefined;
    if (!user) {
      const id = randomUUID();
      this.db.prepare(
        `INSERT INTO users (id, phone_hash, phone_masked, status, created_at) VALUES (?, ?, ?, 'active', ?)`
      ).run(id, phoneHash, maskPhone(phone), now);
      user = { id, phone_masked: maskPhone(phone), status: 'active' };
      isNewUser = true;
    }
    if (user.status !== 'active') throw new AuthError('ACCOUNT_DISABLED', '该账号已被停用，如有疑问请联系客服');

    this.db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(now, user.id);

    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + this.sessionTtlMs;
    this.db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(AuthService.hashToken(token), user.id, now, expiresAt, now, (input.userAgent || '').slice(0, 200) || null, input.ip || null);

    return { token, expiresAt, user: { id: user.id, phoneMasked: user.phone_masked }, isNewUser };
  }

  // ─── 登录态 ──────────────────────────────────────────────────────────────

  /** 校验令牌；有效返回用户，否则返回 null */
  authenticate(token: string | null | undefined): AuthUser | null {
    if (!token || token.length > 128) return null;
    const tokenHash = AuthService.hashToken(token);
    const now = this.now();

    const row = this.db.prepare(
      `SELECT s.user_id AS user_id, s.expires_at AS expires_at, s.last_seen_at AS last_seen_at,
              u.phone_masked AS phone_masked, u.status AS status
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    ).get(tokenHash) as { user_id: string; expires_at: number; last_seen_at: number; phone_masked: string; status: string } | undefined;

    if (!row) return null;
    if (row.expires_at <= now) {
      this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
      return null;
    }
    if (row.status !== 'active') return null;

    if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
      this.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`).run(now, tokenHash);
    }
    return { id: row.user_id, phoneMasked: row.phone_masked };
  }

  logout(token: string | null | undefined): void {
    if (!token) return;
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(AuthService.hashToken(token));
  }

  /** 清理过期的验证码（保留 1 天，用于发送频率统计）和过期会话；返回清理条数 */
  cleanup(): { codes: number; sessions: number } {
    const now = this.now();
    const codes = this.db.prepare(`DELETE FROM sms_codes WHERE created_at < ?`).run(now - DAY_MS).changes;
    const sessions = this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now).changes;
    return { codes, sessions };
  }
}
