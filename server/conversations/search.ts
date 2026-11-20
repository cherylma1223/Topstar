/**
 * 会话标题的模糊搜索工具（纯函数，便于单测）
 *
 * 「模糊」= 子串匹配：
 *   - 不区分 ASCII 大小写（SQLite 的 LIKE 默认如此），中文按字符子串
 *   - 用户输入的 % _ \ 会被转义，不会变成通配符
 *   - 只搜标题，不搜消息正文（见 docs/coding_plan/phase4 的 §2）
 */
export const MAX_QUERY_LENGTH = 50;
export const SNIPPET_RADIUS = 12;

/** 规整搜索词：非字符串/空串 → null；超长直接截断（不报错） */
export function normalizeQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).slice(0, MAX_QUERY_LENGTH).join('');
}

/** LIKE 转义：配合 SQL 里的 ESCAPE '\\' 使用 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 命中片段：以命中词为中心，前后各取 radius 个字符。
 * 没命中返回 null；截断处用省略号表示。
 * 按 Unicode 码位切分，避免把 emoji / 生僻字切成半个。
 */
export function buildSnippet(text: string, query: string, radius = SNIPPET_RADIUS): string | null {
  const q = query.trim();
  if (!q || !text) return null;

  const hit = text.toLowerCase().indexOf(q.toLowerCase());
  if (hit < 0) return null;

  const chars = Array.from(text);
  const hitStart = Array.from(text.slice(0, hit)).length;
  const hitLength = Array.from(q).length;

  const start = Math.max(0, hitStart - radius);
  const end = Math.min(chars.length, hitStart + hitLength + radius);

  return (start > 0 ? '…' : '') + chars.slice(start, end).join('') + (end < chars.length ? '…' : '');
}
