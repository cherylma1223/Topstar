/**
 * 登录校验中间件
 *
 * 前端在请求头里带 `Authorization: Bearer <令牌>`。校验通过后把用户放到 `req.user`。
 * 没登录 / 令牌无效 / 已过期统一返回 401，前端据此弹出登录窗口。
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from './service';
import { getAuthService } from './index';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 已登录用户；仅在 requireAuth 之后可用 */
      user?: AuthUser;
    }
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

export function unauthorizedBody(message = '请先登录') {
  return { success: false, error: { code: 'UNAUTHORIZED', message, retryable: false, request_id: '' } };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req.headers.authorization);
  const user = getAuthService().authenticate(token);
  if (!user) {
    return res.status(401).json(unauthorizedBody(token ? '登录已过期，请重新登录' : '请先登录'));
  }
  req.user = user;
  next();
}
