/**
 * 账号体系的错误类型
 *
 * 错误码是给前端判断用的，message 是可以直接展示给用户的中文提示。
 */
export type AuthErrorCode =
  | 'UNAUTHORIZED'        // 没登录 / 登录已过期
  | 'INVALID_PHONE'       // 手机号格式不对
  | 'CONSENT_REQUIRED'    // 没勾选同意用户协议和隐私政策
  | 'SMS_TOO_FREQUENT'    // 同一手机号发送过于频繁
  | 'SMS_DAILY_LIMIT'     // 当日发送次数已达上限（手机号或 IP）
  | 'SMS_SEND_FAILED'     // 短信服务商发送失败
  | 'CODE_INVALID'        // 验证码错误或不存在
  | 'CODE_EXPIRED'        // 验证码已过期
  | 'CODE_LOCKED'         // 同一验证码错误次数过多，需要重新获取
  | 'ACCOUNT_DISABLED';   // 账号被停用

const HTTP_STATUS: Record<AuthErrorCode, number> = {
  UNAUTHORIZED: 401,
  INVALID_PHONE: 400,
  CONSENT_REQUIRED: 400,
  SMS_TOO_FREQUENT: 429,
  SMS_DAILY_LIMIT: 429,
  SMS_SEND_FAILED: 502,
  CODE_INVALID: 400,
  CODE_EXPIRED: 400,
  CODE_LOCKED: 429,
  ACCOUNT_DISABLED: 403,
};

export class AuthError extends Error {
  readonly httpStatus: number;
  /** 建议多少秒后重试（仅限流类错误） */
  readonly retryAfterSeconds?: number;

  constructor(readonly code: AuthErrorCode, message: string, opts: { retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = 'AuthError';
    this.httpStatus = HTTP_STATUS[code];
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}
