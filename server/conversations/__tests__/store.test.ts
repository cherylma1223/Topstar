/**
 * 会话数据访问层的单测（内存 SQLite）
 *
 * 覆盖：建会话 / 追加消息（seq、计数、幂等）/ 越权读不到 / 改标题 / 标题模糊搜索 / payload 超限降级 / 对话落库
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateConversationTables } from '../schema';
import {
  ConversationInputError,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_PAYLOAD_BYTES,
  appendMessages,
  conversationExists,
  createConversation,
  deriveTitle,
  getConversation,
  listConversations,
  normalizeTitle,
  persistChatTurn,
  renameConversation,
  searchConversations,
} from '../store';

const USER_A = 'user-a';
const USER_B = 'user-b';

function freshDb() {
  const db = new Database(':memory:');
  migrateConversationTables(db);
  return db;
}

test('建表幂等：连续执行两次不报错', () => {
  const db = freshDb();
  migrateConversationTables(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'conversation%' ORDER BY name")
    .all() as { name: string }[];
  assert.deepEqual(tables.map(t => t.name), ['conversation_messages', 'conversations']);
});

test('标题归一化：空白回落默认值，超长截断', () => {
  assert.equal(normalizeTitle('   '), '新对话');
  assert.equal(normalizeTitle(undefined), '新对话');
  assert.equal(normalizeTitle('  反手  拧拉  '), '反手 拧拉');
  assert.equal(normalizeTitle('标'.repeat(80)).length, 60);
  // 恰好 10 个字不加省略号，11 个字才截断
  assert.equal(deriveTitle('反手拧拉总下网怎么办'), '反手拧拉总下网怎么办');
  assert.equal(deriveTitle('反手拧拉总是下网怎么办'), '反手拧拉总是下网怎么…');
  assert.equal(deriveTitle('短题'), '短题');
});

test('createConversation → 列表可读，默认计数为 0', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, title: '反手拧拉', service: '当家球星', now: 1000 });
  assert.equal(conv.title, '反手拧拉');
  assert.equal(conv.service, '当家球星');
  assert.equal(conv.message_count, 0);
  assert.equal(conv.last_message_at, null);
  assert.equal(conv.created_at, 1000);

  const list = listConversations(db, { userId: USER_A });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, conv.id);

  // 别人的列表里看不到
  assert.equal(listConversations(db, { userId: USER_B }).length, 0);
  assert.equal(conversationExists(db, conv.id, USER_B), false);
  assert.equal(getConversation(db, { id: conv.id, userId: USER_B }), null);
});

test('appendMessages：seq 递增、计数与 updated_at 更新、消息按 seq 返回', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, title: '对话', now: 1000 });

  const first = appendMessages(db, {
    conversationId: conv.id,
    userId: USER_A,
    now: 2000,
    messages: [
      { role: 'user', content: '反手拧拉总下网' },
      { role: 'assistant', content: '触球点偏晚' },
    ],
  })!;

  assert.equal(first.inserted, 2);
  assert.equal(first.skipped, 0);
  assert.equal(first.dropped_payload, 0);
  assert.equal(first.conversation.message_count, 2);
  assert.equal(first.conversation.last_message_at, 2000);
  assert.equal(first.conversation.updated_at, 2000);

  appendMessages(db, {
    conversationId: conv.id,
    userId: USER_A,
    now: 3000,
    messages: [{ role: 'user', content: '第三句' }],
  });

  const detail = getConversation(db, { id: conv.id, userId: USER_A })!;
  assert.deepEqual(detail.messages.map(m => m.seq), [1, 2, 3]);
  assert.deepEqual(detail.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(detail.message_count, 3);
});

test('appendMessages：client_msg_id 相同即幂等（重试不重复写）', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, now: 1000 });

  const input = { conversationId: conv.id, userId: USER_A, messages: [{ role: 'user' as const, content: '只写一次', client_msg_id: 'c-1' }] };
  const a = appendMessages(db, { ...input, now: 2000 })!;
  const b = appendMessages(db, { ...input, now: 3000 })!;

  assert.equal(a.inserted, 1);
  assert.equal(b.inserted, 0);
  assert.equal(b.skipped, 1);
  assert.equal(getConversation(db, { id: conv.id, userId: USER_A })!.messages.length, 1);
});

test('appendMessages：空内容 / 非法角色 / 批量过大 → 参数错误', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, now: 1000 });

  assert.throws(
    () => appendMessages(db, { conversationId: conv.id, userId: USER_A, messages: [{ role: 'user', content: '   ' }] }),
    ConversationInputError,
  );
  assert.throws(
    () => appendMessages(db, { conversationId: conv.id, userId: USER_A, messages: [{ role: 'system', content: 'x' }] }),
    ConversationInputError,
  );
  assert.throws(
    () => appendMessages(db, {
      conversationId: conv.id,
      userId: USER_A,
      messages: Array.from({ length: 21 }, () => ({ role: 'user' as const, content: 'x' })),
    }),
    ConversationInputError,
  );
});

test('appendMessages：越权 / 不存在的会话 → null（路由层回 404）', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, now: 1000 });

  assert.equal(
    appendMessages(db, { conversationId: conv.id, userId: USER_B, messages: [{ role: 'user', content: 'x' }] }),
    null,
  );
  assert.equal(
    appendMessages(db, { conversationId: 'nope', userId: USER_A, messages: [{ role: 'user', content: 'x' }] }),
    null,
  );
});

test('appendMessages：payload 超过 64KB 时丢弃并计数', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, now: 1000 });
  const big = 'x'.repeat(MAX_PAYLOAD_BYTES + 10);

  const result = appendMessages(db, {
    conversationId: conv.id,
    userId: USER_A,
    messages: [{ role: 'assistant', content: '正文', payload: [{ type: 'text', content: big }] }],
  })!;

  assert.equal(result.dropped_payload, 1);
  const detail = getConversation(db, { id: conv.id, userId: USER_A })!;
  assert.equal(detail.messages[0].payload, null);
});

test('appendMessages：达到会话消息上限后跳过', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, now: 1000 });
  db.prepare(`UPDATE conversations SET message_count = ? WHERE id = ?`)
    .run(MAX_MESSAGES_PER_CONVERSATION, conv.id);
  // 直接塞满 500 条 seq
  const insert = db.prepare(
    'INSERT INTO conversation_messages (id, conversation_id, user_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (let i = 1; i <= MAX_MESSAGES_PER_CONVERSATION; i++) {
    insert.run(`m-${i}`, conv.id, USER_A, 'user', 'x', i, 1000);
  }

  const result = appendMessages(db, {
    conversationId: conv.id,
    userId: USER_A,
    messages: [{ role: 'user', content: '多出来的一条' }],
  })!;
  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 1);
});

test('renameConversation：标题更新、越权返回 null、空标题报错', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, title: '旧标题', now: 1000 });

  const renamed = renameConversation(db, { id: conv.id, userId: USER_A, title: '新标题', now: 5000 })!;
  assert.equal(renamed.title, '新标题');
  assert.equal(renamed.updated_at, 5000);

  assert.equal(renameConversation(db, { id: conv.id, userId: USER_B, title: '抢改' }), null);
  assert.throws(
    () => renameConversation(db, { id: conv.id, userId: USER_A, title: '  ' }),
    ConversationInputError,
  );
});

test('searchConversations：子串命中、大小写不敏感、只搜标题', () => {
  const db = freshDb();
  createConversation(db, { userId: USER_A, title: '反手拧拉总下网怎么办', now: 1000 });
  createConversation(db, { userId: USER_A, title: '正手攻球动作纠正', now: 2000 });
  createConversation(db, { userId: USER_A, title: 'Forehand Loop 发力', now: 3000 });
  createConversation(db, { userId: USER_B, title: '反手（别人的）', now: 4000 });

  const hit = searchConversations(db, { userId: USER_A, query: '反手' });
  assert.equal(hit.query, '反手');
  assert.equal(hit.items.length, 1);
  assert.equal(hit.items[0].title, '反手拧拉总下网怎么办');
  assert.ok(hit.items[0].snippet?.includes('反手'));

  assert.equal(searchConversations(db, { userId: USER_A, query: 'forehand' }).items.length, 1);
  assert.equal(searchConversations(db, { userId: USER_A, query: '不存在的关键词' }).items.length, 0);

  // 空搜索词退回列表（不报错）
  const empty = searchConversations(db, { userId: USER_A, query: '   ' });
  assert.equal(empty.query, '');
  assert.equal(empty.items.length, 3);
  assert.equal(empty.items[0].snippet, null);
});

test('searchConversations：% 和 _ 被转义，不当通配符', () => {
  const db = freshDb();
  createConversation(db, { userId: USER_A, title: '命中率 100% 的训练', now: 1000 });
  createConversation(db, { userId: USER_A, title: '命中率 100 的训练', now: 2000 });
  createConversation(db, { userId: USER_A, title: 'A_B 训练', now: 3000 });
  createConversation(db, { userId: USER_A, title: 'AXB 训练', now: 4000 });

  assert.equal(searchConversations(db, { userId: USER_A, query: '100%' }).items.length, 1);
  assert.equal(searchConversations(db, { userId: USER_A, query: 'A_B' }).items.length, 1);
});

test('searchConversations：按 updated_at 倒序', () => {
  const db = freshDb();
  const older = createConversation(db, { userId: USER_A, title: '反手 旧', now: 1000 });
  createConversation(db, { userId: USER_A, title: '反手 新', now: 2000 });
  // 把旧会话聊一句，它应该排到最前
  appendMessages(db, { conversationId: older.id, userId: USER_A, now: 9000, messages: [{ role: 'user', content: '刚刚' }] });

  const items = searchConversations(db, { userId: USER_A, query: '反手' }).items;
  assert.deepEqual(items.map(i => i.title), ['反手 旧', '反手 新']);
});

test('persistChatTurn：没给会话 id 时自动建会话，标题取首条消息前 10 字', () => {
  const db = freshDb();
  const turn = persistChatTurn(db, {
    userId: USER_A,
    service: '当家球星',
    userContent: '反手拧拉总下网怎么办',
    userClientMsgId: 'c-1',
    assistantContent: '触球点偏晚',
    assistantPayload: [{ type: 'text', content: '触球点偏晚' }],
    now: 1000,
  })!;

  assert.ok(turn.conversationId);
  assert.ok(turn.assistantMessageId);
  assert.equal(turn.duplicate, false);

  const detail = getConversation(db, { id: turn.conversationId, userId: USER_A })!;
  assert.equal(detail.title, '反手拧拉总下网怎么办');
  assert.equal(detail.service, '当家球星');
  assert.deepEqual(detail.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(detail.messages[0].client_msg_id, 'c-1');
  assert.ok(detail.messages[1].payload?.includes('触球点偏晚'));
});

test('persistChatTurn：同一个 client_msg_id 重试 → duplicate，不重复写', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, now: 1000 });
  const opts = {
    userId: USER_A,
    conversationId: conv.id,
    userContent: '同一句话',
    userClientMsgId: 'c-9',
    assistantContent: '回答',
    now: 2000,
  };

  const first = persistChatTurn(db, opts)!;
  const second = persistChatTurn(db, opts)!;

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.assistantMessageId, null);
  assert.equal(getConversation(db, { id: conv.id, userId: USER_A })!.messages.length, 2);
});

test('persistChatTurn：会话不属于该用户 → null', () => {
  const db = freshDb();
  const conv = createConversation(db, { userId: USER_A, now: 1000 });
  assert.equal(persistChatTurn(db, {
    userId: USER_B,
    conversationId: conv.id,
    userContent: '偷偷写',
    assistantContent: 'x',
  }), null);
});
