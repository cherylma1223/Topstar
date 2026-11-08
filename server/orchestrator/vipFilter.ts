/**
 * VIP 内容（「核心秘诀」）的过滤
 *
 * 两道防线：
 *   1. 入模前：非 VIP 用户请求时，从知识库原文里物理剥离秘诀章节，模型根本看不到正文
 *      （stripVipSectionsFromKnowledge）。这是主要防线，因为靠提示词让模型「别说」是可以被绕过的。
 *   2. 出模后：对模型输出再过滤一遍，兜底（sanitizeAnswerTextForNonVip）。
 *
 * 历史问题（2026-11-08 修复）：知识库里 13 个动作文档的标题实际是 `## 【核心秘诀】`（两个井号），
 * 而旧的正则只认 `###` 或没有井号，一个都没匹配上，秘诀正文一直会进入模型，只剩出模后这一道防线。
 * 现在：标题允许任意 1–6 个井号；并且在「标题格式不认识」时采用保守策略——宁可截断也不放行。
 */

/** Markdown 标题前缀：`#` 到 `######`，后面可带空格，也可以没有 */
const HEADING_PREFIX = '(?:#{1,6}\\s*)?';

/** 一个秘诀章节：从标题开始，到下一个【…】标题（或文末）之前 */
const VIP_SECTION_REGEX = new RegExp(
  `(?:^|\\n)${HEADING_PREFIX}【(?:核心秘诀|VIP专属)[^】]*】[\\s\\S]*?(?=(?:\\n${HEADING_PREFIX}【|$))`,
  'g',
);
const VIP_TITLE_REGEX = /【(?:核心秘诀|VIP专属)[^】]*】/;
const VIP_LEAK_LINE_REGEX = /(核心秘诀|VIP专属|会员专属|二次点火|金牌教练|喷射感|猛压拍肩|食指.*(?:拍肩|发力|加速))/i;

/** 兜底：文本里出现这些词，说明还有秘诀内容没被章节正则覆盖 */
const SECRET_HINT_REGEX = /核心秘诀|VIP专属|会员专属/;

export const LOCKED_VIP_BLOCK = '【核心秘诀】\n[LOCKED_VIP_CONTENT]';

/** 找到 idx 所在行的行首 */
function lineStart(text: string, idx: number): number {
  return text.lastIndexOf('\n', idx) + 1;
}

/**
 * 从知识库原文剥离秘诀章节（非 VIP 入模前调用）。
 * @returns hasVipSecret：原文是否含秘诀；content：剥离后的文本（即使 VIP，调用方也可用 hasVipSecret 判断是否要补锁定占位）
 */
export function stripVipSectionsFromKnowledge(content: string): { content: string; hasVipSecret: boolean } {
  const matched = VIP_SECTION_REGEX.test(content);
  VIP_SECTION_REGEX.lastIndex = 0;

  let stripped = matched ? content.replace(VIP_SECTION_REGEX, '').trim() : content;

  // 保守兜底：章节正则没覆盖到的秘诀（标题格式变了、写成了别的样子）——
  // 从出现秘诀标记的那一行开始整体截断。宁可少给一点内容，也不能把秘诀放进模型。
  const leftover = stripped.search(SECRET_HINT_REGEX);
  if (leftover >= 0) {
    console.warn('[VIP] 知识库里有未识别格式的「核心秘诀」标记，已从该行起截断。请检查知识库标题格式');
    stripped = stripped.slice(0, lineStart(stripped, leftover)).trim();
    return { content: stripped, hasVipSecret: true };
  }

  return { content: stripped, hasVipSecret: matched };
}

/** 过滤模型输出（出模后兜底）：删掉秘诀章节，并删掉其他章节里疑似泄露秘诀的行 */
export function sanitizeAnswerTextForNonVip(answerText: string): { text: string; removedVip: boolean } {
  let removedVip = false;

  let sanitized = answerText.replace(VIP_SECTION_REGEX, () => {
    removedVip = true;
    return '';
  }).trim();
  VIP_SECTION_REGEX.lastIndex = 0;

  const lines = sanitized.split('\n');
  const keptLines: string[] = [];
  let currentSection = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      keptLines.push(rawLine);
      continue;
    }

    const headerMatch = line.match(/【([^】]+)】/);
    if (headerMatch) {
      currentSection = headerMatch[1];
      if (VIP_TITLE_REGEX.test(line)) {
        removedVip = true;
        continue;
      }
      const headerOnly = rawLine.match(/【[^】]+】/)?.[0] || rawLine;
      const restOfHeader = line.replace(headerOnly, '').trim();
      if (restOfHeader && VIP_LEAK_LINE_REGEX.test(restOfHeader)) {
        removedVip = true;
        keptLines.push(headerOnly);
        continue;
      }
      keptLines.push(rawLine);
      continue;
    }

    if (currentSection && !VIP_TITLE_REGEX.test(currentSection) && VIP_LEAK_LINE_REGEX.test(line)) {
      removedVip = true;
      continue;
    }

    keptLines.push(rawLine);
  }

  sanitized = keptLines.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: sanitized, removedVip };
}
