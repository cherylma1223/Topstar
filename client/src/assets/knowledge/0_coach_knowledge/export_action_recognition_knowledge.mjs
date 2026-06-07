import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Resolve xlsx from the server directory
const xlsxPath = path.resolve(__dirname, '../../../../../server/node_modules/xlsx/xlsx.js');
const xlsx = require(xlsxPath);

const EXCEL_FILE = path.join(__dirname, 'table_tennis_action_knowledge_v2.xlsx');
const SERVER_DATA_DIR = path.resolve(__dirname, '../../../../../server/data');

const RECOGNITION_JSON_PATH = path.join(SERVER_DATA_DIR, 'action_video_analysis_knowledge.json');
const DIAGNOSIS_JSON_PATH = path.join(SERVER_DATA_DIR, 'action_diagnosis_rules.json');

function main() {
  console.log(`[export] Reading Excel file: ${EXCEL_FILE}`);
  if (!fs.existsSync(EXCEL_FILE)) {
    console.error(`Error: File not found: ${EXCEL_FILE}`);
    process.exit(1);
  }

  const wb = xlsx.readFile(EXCEL_FILE);
  
  // 1. Parse 动作清单 (Action List)
  const actionSheet = wb.Sheets['动作清单'];
  if (!actionSheet) throw new Error("Missing sheet: 动作清单");
  const actionsData = xlsx.utils.sheet_to_json(actionSheet, { range: 3 }); // Assuming row 4 is header (index 3)
  
  const actionsMap = new Map();
  const validActionIds = new Set();
  
  actionsData.forEach(row => {
    if (!row['action_id']) return;
    validActionIds.add(row['action_id']);
    
    let exclusions = [];
    if (row['不属于本技术的情况']) {
      exclusions = row['不属于本技术的情况'].split('；').map(s => s.trim()).filter(Boolean);
    }
    
    actionsMap.set(row['action_id'], {
      id: row['action_id'],
      title: row['中文名称'],
      aliases: row['别名/关键词'] ? row['别名/关键词'].split(/[、,，]/).map(s => s.trim()).filter(Boolean) : [],
      definition: row['一句话定义'],
      scope: {
        scenario: row['适用来球/场景'],
        exclusions: exclusions
      },
      positive_cues: [],
      negative_cues: []
    });
  });

  // 2. Parse 识别线索 (Recognition Cues)
  const cuesSheet = wb.Sheets['识别线索'];
  if (!cuesSheet) throw new Error("Missing sheet: 识别线索");
  const cuesData = xlsx.utils.sheet_to_json(cuesSheet, { range: 3 });
  
  cuesData.forEach(row => {
    const actionId = row['action_id'];
    if (!actionId || !actionsMap.has(actionId)) return;
    
    const cue = {
      phase: row['phase'],
      cue: row['视觉线索 cue'],
      weight: Number(row['weight']),
      why: row['为什么重要'] || undefined,
      missing_policy: row['看不到时如何处理'] || undefined
    };
    
    if (row['线索类型'] === 'positive') {
      actionsMap.get(actionId).positive_cues.push(cue);
    } else if (row['线索类型'] === 'negative') {
      actionsMap.get(actionId).negative_cues.push(cue);
    }
  });

  // 3. Parse 混淆矩阵 (Confusion Matrix)
  const confusionSheet = wb.Sheets['混淆矩阵'];
  if (!confusionSheet) throw new Error("Missing sheet: 混淆矩阵");
  const confusionData = xlsx.utils.sheet_to_json(confusionSheet, { range: 3 });
  
  const confusionMatrix = confusionData.filter(row => row['action_id'] && row['confusable_with']).map(row => ({
    action_id: row['action_id'],
    confusable_with: row['confusable_with'],
    key_difference: row['最关键区别'],
    secondary_difference: row['次要区别'] || undefined,
    required_visible_info: row['必须可见的信息'] ? row['必须可见的信息'].split(/[、,，]/).map(s => s.trim()) : [],
    low_confidence_policy: row['低置信度处理'],
    prompt_snippet: row['示例提示词片段'] || undefined
  }));

  // 4. Parse 降级规则 (Downgrade Rules)
  const downgradeSheet = wb.Sheets['降级规则'];
  if (!downgradeSheet) throw new Error("Missing sheet: 降级规则");
  const downgradeData = xlsx.utils.sheet_to_json(downgradeSheet, { range: 3 });
  
  const downgradeRules = downgradeData.filter(row => row['scope'] && row['rule_type']).map(row => ({
    scope: row['scope'],
    action_id: row['action_id'] || undefined,
    rule_type: row['rule_type'],
    condition: row['不可判断条件'],
    affects: row['影响哪些判断'],
    system_action: row['系统应采取的动作'],
    user_message: row['建议给用户的提示'] || undefined
  }));

  // Assemble Recognition JSON
  const recognitionJson = {
    schema_version: "v1",
    actions: Array.from(actionsMap.values()),
    confusion_matrix: confusionMatrix,
    downgrade_rules: downgradeRules
  };

  // 5. Parse 诊断规则 (Diagnosis Rules)
  const diagnosisSheet = wb.Sheets['诊断规则'];
  if (!diagnosisSheet) throw new Error("Missing sheet: 诊断规则");
  const diagnosisData = xlsx.utils.sheet_to_json(diagnosisSheet, { range: 3 });
  
  const diagnosisRules = diagnosisData.filter(row => row['action_id'] && row['issue_id']).map(row => ({
    action_id: row['action_id'],
    issue_id: row['issue_id'],
    evidence: row['视觉证据 evidence'],
    problem: row['问题描述 problem'],
    priority: Number(row['priority']),
    advice: row['训练建议 advice'],
    related_cues: row['相关识别线索'] ? row['相关识别线索'].split(/[、,，]/).map(s => s.trim()) : []
  }));

  const diagnosisJson = {
    schema_version: "v1",
    rules: diagnosisRules
  };

  // Create Output Directory if not exists
  if (!fs.existsSync(SERVER_DATA_DIR)) {
    fs.mkdirSync(SERVER_DATA_DIR, { recursive: true });
  }

  // Write JSON files
  fs.writeFileSync(RECOGNITION_JSON_PATH, JSON.stringify(recognitionJson, null, 2), 'utf-8');
  console.log(`[export] Wrote recognition rules to ${RECOGNITION_JSON_PATH}`);
  
  fs.writeFileSync(DIAGNOSIS_JSON_PATH, JSON.stringify(diagnosisJson, null, 2), 'utf-8');
  console.log(`[export] Wrote diagnosis rules to ${DIAGNOSIS_JSON_PATH}`);
  
  console.log('[export] Done.');
}

main();
