/**
 * 会话历史路由：/api/v2/conversations/*
 *
 *   GET    /                列表；带 q 时为标题模糊搜索
 *   POST   /                新建会话（/chat 也会隐式创建，一般不用显式调）
 *   GET    /:id             会话详情 + 全量消息
 *   PATCH  /:id             改标题
 *   POST   /:id/messages    批量追加消息（视频分析结果、本地 mock 回复等）
 *
 * 全部需要登录（requireAuth）。所有读写都按登录用户过滤：
 * 别人的会话与不存在的会话对外表现一致，一律 404（避免用错误码探测他人数据）。
 */
import express from 'express';
import db from '../db';
import { requireAuth } from '../auth/middleware';
import {
  ConversationInputError,
  appendMessages,
  createConversation,
  getConversation,
  listConversations,
  renameConversation,
  searchConversations,
} from '../conversations/store';

const router = express.Router();
router.use(requireAuth);

function fail(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  retryable = false,
) {
  return res.status(status).json({
    success: false,
    error: { code, message, retryable, request_id: '' },
  });
}

function handleError(res: express.Response, err: unknown) {
  if (err instanceof ConversationInputError) {
    return fail(res, 400, 'INVALID_INPUT', err.message);
  }
  console.error('[Conversations] unexpected error:', (err as any)?.message || err);
  return fail(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', true);
}

const notFound = (res: express.Response) => fail(res, 404, 'CONVERSATION_NOT_FOUND', '会话不存在');

function limitOf(req: express.Request): string | undefined {
  const raw = req.query.limit;
  return typeof raw === 'string' ? raw : undefined;
}

// ─── 列表 / 搜索 ─────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const userId = req.user!.id;
    const q = typeof req.query.q === 'string' ? req.query.q : '';

    if (q.trim()) {
      const { query, items } = searchConversations(db, { userId, query: q, limit: limitOf(req) });
      return res.json({ success: true, items, total: items.length, query: query || null });
    }

    const items = listConversations(db, { userId, limit: limitOf(req) })
      .map(item => ({ ...item, snippet: null }));
    return res.json({ success: true, items, total: items.length, query: null });
  } catch (err) {
    handleError(res, err);
  }
});

// ─── 新建 ────────────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  try {
    const { title, service } = req.body || {};
    const conversation = createConversation(db, { userId: req.user!.id, title, service });
    res.status(201).json({ success: true, conversation });
  } catch (err) {
    handleError(res, err);
  }
});

// ─── 详情 ────────────────────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
  try {
    const detail = getConversation(db, { id: req.params.id, userId: req.user!.id });
    if (!detail) return notFound(res);
    res.json({ success: true, conversation: detail });
  } catch (err) {
    handleError(res, err);
  }
});

// ─── 改标题 ──────────────────────────────────────────────────────────────────

router.patch('/:id', (req, res) => {
  try {
    const { title } = req.body || {};
    const conversation = renameConversation(db, { id: req.params.id, userId: req.user!.id, title });
    if (!conversation) return notFound(res);
    res.json({ success: true, conversation });
  } catch (err) {
    handleError(res, err);
  }
});

// ─── 追加消息 ────────────────────────────────────────────────────────────────

router.post('/:id/messages', (req, res) => {
  try {
    const { messages } = req.body || {};
    const result = appendMessages(db, {
      conversationId: req.params.id,
      userId: req.user!.id,
      messages,
    });
    if (!result) return notFound(res);
    res.json({
      success: true,
      inserted: result.inserted,
      skipped: result.skipped,
      dropped_payload: result.dropped_payload,
      conversation: result.conversation,
    });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
