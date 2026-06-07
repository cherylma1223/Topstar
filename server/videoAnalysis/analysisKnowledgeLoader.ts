import fs from 'fs';
import path from 'path';
import { getKnowledgeStore } from '../knowledge/loader';

// === Interfaces matching the generated JSON Schema ===

export interface ActionRecognitionCue {
  phase: string;
  cue: string;
  weight: number;
  why?: string;
  missing_policy?: string;
}

export interface ActionRecognitionInfo {
  id: string;
  title: string;
  aliases: string[];
  definition: string;
  scope: {
    scenario?: string;
    exclusions: string[];
  };
  positive_cues: ActionRecognitionCue[];
  negative_cues: ActionRecognitionCue[];
}

export interface ConfusionMatrixEntry {
  action_id: string;
  confusable_with: string;
  key_difference: string;
  secondary_difference?: string;
  required_visible_info: string[];
  low_confidence_policy?: string;
  prompt_snippet?: string;
}

export interface DowngradeRule {
  scope: string; // 'global' | 'action'
  action_id?: string;
  rule_type: string;
  condition: string;
  affects: string;
  system_action: string;
  user_message?: string;
}

export interface VideoAnalysisKnowledge {
  schema_version: string;
  actions: ActionRecognitionInfo[];
  confusion_matrix: ConfusionMatrixEntry[];
  downgrade_rules: DowngradeRule[];
}

export interface DiagnosisRule {
  action_id: string;
  issue_id: string;
  evidence: string;
  problem: string;
  priority: number;
  advice: string;
  related_cues: string[];
}

export interface ActionDiagnosisRules {
  schema_version: string;
  rules: DiagnosisRule[];
}

// === Loader Implementation ===

const SERVER_DATA_DIR = path.join(__dirname, '..', 'data');
const RECOGNITION_JSON_PATH = path.join(SERVER_DATA_DIR, 'action_video_analysis_knowledge.json');
const DIAGNOSIS_JSON_PATH = path.join(SERVER_DATA_DIR, 'action_diagnosis_rules.json');

let recognitionRules: VideoAnalysisKnowledge | null = null;
let diagnosisRules: ActionDiagnosisRules | null = null;

/**
 * Initialize and load the knowledge rules
 */
export function loadAnalysisKnowledge(): void {
  try {
    if (fs.existsSync(RECOGNITION_JSON_PATH)) {
      recognitionRules = JSON.parse(fs.readFileSync(RECOGNITION_JSON_PATH, 'utf-8'));
    }
    if (fs.existsSync(DIAGNOSIS_JSON_PATH)) {
      diagnosisRules = JSON.parse(fs.readFileSync(DIAGNOSIS_JSON_PATH, 'utf-8'));
    }
    
    if (recognitionRules && diagnosisRules) {
      console.log(`[VideoAnalysis] Successfully loaded knowledge from JSON (${recognitionRules.actions.length} actions).`);
      return;
    }
  } catch (error) {
    console.error(`[VideoAnalysis] Failed to load JSON knowledge:`, error);
  }

  // Fallback
  console.warn(`[VideoAnalysis] JSON knowledge missing or invalid, falling back to Markdown parser (Dev Mode).`);
  buildFallbackKnowledge();
}

function buildFallbackKnowledge() {
  const store = getKnowledgeStore();
  if (store.size === 0) {
    console.warn(`[VideoAnalysis] Knowledge store is empty, please ensure 'loadKnowledgeBase()' is called first.`);
  }
  
  const actions: ActionRecognitionInfo[] = [];
  const rules: DiagnosisRule[] = [];
  
  for (const [id, entry] of store.entries()) {
    if (entry.category !== 'actions') continue;

    const content = entry.content;
    const { positive_cues, diagnosis } = parseMarkdownContent(content);
    
    actions.push({
      id,
      title: entry.title,
      aliases: entry.keywords || [],
      definition: entry.title,
      scope: { exclusions: [] },
      positive_cues,
      negative_cues: []
    });

    diagnosis.forEach((d, index) => {
      rules.push({
        action_id: id,
        issue_id: `fallback_${id}_${index}`,
        evidence: 'N/A',
        problem: d.problem,
        priority: 2,
        advice: d.advice,
        related_cues: []
      });
    });
  }

  recognitionRules = {
    schema_version: 'fallback',
    actions,
    confusion_matrix: [],
    downgrade_rules: []
  };

  diagnosisRules = {
    schema_version: 'fallback',
    rules
  };
}

function parseMarkdownContent(content: string) {
  const positive_cues: ActionRecognitionCue[] = [];
  const diagnosis: {problem: string, advice: string}[] = [];
  
  const rulesMatch = content.match(/### 【动作要领】([\s\S]*?)###/);
  if (rulesMatch) {
    const lines = rulesMatch[1].split('\n').filter(l => l.trim().startsWith('- **'));
    lines.forEach(line => {
      const match = line.match(/- \*\*(.*?)\*\*：(.*)/);
      if (match) {
        positive_cues.push({
          phase: match[1].trim(),
          cue: match[2].trim(),
          weight: 2
        });
      }
    });
  }

  const diagMatch = content.match(/### 【常见问题与纠错建议库】([\s\S]*?)(###|$)/);
  if (diagMatch) {
    const lines = diagMatch[1].split('\n');
    let currentProblem = '';
    
    for (const line of lines) {
      const pMatch = line.match(/- \*\*技术问题：(.*?)\*\*/);
      if (pMatch) {
        currentProblem = pMatch[1].trim();
      } else {
        const aMatch = line.match(/\s+- \*\*训练建议\*\*：(.*)/);
        if (aMatch && currentProblem) {
          diagnosis.push({
            problem: currentProblem,
            advice: aMatch[1].trim()
          });
          currentProblem = '';
        }
      }
    }
  }

  return { positive_cues, diagnosis };
}

export function getRecognitionRules(): VideoAnalysisKnowledge | null {
  if (!recognitionRules) loadAnalysisKnowledge();
  return recognitionRules;
}

export function getDiagnosisRules(): ActionDiagnosisRules | null {
  if (!diagnosisRules) loadAnalysisKnowledge();
  return diagnosisRules;
}

export function getActionIds(): string[] {
  const rules = getRecognitionRules();
  if (!rules) return [];
  return rules.actions.map(a => a.id);
}
