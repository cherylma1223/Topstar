import { VideoSegment } from '../orchestrator/handleAnalysisJob';
import { getRecognitionRules } from './analysisKnowledgeLoader';
import { VideoAnalysisLogger } from './videoAnalysisLogger';

/** Pass 1.5 技术分类帧率（需高精度捕捉动作特征） */
const VIDEO_FPS_PASS15 = Number(process.env.VIDEO_FPS_PASS15) || 5;

export interface TopCandidate {
  action_id: string;
  probability: number;
}

export interface ClassificationResult {
  primary_action_id: string;
  confidence: number;
  evidence: string[];
  top_candidates: TopCandidate[];
  notable_missing_cues: string[];
  analysis_notes: string;
}

export async function classifyTechnique(
  fileData: { fileUri: string; mimeType: string },
  segments: VideoSegment[],
  aiClient: any,
  modelName: string,
  jobId: string
): Promise<ClassificationResult> {
  const rules = getRecognitionRules();
  
  if (!rules) {
    throw new Error('Recognition rules could not be loaded.');
  }

  // 1. Build the prompt with knowledge constraints
  let knowledgePrompt = `你是一个专业的乒乓球技术动作分类器。请观看这部分视频片段中的主体技术动作，并从以下候选库中选出最符合的技术（如果无法确定，请输出 "unknown"）。\n\n`;
  knowledgePrompt += `【全局基础假设】\n如无特别说明，下文中所有的动作细节描述（如：手腕、前臂、大臂、手臂、掌心、手背等）均默认特指球员的【持拍手】及对应方位。请在观察视频、比对线索时，严格忽略非持拍手（空手）的干扰。\n\n`;
  
  knowledgePrompt += `【候选动作库】\n`;
  rules.actions.forEach(action => {
    knowledgePrompt += `- ${action.id} (${action.title}): ${action.definition}\n`;
    knowledgePrompt += `  核心线索（若出现则加分）：\n`;
    action.positive_cues.forEach(cue => {
      knowledgePrompt += `    - [${cue.phase}] ${cue.cue} (权重: ${cue.weight})\n`;
    });
    if (action.negative_cues && action.negative_cues.length > 0) {
      knowledgePrompt += `  排他线索（若出现则减分）：\n`;
      action.negative_cues.forEach(cue => {
        knowledgePrompt += `    - [${cue.phase}] ${cue.cue}\n`;
      });
    }
  });

  knowledgePrompt += `\n【易混淆动作辨析】\n`;
  rules.confusion_matrix.forEach(matrix => {
    knowledgePrompt += `- ${matrix.action_id} vs ${matrix.confusable_with}:\n`;
    knowledgePrompt += `  关键区别: ${matrix.key_difference}\n`;
    if (matrix.prompt_snippet) {
      knowledgePrompt += `  提示: ${matrix.prompt_snippet}\n`;
    }
  });

  knowledgePrompt += `\n【重要降级/容错规则】\n`;
  rules.downgrade_rules.forEach(rule => {
    knowledgePrompt += `- 如果 ${rule.condition}，影响 ${rule.affects}。系统操作: ${rule.system_action}\n`;
  });

  knowledgePrompt += `\n【多模态与强制推理约束】
你必须严格按照以下规则进行多模态分析与分层推理，禁止跳步：

第1步：聆听语音指令，并评估语音置信度
  仔细聆听视频中的语音/环境音，并按以下三级标准判断语音的可信程度：
  - 【高置信度】：语音清晰，且口令明确指向单一技术动作（如"拉球"、"摩擦"、"下蹲迎前"）。
    → 以语音意图为主，可覆盖视觉判断。
  - 【中置信度】：语音存在，但含义模糊或非技术性词汇（如"好"、"再来"、"注意"）。
    → 语音仅作参考，视觉判断为主。
  - 【低置信度/无语音】：无可辨识语音，或背景噪声无法区分主体声音。
    → 忽略语音，纯视觉判断。
  在 analysis_notes 中记录：你听到了什么、判定的语音置信度等级及理由。

第2步：识别持拍手与击球动作结构（判定正/反手），并评估置信度
  首先观察并确认球员的【持拍手】（左手/右手），然后根据动作的解剖学结构判定是正手（Forehand）还是反手（Backhand）。不要受球员在球台上的站位影响。
  - 【正手位（Forehand）】特征：
    1. 引拍时，持拍手在躯干同侧（右手球员在右侧，左手球员在左侧）。
    2. 击球时，【持拍手】的掌心及正手胶皮朝向出球方向（请务必忽略非持拍手的姿态）。
    3. 挥拍轨迹通常由外向内（如右手由右向左前）。
  - 【反手位（Backhand）】特征：
    1. 引拍时，持拍手在躯干正前方或跨越中线至对侧（右手球员在腹前或左前方）。
    2. 击球时，【持拍手】的手背及反手胶皮朝向出球方向（请务必忽略非持拍手的姿态）。
    3. 挥拍轨迹通常由内向外（如右手由左腹前向右前弹击/拉伸）。
  - 【易错边界场景】：
    1. 左手球员：所有左右方向完全相反！务必先确认持拍手。
    2. 侧身正手：无论球员跑到球台的哪个角落（即使在最左侧），只要是用躯干同侧、掌心向前的动作击球，必须判定为"正手位，高置信度"。
  方位禁止规则（仅在高置信度时生效）：
  - 高置信度反手位 → 禁止输出任何 fh_ 开头的 action_id
  - 高置信度正手位 → 禁止输出任何 bh_ 开头的 action_id
  - 中/低置信度方位 → 不强制限制，但须在 analysis_notes 中标注不确定性
  在 analysis_notes 中记录：判定的方位、方位置信度及理由。

第3步：综合研判技术类型
  结合以下信号进行综合判断：
  - 视觉信号：动作幅度（小撞击 vs 大幅度摩擦）、身体重心转移、随挥轨迹
  - 语音信号（依据第1步的置信度等级决定权重）
  重点注意：即使画面动作幅度较小（看起来像拨球），但如果第1步语音为【高置信度】且明确提示拉球技术要领，请以语音意图为准，将动作判定为拉球（如：bh_loop）。

第4步：在 analysis_notes 中输出结构化推理结论
  必须包含以下字段，便于系统自动校验：
  - 语音内容：[听到的具体内容，或"无可辨识语音"]
  - 语音置信度：[高/中/低]
  - 判定方位：[正手位/反手位/不确定]
  - 方位置信度：[高/中/低]
  - 最终 action_id：[选择的动作ID]
  - 选择理由：[综合视觉与语音的判断依据]
\n`;

  const segmentList = segments
    .map(s => `- ${s.start}-${s.end}`)
    .join('\n');

  knowledgePrompt += `\n\n请分析以下视频片段：\n${segmentList}\n`;
  knowledgePrompt += `\n严格按照以下 JSON Schema 输出分类结果（仅返回 JSON）：
{
  "analysis_notes": "【必须第一步输出】详细输出你的分层推理过程。必须包含：1.语音内容及置信度 2.判定方位及置信度 3.视觉与语音的综合研判过程 4.最终决定的action_id",
  "primary_action_id": "识别出的主要action_id（必须在候选库中，根据 analysis_notes 的结论填写，如果不确定填 unknown）",
  "confidence": 0.0到1.0的浮点数,
  "evidence": ["支持你判断的具体视觉证据..."],
  "top_candidates": [{"action_id": "xxx", "probability": 0.8}, {"action_id": "yyy", "probability": 0.2}],
  "notable_missing_cues": ["预期该动作该有但视频中看不到或未做出的线索..."]
}`;

  VideoAnalysisLogger.info(jobId, 'PASS1.5_START', `Sending classification request to ${modelName}`, {
    model: modelName,
    fps: VIDEO_FPS_PASS15,
    segmentsCount: segments.length,
    rulesCount: rules.actions.length,
  });

  const PASS15_SCHEMA = {
    type: 'OBJECT',
    properties: {
      analysis_notes: { type: 'STRING' },
      primary_action_id: { type: 'STRING' },
      confidence: { type: 'NUMBER' },
      evidence: { type: 'ARRAY', items: { type: 'STRING' } },
      top_candidates: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            action_id: { type: 'STRING' },
            probability: { type: 'NUMBER' }
          },
          required: ['action_id', 'probability']
        }
      },
      notable_missing_cues: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['analysis_notes', 'primary_action_id', 'confidence', 'evidence', 'top_candidates', 'notable_missing_cues']
  };

  // 2. Call Gemini
  let responseText = '';
  try {
    const response = await aiClient.models.generateContent({
      model: modelName,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData, videoMetadata: { fps: VIDEO_FPS_PASS15 } },
            { text: knowledgePrompt }
          ]
        }
      ],
      config: {
        temperature: 0.2, // Low temperature for strict classification consistency and layered reasoning
        responseMimeType: 'application/json',
        responseSchema: PASS15_SCHEMA
      }
    });

    responseText = response.text || '';
  } catch (err: any) {
    VideoAnalysisLogger.error(jobId, 'PASS1.5_FAILED', `Gemini classification request failed: ${err.message}`);
    throw err;
  }

  if (!responseText) {
    const errorMsg = 'Empty response from model during classification.';
    VideoAnalysisLogger.error(jobId, 'PASS1.5_FAILED', errorMsg);
    throw new Error(errorMsg);
  }

  // 3. Parse JSON
  try {
    let rawResult = JSON.parse(responseText);
    VideoAnalysisLogger.info(jobId, 'PASS1.5_OUTPUT', 'Pass 1.5 raw output received', rawResult);
    
    // Handle case where Gemini returns an array of objects instead of a single object
    if (Array.isArray(rawResult)) {
      rawResult = rawResult.length > 0 ? rawResult[0] : {};
    }

    const result: ClassificationResult = {
      primary_action_id: rawResult.primary_action_id || 'unknown',
      confidence: typeof rawResult.confidence === 'number' ? rawResult.confidence : 0,
      evidence: Array.isArray(rawResult.evidence) ? rawResult.evidence : [],
      top_candidates: Array.isArray(rawResult.top_candidates) ? rawResult.top_candidates : [],
      notable_missing_cues: Array.isArray(rawResult.notable_missing_cues) ? rawResult.notable_missing_cues : [],
      analysis_notes: rawResult.analysis_notes || ''
    };
    
    VideoAnalysisLogger.info(jobId, 'PASS1.5_COMPLETE', `Classification complete: ${result.primary_action_id} (conf: ${result.confidence})`, result);
    return result;
  } catch (err: any) {
    VideoAnalysisLogger.error(jobId, 'PASS1.5_PARSE_FAILED', `Failed to parse classification JSON. Raw: ${responseText}`);
    throw new Error(`RECOGNITION_PARSE_FAILED: ${err.message}`);
  }
}
