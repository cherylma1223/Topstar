/**
 * 知识编排层
 * 
 * 设计文档 §6：预处理 → 意图路由 → 检索 → 上下文组装 → 调用模型 → 后处理 → 输出
 */
import { v4 as uuid } from 'uuid';
import { classifyIntent, type IntentResult, type IntentType } from '../intent/intentRouter';
import { matchKnowledge, getKnowledgeSummary } from '../knowledge/matcher';
import { getActionAliasMap } from '../knowledge/loader';
import { recommendTutorials, type RecommendedTutorial } from '../tutorials/recommendTutorials';
import { validateTemplate } from './templateValidator';
import { getAI, withRetry } from '../routes/v1';

// ==================
// 类型定义
// ==================

export interface ChatRequest {
  message: string;
  history?: Array<{ sender: string; content: string }>;
  prefs?: Record<string, any>;
  event?: string;
}

export interface ChatResponse {
  success: boolean;
  answerText: string;
  intent: IntentType;
  references: Array<{ type: string; id: string; title: string }>;
  tutorialVideos: RecommendedTutorial[];
  report: null; // Phase 2
  meta: {
    request_id: string;
    cost: { input_tokens: number; output_tokens: number };
    degraded: boolean;
    intent_source: string;
    intent_confidence: number;
  };
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    request_id: string;
  };
}

// ==================
// 输出模板 prompt 约束
// ==================

const TEMPLATE_PROMPTS: Partial<Record<IntentType, string>> = {
  ACTION_COACHING: `!!! 极度重要的内容隔离规则 !!!
请你完全并且严格地按照以下顺序和格式组成回复，每个核心部分必须以方括号标题开头：

【动作要领】（基础技术要点，此段落中严禁提及任何涉及到“核心”、“秘诀”、“二次点火”等属于私密指导的内容）
【常见问题】（常见的错误和问题）
【训练建议】（具体的训练方法和建议）
【核心秘诀】（如果你读取的参考知识库原文中存在“【核心秘诀】”模块，你必须强制把该模块的内容单独陈列在这个标题下，不准将其糅合到上述其他段落中，如果没有则不输出此标题）

重要规则：不要在回复中编造任何视频链接或URL。视频教程会由系统自动从库中推荐。`,

  TACTIC_ADVICE: `请按照以下结构回复：
【存在问题/定性分析】（分析用户遇到的问题）
【改进建议/实战策略】（具体的改进方法和策略建议）

重要规则：不要在回复中编造任何视频链接或URL。`,

  EQUIPMENT_QA: `请按照以下结构回复：
【性能特点】（器材的性能特征）
【适合打法】（适合什么类型的打法/选手）
【代表运动员】（使用此器材的知名运动员）
【价格区间】（大致价格范围）

重要规则：不要在回复中编造任何视频链接或URL。`,

  TUTORIAL_REQUEST: `用户在寻找视频教程。请用1-2句话简要说明这个技术的要点，视频教程会由系统自动推荐，不需要你提供链接。
重要规则：不要在回复中编造任何视频链接或URL。`,
};

