/**
 * 会话历史的数据访问层（只碰数据库，不碰 HTTP）
 *
 * 所有读写都强制带 user_id：
 *   - 别人的会话 / 不存在的会话，一律当作「不存在」返回 null（调用方回 404）
 *   - 列表、搜索也只在当前用户的会话里找
 *
 * 写入约定：
 *   - 时间列是毫秒时间戳（Date.now()）
 *   - seq 在同一个事务里取 MAX(seq)+1，保证会话内严格递增
 *   - client_msg_id 相同即幂等：重试不写重复消息
 *   - payload 序列化后超过 64KB 时丢弃该字段（只留 content），并计入 dropped_payload
 */
import { randomUUID } from 'crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import { buildSnippet, escapeLike, normalizeQuery } from './search';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;
export const MAX_TITLE_LENGTH = 60;
export const MAX_CONTENT_LENGTH = 8000;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_BATCH_MESSAGES = 20;
export const MAX_MESSAGES_PER_CONVERSATION = 500;
export const DEFAULT_TITLE = '新对话';
export const DERIVED_TITLE_LENGTH = 10;

/** 参数不合法（缺字段 / 空标题 / 角色不认识），路由层映射成 400 */
export class ConversationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationInputError';
  }
}

export type MessageRole = 'user' | 'assistant';

export interface ConversationSummary {
  id: string;
  title: string;
  service: string | null;
  message_count: number;
  last_message_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ConversationSearchItem extends ConversationSummary {
  /** 标题命中片段；没命中为 null */
  snippet: string | null;
}

export interface StoredMessage {
  id: string;
  seq: number;
  role: MessageRole;
  content: string;
  payload: string | null;
  client_msg_id: string | null;
  analysis_job_id: string | null;
  created_at: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: StoredMessage[];
}

export interface NewMessageInput {
  role: MessageRole | string;
  content: string;
  payload?: unknown;
  client_msg_id?: string | null;
  analysis_job_id?: string | null;
}

export interface AppendMessagesResult {
  inserted: number;
  skipped: number;
  dropped_payload: number;
  conversation: ConversationSummary;
}

export interface PersistChatTurnResult {
  conversationId: string;
  /** 本轮落库的 assistant 消息 id；重试命中幂等或落库被跳过时为 null */
  assistantMessageId: string | null;
  /** true 表示这条用户消息之前已经写过（客户端重试），本轮没有重复写 */
  duplicate: boolean;
}

interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  service: string | null;
  message_count: number;
  last_message_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

// ─── 归一化 / 校验 ────────────────────────────────────────────────────────────

export function normalizeTitle(raw: unknown, fallback = DEFAULT_TITLE): string {
  if (typeof raw !== 'string') return fallback;
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return fallback;
  return Array.from(flat).slice(0, MAX_TITLE_LENGTH).join('');
}

/** 从首条消息派生标题：前 10 字，超长加省略号 */
export function deriveTitle(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (!flat) return DEFAULT_TITLE;
  const chars = Array.from(flat);
  return chars.length > DERIVED_TITLE_LENGTH
    ? chars.slice(0, DERIVED_TITLE_LENGTH).join('') + '…'
    : flat;
}

function normalizeContent(raw: unknown): string {
  if (typeof raw !== 'string') throw new ConversationInputError('消息内容不能为空');
  const trimmed = raw.trim();
  if (!trimmed) throw new ConversationInputError('消息内容不能为空');
  return Array.from(trimmed).slice(0, MAX_CONTENT_LENGTH).join('');
}

function normalizeRole(raw: unknown): MessageRole {
  if (raw === 'user' || raw === 'assistant') return raw;
  throw new ConversationInputError('消息角色只能是 user 或 assistant');
}

/** 返回序列化后的 payload；超限时丢弃（dropped = true） */
function normalizePayload(raw: unknown): { payload: string | null; dropped: boolean } {
  if (raw === null || raw === undefined || raw === '') return { payload: null, dropped: false };
  const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
  if (!text) return { payload: null, dropped: false };
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) return { payload: null, dropped: true };
  return { payload: text, dropped: false };
}

function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIST_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(n), MAX_LIST_LIMIT);
}

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    service: row.service,
    message_count: row.message_count,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── 查询 ────────────────────────────────────────────────────────────────────

const SELECT_CONVERSATION = `
  SELECT id, user_id, title, service, message_count, last_message_at, created_at, updated_at, deleted_at
    FROM conversations
   WHERE id = ? AND user_id = ? AND deleted_at IS NULL
`;

