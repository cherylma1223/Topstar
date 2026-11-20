/**
 * 会话历史的数据表（SQLite，幂等，每次启动都会执行）
 *
 * - conversations          一条 = 侧边栏里的一行；按 user_id 归属
 * - conversation_messages  一条 = 一个气泡；content 是纯文本（拼 LLM 上下文用），
 *                          payload 是 MessagePart[] 的 JSON（还原报告卡片/视频气泡用）
 *
 * 时间列一律是毫秒时间戳（INTEGER），与 users / sessions / sms_codes 一致。
 * seq 是会话内单调递增的序号：客户端时间不可信，排序只认它。
 * uq_messages_client 让客户端重试不会写重复消息（client_msg_id 相同时幂等）。
 */
import type { Database as DatabaseType } from 'better-sqlite3';

export function migrateConversationTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      title            TEXT NOT NULL DEFAULT '新对话',
      service          TEXT,
      message_count    INTEGER NOT NULL DEFAULT 0,
      last_message_at  INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      deleted_at       INTEGER
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id               TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      role             TEXT NOT NULL,
      content          TEXT NOT NULL,
      payload          TEXT,
      client_msg_id    TEXT,
      analysis_job_id  TEXT,
      seq              INTEGER NOT NULL,
      created_at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations (user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conv_seq          ON conversation_messages (conversation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_user              ON conversation_messages (user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_client
      ON conversation_messages (conversation_id, client_msg_id)
      WHERE client_msg_id IS NOT NULL;
  `);
}
