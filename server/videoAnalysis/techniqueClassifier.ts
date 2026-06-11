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

  const segmentList = segments
    .map(s => `- ${s.start}-${s.end}`)
    .join('\n');

  knowledgePrompt += `\n\n请分析以下视频片段：\n${segmentList}\n`;
  knowledgePrompt += `\n严格按照以下 JSON Schema 输出分类结果（仅返回 JSON）：
{
  "primary_action_id": "识别出的主要action_id（必须在候选库中，如果不确定填 unknown）",
  "confidence": 0.0到1.0的浮点数,
  "evidence": ["支持你判断的具体视觉证据..."],
  "top_candidates": [{"action_id": "xxx", "probability": 0.8}, {"action_id": "yyy", "probability": 0.2}],
  "notable_missing_cues": ["预期该动作该有但视频中看不到或未做出的线索..."],
  "analysis_notes": "简要分析过程，你为什么这样判断，特别是如果有易混淆动作，你是如何排除的"
}`;

  VideoAnalysisLogger.info(jobId, 'PASS1.5_START', `Sending classification request to ${modelName}`, {
    model: modelName,
    fps: VIDEO_FPS_PASS15,
    segmentsCount: segments.length,
    rulesCount: rules.actions.length,
  });

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
        temperature: 0.2, // Low temperature for classification consistency
        responseMimeType: 'application/json'
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
