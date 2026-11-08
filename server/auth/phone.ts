/**
 * 手机号处理（仅支持中国大陆 11 位手机号）
 */

/**
 * 规范化为 11 位大陆手机号；格式不对返回 null。
 * 接受空格、连字符，以及 +86 / 86 前缀。
 */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[\s-]/g, '');
  if (s.startsWith('+86')) s = s.slice(3);
  else if (s.length === 13 && s.startsWith('86')) s = s.slice(2);
  return /^1[3-9]\d{9}$/.test(s) ? s : null;
}

/** 138****0000 —— 展示和日志里一律用这个形式，不出现完整号码 */
export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
