/**
 * 极简 CSV 读写（RFC 4180 子集）
 *
 * - 支持双引号包裹、引号内的逗号 / 换行、`""` 转义、UTF-8 BOM、CRLF
 * - 以 `#` 开头的行视为注释行（模板里用来写填写说明），读取时忽略
 * 不引入第三方依赖：标注文件很小，只需要这些能力。
 */

export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去掉 BOM

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') inQuotes = true;
    else if (ch === ',') endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') { /* 忽略，\n 负责换行 */ }
    else cell += ch;
  }
  if (cell !== '' || row.length > 0) endRow();

  return rows.filter(r => {
    if (r.every(c => c.trim() === '')) return false;       // 空行
    if (r[0] && r[0].trimStart().startsWith('#')) return false; // 注释行
    return true;
  });
}

export function toCsvLine(cells: string[]): string {
  return cells
    .map(c => (/[",\n\r]/.test(c) || c !== c.trim() ? `"${c.replace(/"/g, '""')}"` : c))
    .join(',');
}

/** 带 BOM，保证 Excel / Numbers 打开中文不乱码 */
export const CSV_BOM = '\uFEFF';
