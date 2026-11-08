/**
 * 账号路由：/api/v2/auth/*
 *
 *   POST /sms/send   发送登录验证码 { phone, consent: true }
 *   POST /login      手机号 + 验证码登录（新手机号自动注册） { phone, code } → { token, expires_at, user }
 *   GET  /me         当前登录用户（需要登录）
 *   POST /logout     退出登录（需要登录），令牌立即失效
 */
import express from 'express';
import { AuthError } from '../auth/errors';
import { getAuthService } from '../auth';
import { extractBearerToken, requireAuth } from '../auth/middleware';

const router = express.Router();

function sendError(res: express.Response, err: unknown) {
  if (err instanceof AuthError) {
    if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    return res.status(err.httpStatus).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        retryable: err.httpStatus === 429 || err.httpStatus === 502,
        retry_after: err.retryAfterSeconds,
        request_id: '',
      },
    });
  }
  console.error('[Auth] 未预期的错误：', (err as any)?.message || err);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试', retryable: true, request_id: '' },
  });
}

router.post('/sms/send', async (req, res) => {
  try {
    const { phone, consent } = req.body || {};
    const result = await getAuthService().sendCode({ phone, consent, ip: req.ip });
    res.json({ success: true, resend_after: result.resendAfterSeconds, expires_in: result.expiresInSeconds });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/login', (req, res) => {
  try {
    const { phone, code } = req.body || {};
    const result = getAuthService().login({
      phone,
      code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      success: true,
      token: result.token,
      expires_at: result.expiresAt,
      is_new_user: result.isNewUser,
      user: { id: result.user.id, phone_masked: result.user.phoneMasked },
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, user: { id: req.user!.id, phone_masked: req.user!.phoneMasked } });
});

router.post('/logout', requireAuth, (req, res) => {
  getAuthService().logout(extractBearerToken(req.headers.authorization));
  res.json({ success: true });
});

export default router;
