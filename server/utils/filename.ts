/**
 * multipart 上传的文件名编码修复
 *
 * multer（busboy）默认把 Content-Disposition 里的 filename 按 latin1 解码，
 * 而浏览器发送的是 UTF-8 字节，所以中文名会变成 `é©¬è¯å½¤` 这样的乱码。
 * 这里把「被误按 latin1 读出来的 UTF-8」还原回去。
 *
 * 判断规则（保守，宁可不改也不改坏）：
 * - 含有大于 0xFF 的字符 → 说明已经是正确的 Unicode（或不是 latin1 误读），原样返回
 * - 按 latin1 取回原始字节后，不是合法 UTF-8（解码出现 U+FFFD）→ 原样返回
 *   例如真正的 latin1 文件名 `café.mov`（é 单独一个 0xE9 字节）不会被改坏
 * - 纯 ASCII → 解码结果相同，原样返回
 * - 其余情况采用 UTF-8 解码结果
 *
 * 幂等：对已修复的字符串再次调用不会改变它（修复后含 CJK 等 >0xFF 字符）。
 */
export function fixMultipartFilename(name: string): string {
  if (!name) return name;
  if (/[^\x00-\xff]/.test(name)) return name;

  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD')) return name;
  return decoded;
}
