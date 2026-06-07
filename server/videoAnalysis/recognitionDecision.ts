import { ClassificationResult } from './techniqueClassifier';

export type RecognitionStatus = 'confirmed' | 'tentative' | 'unknown' | 'ambiguous';

export interface DecisionAction {
  status: RecognitionStatus;
  validated_action_id: string; // The action_id to use for diagnosis (if applicable)
  downgrade_reason?: string;   // Internal reason
  user_message?: string;       // User-facing fallback text
}

export function evaluateClassification(result: ClassificationResult): DecisionAction {
  const primaryId = result.primary_action_id;
  const conf = result.confidence;

  // 1. Handle explicit 'unknown'
  if (primaryId === 'unknown') {
    return {
      status: 'unknown',
      validated_action_id: 'unknown',
      downgrade_reason: 'Model explicitly returned unknown',
      user_message: '这段视频暂时无法稳定判断具体技术，可能没有完整的技术动作或者拍摄条件不足。'
    };
  }

  // 2. High confidence
  if (conf >= 0.75) {
    return {
      status: 'confirmed',
      validated_action_id: primaryId
    };
  }

  // 3. Margin calculation for middle confidence
  let margin = 1.0; // Assume huge margin if no second candidate
  if (result.top_candidates && result.top_candidates.length >= 2) {
    const top1 = result.top_candidates[0].probability;
    const top2 = result.top_candidates[1].probability;
    margin = top1 - top2;
  }

  // 4. Low confidence
  if (conf < 0.55) {
    return {
      status: 'unknown',
      validated_action_id: 'unknown',
      downgrade_reason: `Confidence too low (${conf})`,
      user_message: '识别置信度过低，无法给出准确的技术诊断。建议从侧前方拍摄，确保拍到球员、球台和击球瞬间。'
    };
  }

  // 5. Middle confidence but ambiguous
  if (margin <= 0.15 && result.top_candidates.length >= 2) {
    const altId = result.top_candidates[1].action_id;
    return {
      status: 'ambiguous',
      validated_action_id: primaryId, // Still pass the primary, but mark as ambiguous
      downgrade_reason: `Margin too low (${margin}) between ${primaryId} and ${altId}`,
      user_message: `动作特征介于两项技术之间，主要按【${primaryId}】进行基础诊断，仅供参考。`
    };
  }

  // 6. Middle confidence, acceptable margin
  return {
    status: 'tentative',
    validated_action_id: primaryId,
    downgrade_reason: `Moderate confidence (${conf})`,
    user_message: `动作特征不够明显，尝试按【${primaryId}】给出诊断。为获得更好结果，建议改善拍摄视角或光线。`
  };
}
