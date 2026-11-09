/**
 * 意图路由器
 * 
 * 设计文档 §5.2：规则优先 + LLM 结构化分类兜底
 * 
 * 第一层：规则强命中（高置信度，无需 LLM）
 * 第二层：LLM 结构化分类（处理规则未命中的情况）
 */
import { generate } from '../llm';
import { getActionIds } from '../knowledge/loader';

export type IntentType =
  | 'ACTION_COACHING'
  | 'TACTIC_ADVICE'
  | 'EQUIPMENT_QA'
  | 'TUTORIAL_REQUEST'
  | 'VIDEO_ANALYSIS'
  // 乒乓球相关但不属于技术动作类：赛事、球员动态、规则、历史等。自由格式回答，套模板会答非所问
  | 'GENERAL_TT'
  // 仅限与乒乓球完全无关的话题；乒乓球相关一律不得判为 OFF_TOPIC
  | 'OFF_TOPIC';

export interface IntentResult {
  intent: IntentType;
  secondaryIntents: IntentType[];
  entities: {
    action_id: string | null;
    equipment_query: string | null;
    tactic_topic: string | null;
  };
  confidence: number;
  source: 'rule' | 'llm' | 'fallback';
  reason?: string;
}

// ==================
// 第一层：规则强命中
// ==================

const TUTORIAL_KEYWORDS = ['视频教程', '教学视频', '示范视频', '给我个视频', '给我一个视频', '推荐视频', '看视频学', '有没有视频'];
const VIDEO_ANALYSIS_KEYWORDS = ['上传视频', '我拍了', '我录了', '帮我看视频', '分析视频', '分析我的', '看看我的视频'];
const EQUIPMENT_KEYWORDS = ['胶皮', '底板', '套胶', '球拍', '球鞋', '护膝', '胶水', '海绵'];
const EQUIPMENT_BRANDS = ['蝴蝶', '红双喜', '斯帝卡', '挺拔', '银河', '亚萨卡', '尼塔库', 'butterfly', 'stiga', 'dhs', 'tibhar', 'nittaku'];

// 敏感词（极简黑名单，可后续扩展）
const SENSITIVE_KEYWORDS = ['赌博', '色情', '暴力', '毒品'];

/** 敏感词判定（规则层与联网检索前置共用，避免「跑题也去搜」把不良内容带进上下文） */
export function isSensitiveMessage(message: string): boolean {
  return SENSITIVE_KEYWORDS.some(w => message.includes(w));
}

function ruleBasedClassify(message: string, event?: string): IntentResult | null {
  const lower = message.toLowerCase();

  // 敏感词拦截
  if (isSensitiveMessage(message)) {
    return {
      intent: 'OFF_TOPIC',
      secondaryIntents: [],
      entities: { action_id: null, equipment_query: null, tactic_topic: null },
      confidence: 1.0,
      source: 'rule',
      reason: '敏感词拦截',
    };
  }

  // 视频分析（事件或关键词）
  if (event === 'video' || VIDEO_ANALYSIS_KEYWORDS.some(w => message.includes(w))) {
    return {
      intent: 'VIDEO_ANALYSIS',
      secondaryIntents: [],
      entities: { action_id: null, equipment_query: null, tactic_topic: null },
      confidence: 0.95,
      source: 'rule',
      reason: '视频分析关键词/事件命中',
    };
  }

  // 教程请求
  if (TUTORIAL_KEYWORDS.some(w => message.includes(w))) {
    return {
      intent: 'TUTORIAL_REQUEST',
      secondaryIntents: [],
      entities: { action_id: null, equipment_query: null, tactic_topic: null },
      confidence: 0.9,
      source: 'rule',
      reason: '教程请求关键词命中',
    };
  }

  // 器材咨询
  const hasEquipment = EQUIPMENT_KEYWORDS.some(w => message.includes(w));
  const hasBrand = EQUIPMENT_BRANDS.some(w => lower.includes(w));
  if (hasEquipment || hasBrand) {
    const equipmentQuery = EQUIPMENT_KEYWORDS.find(w => message.includes(w)) ||
      EQUIPMENT_BRANDS.find(w => lower.includes(w)) || null;
    return {
      intent: 'EQUIPMENT_QA',
      secondaryIntents: [],
      entities: { action_id: null, equipment_query: equipmentQuery, tactic_topic: null },
      confidence: 0.85,
      source: 'rule',
      reason: '器材关键词/品牌命中',
    };
  }

  // 规则未命中
  return null;
}

// ==================
// 第二层：LLM 结构化分类
// ==================