function selectRow(db: DatabaseType, id: string, userId: string): ConversationRow | undefined {
  return db.prepare(SELECT_CONVERSATION).get(id, userId) as ConversationRow | undefined;
}

export function conversationExists(db: DatabaseType, id: string, userId: string): boolean {
  return selectRow(db, id, userId) !== undefined;
}

export function getConversation(
  db: DatabaseType,
  opts: { id: string; userId: string },
): ConversationDetail | null {
  const row = selectRow(db, opts.id, opts.userId);
  if (!row) return null;

  const messages = db.prepare(`
    SELECT id, seq, role, content, payload, client_msg_id, analysis_job_id, created_at
      FROM conversation_messages
     WHERE conversation_id = ?
     ORDER BY seq ASC
     LIMIT ?
  `).all(row.id, MAX_MESSAGES_PER_CONVERSATION) as StoredMessage[];

  return { ...toSummary(row), messages };
}

export function listConversations(
  db: DatabaseType,
  opts: { userId: string; limit?: number | string },
): ConversationSummary[] {
  const limit = clampLimit(opts.limit);
  const rows = db.prepare(`
    SELECT id, user_id, title, service, message_count, last_message_at, created_at, updated_at, deleted_at
      FROM conversations
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT ?
  `).all(opts.userId, limit) as ConversationRow[];
  return rows.map(toSummary);
}

/** 标题模糊搜索：子串匹配、转义 % _ \\、空词退回列表 */
export function searchConversations(
  db: DatabaseType,
  opts: { userId: string; query: unknown; limit?: number | string },
): { query: string; items: ConversationSearchItem[] } {
  const q = normalizeQuery(opts.query);
  const limit = clampLimit(opts.limit);

  if (!q) {
    return { query: '', items: listConversations(db, { userId: opts.userId, limit }).map(s => ({ ...s, snippet: null })) };
  }

  const rows = db.prepare(`
    SELECT id, user_id, title, service, message_count, last_message_at, created_at, updated_at, deleted_at
      FROM conversations
     WHERE user_id = ? AND deleted_at IS NULL AND title LIKE ? ESCAPE '\\'
     ORDER BY updated_at DESC
     LIMIT ?
  `).all(opts.userId, `%${escapeLike(q)}%`, limit) as ConversationRow[];

  return {
    query: q,
    items: rows.map(row => ({ ...toSummary(row), snippet: buildSnippet(row.title, q) })),
  };
}

// ─── 写入 ────────────────────────────────────────────────────────────────────

export function createConversation(
  db: DatabaseType,
  opts: { userId: string; title?: unknown; service?: unknown; now?: number },
): ConversationSummary {
  const now = opts.now ?? Date.now();
  const id = randomUUID();
  const title = normalizeTitle(opts.title);
  const service = typeof opts.service === 'string' && opts.service.trim() ? opts.service.trim() : null;

  db.prepare(`
    INSERT INTO conversations (id, user_id, title, service, message_count, last_message_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
  `).run(id, opts.userId, title, service, now, now);

  return toSummary(selectRow(db, id, opts.userId)!);
}

export function renameConversation(
  db: DatabaseType,
  opts: { id: string; userId: string; title: unknown; now?: number },
): ConversationSummary | null {
  const title = normalizeTitle(opts.title, '');
  if (!title) throw new ConversationInputError('标题不能为空');

  const row = selectRow(db, opts.id, opts.userId);
  if (!row) return null;

  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(title, opts.now ?? Date.now(), opts.id, opts.userId);

  return toSummary(selectRow(db, opts.id, opts.userId)!);
}

function hasClientMsgId(db: DatabaseType, conversationId: string, clientMsgId: string): boolean {
  const hit = db.prepare(
    'SELECT 1 AS hit FROM conversation_messages WHERE conversation_id = ? AND client_msg_id = ? LIMIT 1',
  ).get(conversationId, clientMsgId);
  return hit !== undefined;
}