const VIP_SECTION_REGEX = /(?:^|\n)(?:###\s*)?【(?:核心秘诀|VIP专属)[^】]*】[\s\S]*?(?=(?:\n(?:###\s*)?【|\n【|$))/g;
const VIP_TITLE_REGEX = /【(?:核心秘诀|VIP专属)[^】]*】/;
const VIP_LEAK_LINE_REGEX = /(核心秘诀|VIP专属|会员专属|二次点火|金牌教练|喷射感|猛压拍肩|食指.*(?:拍肩|发力|加速))/i;
const LOCKED_VIP_BLOCK = '【核心秘诀】\n[LOCKED_VIP_CONTENT]';

function stripVipSectionsFromKnowledge(content: string): { content: string; hasVipSecret: boolean } {
  const hasVipSecret = VIP_SECTION_REGEX.test(content);
  VIP_SECTION_REGEX.lastIndex = 0;

  if (!hasVipSecret) {
    return { content, hasVipSecret: false };
  }

  return {
    content: content.replace(VIP_SECTION_REGEX, '').trim(),
    hasVipSecret: true,
  };
}

function sanitizeAnswerTextForNonVip(answerText: string): { text: string; removedVip: boolean } {
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

// ==================
// 编排主函数
// ==================

export async function handleChatEvent(req: ChatRequest): Promise<ChatResponse | ErrorResponse> {
  const requestId = uuid();
  const startTime = Date.now();

  try {
    // 1. 意图路由
    let intentResult: IntentResult;
    try {
      intentResult = await classifyIntent(req.message, req.event);
    } catch (err: any) {
      console.error(`[Orchestrator] Intent classification failed:`, err.message);
      // 降级：使用默认意图
      intentResult = {
        intent: 'ACTION_COACHING',
        secondaryIntents: [],
        entities: { action_id: null, equipment_query: null, tactic_topic: null },
        confidence: 0.3,
        source: 'fallback',
        reason: 'Intent classification error',
      };
    }

    // 2. 知识检索
    const knowledgeHits = matchKnowledge(req.message);
    let knowledgeContext = '';
    let hasVipSecret = false;
    const isVip = req.prefs?.is_vip === true;

    if (knowledgeHits.length > 0) {
      knowledgeContext = '\n\n以下是你必须参考的乒乓球专业知识库（与本次提问相关的内容）：\n\n';
      for (const item of knowledgeHits) {
        let contentToFeed = item.content;

        const vipResult = stripVipSectionsFromKnowledge(contentToFeed);
        if (vipResult.hasVipSecret) {
          hasVipSecret = true;
          if (!isVip) {
            // 非 VIP 用户入模前直接物理剥离秘诀正文
            contentToFeed = vipResult.content;
          }
        }

        knowledgeContext += `【${item.title}】(Ref: ${item.id})\n${contentToFeed}\n\n`;
      }
    } else {
      knowledgeContext = '\n\n' + getKnowledgeSummary();
    }

    // 3. 教程推荐（ACTION_COACHING 和 TUTORIAL_REQUEST 触发）
    let tutorialVideos: RecommendedTutorial[] = [];
    const needsTutorials =
      intentResult.intent === 'TUTORIAL_REQUEST' ||
      intentResult.intent === 'ACTION_COACHING' ||
      intentResult.secondaryIntents.includes('TUTORIAL_REQUEST');

    if (needsTutorials) {
      // 构建搜索标签
      const searchTags: string[] = [];

      // 从知识库命中中提取关键词
      for (const hit of knowledgeHits) {
        if (hit.title) searchTags.push(hit.title);
      }

      // 从用户消息中提取常见乒乓球术语作为标签
      const aliasMap = getActionAliasMap();
      for (const [actionId, aliases] of aliasMap) {
        for (const alias of aliases) {
          if (req.message.includes(alias)) {
            searchTags.push(alias);
          }
        }
      }

      tutorialVideos = recommendTutorials(
        intentResult.entities.action_id,
        searchTags,
        3
      );
    }

    // 4. 组装 system instruction
    const templatePrompt = TEMPLATE_PROMPTS[intentResult.intent] || '';
    const globalConstraints = `
重要约束：
1. 严禁使用任何标准 Markdown 格式符号（如 **加粗**、### 标题、* 列表、- 列表、_斜体_ 等）。
2. 结构化必须且仅能使用 【标题名称】 的格式。
3. 换行使用标准换行符。
4. 语言要专业、精炼。
`;
    const systemInstruction = '你是一名专业的乒乓球教练，擅长为业余爱好者提供技术指导。\n' +
      globalConstraints +
      templatePrompt +
      knowledgeContext;
    const finalSystemInstruction = !isVip && hasVipSecret
      ? systemInstruction + '\n重要权限规则：知识库中的 VIP/核心秘诀内容只对会员开放。你绝对不能在任何段落中提及、改写、复述或暗示这部分内容；如果无法确认，宁可省略。'
      : systemInstruction;

    // 5. 调用 LLM 生成回复
    const contents = (req.history || []).map(msg => ({
      role: msg.sender === 'user' ? 'user' as const : 'model' as const,
      parts: [{ text: msg.content }],
    }));

    contents.push({
      role: 'user' as const,
      parts: [{ text: req.message }],
    });

    let answerText = '';
    try {
      const response = await withRetry(() => getAI().models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: contents,
        config: {
          systemInstruction: finalSystemInstruction,
        },
      }));
      answerText = response.text || '';
    } catch (err: any) {
      console.error(`[Orchestrator] LLM generation failed:`, err.message);
      return {
        success: false,
        error: {
          code: 'LLM_UNAVAILABLE',
          message: '模型服务暂时不可用，请稍后再试',
          retryable: true,
          request_id: requestId,
        },
      };
    }

    // 6. 模板校验后处理
    answerText = validateTemplate(answerText, intentResult.intent);

    // 7. 非 VIP 最终输出脱敏 + 强制下发前端锁区占位
    if (!isVip) {
      const { text: sanitizedAnswerText, removedVip } = sanitizeAnswerTextForNonVip(answerText);
      answerText = sanitizedAnswerText;

      if ((hasVipSecret || removedVip) && !answerText.includes('[LOCKED_VIP_CONTENT]')) {
        answerText = answerText
          ? `${answerText}\n\n${LOCKED_VIP_BLOCK}\n`
          : `${LOCKED_VIP_BLOCK}\n`;
      }
    }

    // 8. 构建引用列表
    const references = knowledgeHits.map(hit => ({
      type: `${hit.category}_doc`,
      id: hit.id,
      title: hit.title,
    }));

    console.log(`[Orchestrator] ${requestId} | intent=${intentResult.intent} | vip=${isVip} | refs=${references.length} | tutorials=${tutorialVideos.length} | ${Date.now() - startTime}ms`);

    return {
      success: true,
      answerText,
      intent: intentResult.intent,
      references,
      tutorialVideos,
      report: null,
      meta: {
        request_id: requestId,
        cost: { input_tokens: 0, output_tokens: 0 }, // TODO: 后续从 API response 提取
        degraded: intentResult.source === 'fallback',
        intent_source: intentResult.source,
        intent_confidence: intentResult.confidence,
      },
    };
  } catch (err: any) {
    console.error(`[Orchestrator] Unexpected error:`, err);
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务端未预期错误',
        retryable: true,
        request_id: requestId,
      },
    };
  }
}
