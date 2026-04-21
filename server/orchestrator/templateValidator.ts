/**
 * 输出模板校验器
 * 
 * 设计文档 §7.3：按 intent 类型校验 LLM 输出段落
 * 若段落缺失，补入"暂无相关内容"占位
 */
import type { IntentType } from '../intent/intentRouter';

interface TemplateSection {
  marker: string;         // 段落标记（如 '【动作要领】'）
  fallbackContent: string; // 缺失时的占位内容
}

const TEMPLATE_RULES: Partial<Record<IntentType, TemplateSection[]>> = {
  ACTION_COACHING: [
    { marker: '【动作要领】', fallbackContent: '【动作要领】\n暂无相关内容，请尝试更具体地描述您想了解的技术动作。\n' },
    { marker: '【常见问题】', fallbackContent: '【常见问题】\n暂无相关内容。\n' },
    { marker: '【训练建议】', fallbackContent: '【训练建议】\n暂无相关内容。\n' },
  ],
  TACTIC_ADVICE: [
    { marker: '【存在问题', fallbackContent: '【存在问题/定性分析】\n暂无相关内容。\n' },
    { marker: '【改进建议', fallbackContent: '【改进建议/实战策略】\n暂无相关内容。\n' },
  ],
  EQUIPMENT_QA: [
    { marker: '【性能特点】', fallbackContent: '【性能特点】\n暂无相关内容。\n' },
    { marker: '【适合打法】', fallbackContent: '【适合打法】\n暂无相关内容。\n' },
  ],
};

/**
 * 校验 LLM 输出是否包含必要段落，缺失则补充
 * 
 * @param text - LLM 返回的文本
 * @param intent - 当前意图类型
 * @returns 校验/补全后的文本
 */
export function validateTemplate(text: string, intent: IntentType): string {
  const rules = TEMPLATE_RULES[intent];
  if (!rules) return text; // 没有模板规则的 intent 直接返回

  let result = text;
  const missingSections: string[] = [];

  for (const rule of rules) {
    if (!result.includes(rule.marker)) {
      missingSections.push(rule.marker);
      result += '\n\n' + rule.fallbackContent;
    }
  }

  if (missingSections.length > 0) {
    console.warn(`[TemplateValidator] Missing sections for ${intent}: ${missingSections.join(', ')}`);
  }

  return result;
}