async function llmClassify(message: string): Promise<IntentResult> {
  const actionIds = getActionIds();

  const prompt = `你是一个乒乓球应用的意图分类器。请分析用户的输入，返回一个 JSON 对象。
  
只能输出 JSON，不要输出任何解释文字。

可选的 intent 值（必须从以下枚举中选择）：
- ACTION_COACHING：动作怎么练/要领/纠错
- TACTIC_ADVICE：实战问题/对抗策略/比赛复盘
- EQUIPMENT_QA：器材咨询/搭配推荐
- TUTORIAL_REQUEST：明确要视频教程/示范视频
- VIDEO_ANALYSIS：上传视频并产出分析报告
- GENERAL_TT：乒乓球相关但非技术动作的问题——赛事结果、球员动态（退役/转会/伤病/排名）、比赛规则与赛制、历史战绩、协会与商业新闻、观赛、业余圈子话题
- OFF_TOPIC：与乒乓球**完全无关**的话题——娱乐八卦、财经、编程、医疗健康、生活琐事、其他运动项目等

判定铁律：
1. 只要问题涉及乒乓球（含球员姓名、赛事、规则、器材、训练、伤病、心理），一律不得判为 OFF_TOPIC。
2. 拿不准是否与乒乓球有关时，判为 GENERAL_TT；宁可多判 GENERAL_TT，也不要错判 OFF_TOPIC。
3. OFF_TOPIC 只用于明确与乒乓球无关的话题。

可选的 action_id 值（如果是动作相关，从以下候选中选择，否则为 null）：
${JSON.stringify(actionIds)}

输出格式：
{
  "intent": "ACTION_COACHING",
  "secondary_intents": [],
  "entities": {
    "action_id": null,
    "equipment_query": null,
    "tactic_topic": null
  },
  "confidence": 0.85,
  "reason": "简要说明判断原因"
}

用户输入：${message}`;

  try {
    const { text } = await generate({
      capability: 'intent',
      messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
      temperature: 0.1,  // 低温度，减少漂移
    });

    // 提取 JSON（可能被包裹在 ```json ... ``` 中）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[IntentRouter] LLM returned non-JSON:', text.substring(0, 200));
      return fallbackResult(message);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // 验证返回的 intent 是否在枚举中
    const validIntents: IntentType[] = ['ACTION_COACHING', 'TACTIC_ADVICE', 'EQUIPMENT_QA', 'TUTORIAL_REQUEST', 'VIDEO_ANALYSIS', 'GENERAL_TT', 'OFF_TOPIC'];
    if (!validIntents.includes(parsed.intent)) {
      console.warn('[IntentRouter] LLM returned invalid intent:', parsed.intent);
      return fallbackResult(message);
    }

    // 验证 action_id 是否在候选集中（防止编造）
    let entityActionId = parsed.entities?.action_id || null;
    if (entityActionId && !actionIds.includes(entityActionId)) {
      console.warn('[IntentRouter] LLM returned invalid action_id:', entityActionId);
      entityActionId = null;
    }

    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;

    // 低置信度降级
    if (confidence < 0.5) {
      console.warn(`[IntentRouter] Low confidence (${confidence}), falling back`);
      return fallbackResult(message);
    }

    return {
      intent: parsed.intent,
      secondaryIntents: (parsed.secondary_intents || []).filter((i: string) => validIntents.includes(i as IntentType)),
      entities: {
        action_id: entityActionId,
        equipment_query: parsed.entities?.equipment_query || null,
        tactic_topic: parsed.entities?.tactic_topic || null,
      },
      confidence,
      source: 'llm',
      reason: parsed.reason || '',
    };
  } catch (error: any) {
    console.error('[IntentRouter] LLM classification failed:', error.message);
    return fallbackResult(message);
  }
}

/**
 * 降级结果：默认为 ACTION_COACHING
 */
function fallbackResult(_message: string): IntentResult {
  return {
    intent: 'ACTION_COACHING',
    secondaryIntents: [],
    entities: { action_id: null, equipment_query: null, tactic_topic: null },
    confidence: 0.3,
    source: 'fallback',
    reason: 'LLM 分类失败或低置信度，降级为默认意图',
  };
}

// ==================
// 对外接口
// ==================

/**
 * 意图分类入口
 * 
 * 流程：规则层 → LLM 兜底
 * 
 * @param message - 用户消息
 * @param event - 可选事件类型（如 'video'）
 */
export async function classifyIntent(message: string, event?: string): Promise<IntentResult> {
  const startTime = Date.now();

  // 第一层：规则强命中
  const ruleResult = ruleBasedClassify(message, event);
  if (ruleResult) {
    console.log(`[IntentRouter] Rule hit: ${ruleResult.intent} (${Date.now() - startTime}ms)`);
    return ruleResult;
  }

  // 第二层：LLM 结构化分类
  const llmResult = await llmClassify(message);
  console.log(`[IntentRouter] LLM classify: ${llmResult.intent} (confidence: ${llmResult.confidence}, ${Date.now() - startTime}ms)`);
  return llmResult;
}
