/**
 * VIP 身份的服务端判定
 *
 * 为什么要在服务端判定：此前 VIP 取自请求体里的 `prefs.is_vip`，是客户端自己填的，
 * 直接调接口传 `true` 就能解锁「核心秘诀」。现在这个字段会被完全忽略。
 *
 * 首发策略（2026-11-08 确定）：核心秘诀保持锁定，**所有用户默认都不是 VIP**。
 * 目前没有账号和付费体系，所以这里只留了一个默认关闭的「内部测试令牌」：
 * 服务端配置了 `VIP_ACCESS_TOKENS`、且请求头 `X-Topstar-VIP-Token` 与之匹配时才解锁，
 * 方便上线后自己验证解锁链路。以后接入账号 / 付费，只需要替换 `resolveIsVip` 的实现，
 * 调用方不用改。
 *
 * 配置：
 *   VIP_ACCESS_TOKENS=token1,token2    逗号分隔；不配置 = 没有任何人是 VIP（默认）
 *                                      短于 16 个字符的令牌会被忽略，避免被猜中
 */
import { createHash, timingSafeEqual } from 'crypto';

export const VIP_TOKEN_HEADER = 'x-topstar-vip-token';
export const MIN_TOKEN_LENGTH = 16;

type Headers = Record<string, string | string[] | undefined>;

let warnedWeak = false;

function configuredTokens(raw: string | undefined): string[] {
  const all = (raw || '').split(',').map(s => s.trim()).filter(Boolean);
  const valid = all.filter(t => t.length >= MIN_TOKEN_LENGTH);
  if (valid.length < all.length && !warnedWeak) {
    warnedWeak = true;
    console.warn(`[VIP] VIP_ACCESS_TOKENS 里有 ${all.length - valid.length} 个令牌短于 ${MIN_TOKEN_LENGTH} 个字符，已忽略`);
  }
  return valid;
}

/** 先哈希再比较：固定长度 + 常量时间，避免通过响应时间或长度差异猜令牌 */
function sameToken(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * 判断本次请求是否来自 VIP。只看服务端配置和请求头，不信任请求体里的任何字段。
 * @param headers Express 的 `req.headers`（头名已是小写）
 */
export function resolveIsVip(headers: Headers, env: NodeJS.ProcessEnv = process.env): boolean {
  const tokens = configuredTokens(env.VIP_ACCESS_TOKENS);
  if (tokens.length === 0) return false;

  const raw = headers[VIP_TOKEN_HEADER];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (!provided) return false;

  // 不提前返回，保证无论命中哪一个，耗时一致
  let matched = false;
  for (const t of tokens) if (sameToken(t, provided)) matched = true;
  return matched;
}