/** 批量追加消息；会话不存在或不属于该用户时返回 null */
export function appendMessages(
  db: DatabaseType,
  opts: { conversationId: string; userId: string; messages: NewMessageInput[]; now?: number },
): AppendMessagesResult | null {
  const row = selectRow(db, opts.conversationId, opts.userId);
  if (!row) return null;

  if (!Array.isArray(opts.messages) || opts.messages.length === 0) {
    throw new ConversationInputError('messages 不能为空');
  }
  if (opts.messages.length > MAX_BATCH_MESSAGES) {
    throw new ConversationInputError(`一次最多追加 ${MAX_BATCH_MESSAGES} 条消息`);
  }

  const now = opts.now ?? Date.now();

  const write = db.transaction(() => {
    let seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM conversation_messages WHERE conversation_id = ?')
      .get(opts.conversationId) as { maxSeq: number }).maxSeq;
    let count = (db.prepare('SELECT COUNT(*) AS c FROM conversation_messages WHERE conversation_id = ?')
      .get(opts.conversationId) as { c: number }).c;
    let lastAt: number | null = row.last_message_at;

    let inserted = 0;
    let skipped = 0;
    let droppedPayload = 0;

    for (const input of opts.messages) {
      const content = normalizeContent(input.content);
      const role = normalizeRole(input.role);
      const clientMsgId = typeof input.client_msg_id === 'string' && input.client_msg_id.trim()
        ? input.client_msg_id.trim()
        : null;

      if (clientMsgId && hasClientMsgId(db, opts.conversationId, clientMsgId)) {
        skipped++;
        continue;
      }
      if (count >= MAX_MESSAGES_PER_CONVERSATION) {
        skipped++;
        continue;
      }

      const { payload, dropped } = normalizePayload(input.payload);
      if (dropped) droppedPayload++;

      const analysisJobId = typeof input.analysis_job_id === 'string' && input.analysis_job_id.trim()
        ? input.analysis_job_id.trim()
        : null;

      seq += 1;
      count += 1;
      lastAt = now;

      db.prepare(`
        INSERT INTO conversation_messages
          (id, conversation_id, user_id, role, content, payload, client_msg_id, analysis_job_id, seq, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), opts.conversationId, opts.userId, role, content, payload, clientMsgId, analysisJobId, seq, now);

      inserted++;
    }

    if (inserted > 0) {
      db.prepare(`
        UPDATE conversations
           SET message_count = ?, last_message_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ?
      `).run(count, lastAt, now, opts.conversationId, opts.userId);
    }

    return { inserted, skipped, droppedPayload };
  });

  const { inserted, skipped, droppedPayload } = write();
  const fresh = selectRow(db, opts.conversationId, opts.userId)!;

  return { inserted, skipped, dropped_payload: droppedPayload, conversation: toSummary(fresh) };
}

/**
 * 一趟对话的落库：用户消息 + AI 回答写在同一个事务里。
 *
 * - 没给 conversationId：自动建会话，标题取用户消息前 10 字
 * - 给了但不属于该用户：返回 null（路由层回 404）
 * - 用户消息的 client_msg_id 已存在（客户端重试）：不重复写，duplicate = true
 */
export function persistChatTurn(
  db: DatabaseType,
  opts: {
    userId: string;
    conversationId?: string | null;
    service?: unknown;
    userContent: string;
    userPayload?: unknown;
    userClientMsgId?: string | null;
    assistantContent: string;
    assistantPayload?: unknown;
    now?: number;
  },
): PersistChatTurnResult | null {
  const now = opts.now ?? Date.now();
  const requestedId = typeof opts.conversationId === 'string' ? opts.conversationId.trim() : '';

  let conversationId: string;
  if (requestedId) {
    if (!selectRow(db, requestedId, opts.userId)) return null;
    conversationId = requestedId;
  } else {
    conversationId = createConversation(db, {
      userId: opts.userId,
      title: deriveTitle(opts.userContent),
      service: opts.service,
      now,
    }).id;
  }

  const userClientMsgId = typeof opts.userClientMsgId === 'string' && opts.userClientMsgId.trim()
    ? opts.userClientMsgId.trim()
    : null;

  if (userClientMsgId && hasClientMsgId(db, conversationId, userClientMsgId)) {
    return { conversationId, assistantMessageId: null, duplicate: true };
  }

  const result = appendMessages(db, {
    conversationId,
    userId: opts.userId,
    now,
    messages: [
      {
        role: 'user',
        content: opts.userContent,
        payload: opts.userPayload,
        client_msg_id: userClientMsgId,
      },
      {
        role: 'assistant',
        content: opts.assistantContent,
        payload: opts.assistantPayload,
      },
    ],
  });

  if (!result || result.inserted === 0) {
    return { conversationId, assistantMessageId: null, duplicate: false };
  }

  const last = db.prepare(`
    SELECT id FROM conversation_messages
     WHERE conversation_id = ? AND role = 'assistant'
     ORDER BY seq DESC LIMIT 1
  `).get(conversationId) as { id: string } | undefined;

  return { conversationId, assistantMessageId: last?.id ?? null, duplicate: false };
}
