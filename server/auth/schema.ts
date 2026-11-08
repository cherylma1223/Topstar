/**
 * 账号体系的数据表（SQLite，幂等，每次启动都会执行）
 *
 * - users      手机号只存「HMAC 哈希 + 脱敏展示」，不存明文，也不存可逆密文
 * - sms_codes  验证码只存哈希；同时用来做发送频率限制
 * - sessions   登录令牌只存 SHA-256 哈希，数据库泄露也不能直接冒用登录态
 *
 * 时间列一律是毫秒时间戳（INTEGER）。
 */
import type { Database as DatabaseType } from 'better-sqlite3';

export function migrateAuthTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      phone_hash    TEXT NOT NULL UNIQUE,
      phone_masked  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',   -- active / disabled
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sms_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_hash  TEXT NOT NULL,
      ip          TEXT,
      code_hash   TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes (phone_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_sms_codes_ip    ON sms_codes (ip, created_at);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash   TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      user_agent   TEXT,
      ip           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
  `);
}
