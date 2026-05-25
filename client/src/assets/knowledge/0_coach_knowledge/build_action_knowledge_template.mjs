import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = scriptDir;
const outputPath = path.join(outputDir, 'table_tennis_action_knowledge_template.xlsx');
const indexPath = path.join(scriptDir, '..', 'index.json');

const indexData = JSON.parse(await fs.readFile(indexPath, 'utf8'));
const actions = (indexData.entries || [])
  .filter((entry) => entry.category === 'actions')
  .map((entry) => ({
    id: entry.id,
    title: entry.title,
    keywords: (entry.keywords || []).join('、'),
  }));

const actionExamples = {
  bh_drive: {
    definition: '近台反手位处理上旋或不转来球的基础进攻/衔接技术，以前臂向前弹击为主，动作小、节奏快。',
    scenario: '近台反手位；来球多为上旋、不转或轻微下旋；常用于相持衔接、快节奏压反手。',
    exclusion: '如果来球明显出台且引拍更充分、向上摩擦和随挥更明显，更可能是反手拉球；如果是台内短球且手腕内扣外展明显，更可能是反手拧拉。',
    note: '完整填写示例：定义、适用场景、排除项都给出。',
  },
  fh_loop: {
    definition: '正手拉球是以蹬转带动手臂向前上方摩擦来球、制造上旋和弧线的主动进攻技术。',
    scenario: '正手位或侧身位；处理出台下旋、上旋或半出台球；常用于起板、连续弧圈和发球抢攻。',
    exclusion: '如果引拍较小、击球时间更早、向前撞击明显多于向上摩擦，更可能是正手攻球；如果是高球大力下压，不应归为正手拉球。',
    note: '完整填写示例：特别强调与正手攻球的边界。',
  },
};

const actionIds = actions.map((action) => action.id);
const phases = ['preparation', 'backswing', 'contact', 'swing', 'follow_through', 'recovery', 'ball_flight', 'footwork'];
const weights = [1, 2, 3];
const priorities = [1, 2, 3];
const ruleTypes = ['global_video_quality', 'action_specific', 'camera_angle', 'visibility', 'frame_rate', 'table_visibility'];
const confidenceActions = ['high_confidence', 'lower_confidence', 'unknown', 'ask_for_better_video'];

function setTitle(sheet, title, subtitle) {
  sheet.getRange('A1:H1').values = [[title, '', '', '', '', '', '', '']];
  sheet.getRange('A1:H1').format.fill = '#17324D';
  sheet.getRange('A1:H1').format.font = { color: '#FFFFFF', bold: true, size: 16 };
  sheet.getRange('A2:H2').values = [[subtitle, '', '', '', '', '', '', '']];
  sheet.getRange('A2:H2').format.fill = '#E7EEF6';
  sheet.getRange('A2:H2').format.font = { color: '#17324D', italic: true };
  sheet.getRange('A2:H2').format.wrapText = true;
}

function writeTable(sheet, startCell, headers, rows, tableName) {
  const range = sheet.getRange(startCell).write([headers, ...rows]);
  range.format.wrapText = true;
  range.format.borders = { preset: 'outside', style: 'thin', color: '#D9E2EC' };
  const headerRange = sheet.getRange(`${startCell.split(/[0-9]/)[0]}${startCell.match(/[0-9]+/)[0]}:${columnName(headers.length)}${startCell.match(/[0-9]+/)[0]}`);
  headerRange.format.fill = '#2F6B8F';
  headerRange.format.font = { color: '#FFFFFF', bold: true };
  headerRange.format.horizontalAlignment = 'center';
  sheet.tables.add(range, true).name = tableName;
  return range;
}

function columnName(index) {
  let name = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function styleSheet(sheet, widths) {
  widths.forEach((width, index) => {
    sheet.getRange(`${columnName(index + 1)}:${columnName(index + 1)}`).format.columnWidthPx = width;
  });
  sheet.getRange('1:2').format.rowHeightPx = 34;
  sheet.freezePanes.freezeRows(4);
}

function addListValidation(sheet, range, values, title, message) {
  sheet.getRange(range).dataValidation = {
    allowBlank: true,
    list: { inCellDropDown: true, source: values },
    prompt: { show: true, title, message },
    errorAlert: { show: true, title: '无效输入', message: `请从下拉列表选择：${values.join('、')}` },
  };
}

const workbook = Workbook.create();
const defaultSheet = workbook.worksheets.getItemOrNullObject?.('Sheet1');
if (defaultSheet && !defaultSheet.isNullObject) defaultSheet.delete();

const guide = workbook.worksheets.add('填写说明');
setTitle(
  guide,
  '乒乓球技术知识填写模板',
  '给专业教练填写；工程脚本后续会从各 Sheet 读取并生成视频识别 JSON。请优先填写黄色区域含义对应的列，避免修改表头。'
);
guide.getRange('A4:B15').values = [
  ['填写顺序', '建议先填「动作清单」，再填「识别线索」和「混淆矩阵」，最后补「降级规则」和「诊断规则」。'],
  ['action_id', '必须稳定，使用英文小写和下划线，例如 bh_drive。已有动作 ID 已预填。'],
  ['权重 weight', '1=辅助线索，2=重要线索，3=核心判别线索。'],
  ['优先级 priority', '1=最严重/最先改，2=重要但次之，3=细节优化。'],
  ['phase', '动作阶段：preparation 准备、backswing 引拍、contact 触球、swing 挥拍、follow_through 随挥、recovery 还原等。'],
  ['confusable_with', '填写容易混淆的另一个 action_id，例如 bh_loop。'],
  ['不可判断规则', '不是让系统失败，而是告诉系统在证据不足时降级、输出 unknown 或要求用户重拍。'],
  ['诊断规则', '必须写“视觉证据 -> 技术问题 -> 训练建议”，不要只写抽象问题。'],
  ['脚本约定', '后续转换脚本会按 Sheet 名和表头读取。可以增行，不要改表头名。'],
  ['示例', '每张表已放入少量示例，可直接覆盖或复制改写。'],
  ['', ''],
  ['', ''],
];
guide.getRange('A4:A15').format.fill = '#F4D35E';
guide.getRange('A4:B15').format.wrapText = true;
guide.getRange('A4:B15').format.borders = { preset: 'outside', style: 'thin', color: '#D9E2EC' };
styleSheet(guide, [150, 860, 80, 80, 80, 80, 80, 80]);

const dictionarySheet = workbook.worksheets.add('数据字典');
setTitle(
  dictionarySheet,
  '数据字典',
  '解释本工作簿所有 Sheet 和字段的含义、范例、填写要求与常见误填。教练填写前建议先看这里。'
);
writeTable(
  dictionarySheet,
  'A4',
  ['Sheet', '字段', '是否必填', '字段含义', '填写范例', '填写说明 / 常见误填'],
  [
    ['动作清单', 'action_id', '必填', '技术动作的稳定机器 ID，后续脚本、视频识别和教程推荐都用它关联。', 'bh_drive', '只用英文小写、数字、下划线。不要写中文、空格或频繁改名。已有动作不要改 ID。'],
    ['动作清单', '中文名称', '必填', '教练和用户看到的技术动作名称。', '反手拨球', '名称要具体，避免“反手技术”这类过宽名称。'],
    ['动作清单', '别名/关键词', '建议填', '用户可能使用的叫法，用于搜索、匹配和提示词补充。', '反手拨、反手快拨、拨球', '多个词用顿号或逗号分隔。不要把相反动作也写进来。'],
    ['动作清单', '一句话定义', '必填', '用一句话说明这个动作是什么，以及最核心的动作性质。', '近台反手位处理上旋或不转来球的基础衔接技术，以前臂向前弹击为主。', '要写“动作本质”，不是训练口号。'],
    ['动作清单', '适用来球/场景', '必填', '这个动作通常在什么来球、位置、距离、战术场景下使用。', '近台反手位；上旋或不转来球；相持衔接。', '尽量写可观察条件：台内/出台、正手/反手、近台/中远台、上旋/下旋。'],
    ['动作清单', '不属于本技术的情况', '必填', '定义边界：哪些相似情况不应判为本动作。', '引拍明显更低且向上摩擦充分时，更可能是反手拉球。', '这是减少误识别的关键。请明确写“更可能是哪个动作”。'],
    ['动作清单', '状态', '必填', '控制动作是否进入识别候选。', 'active', 'active=启用；draft=草稿；deprecated=废弃但保留。'],
    ['动作清单', '备注', '可选', '给维护者看的补充说明。', '与反手拉球边界需重点验证。', '不会直接作为核心识别字段，但可给审核使用。'],

    ['识别线索', 'action_id', '必填', '这条视觉线索属于哪个动作。', 'bh_drive', '必须来自「动作清单」。'],
    ['识别线索', '线索类型', '必填', 'positive 表示支持该动作；negative 表示排除该动作或提示其他动作。', 'positive', '不要把“常见错误”写成识别线索，错误应写到「诊断规则」。'],
    ['识别线索', 'phase', '必填', '线索发生在动作哪个阶段。', 'backswing', 'preparation=准备；backswing=引拍；contact=触球；swing=挥拍；follow_through=随挥；recovery=还原。'],
    ['识别线索', '视觉线索 cue', '必填', '视频里能直接观察到的动作、球路、站位或拍形特征。', '前臂以肘为轴向前弹出，挥拍幅度小。', '要写“看得见的证据”，少写“发力好”“质量高”这类结果判断。'],
    ['识别线索', 'weight', '必填', '这条线索对识别动作的重要程度。', '3', '1=辅助；2=重要；3=核心。核心线索不宜过多。'],
    ['识别线索', '为什么重要', '建议填', '说明这条线索为什么能帮助判断动作。', '区分反手拨球和反手拉球的核心线索。', '用于后续 prompt 解释和人工审核。'],
    ['识别线索', '看不到时如何处理', '建议填', '如果这条线索在视频里看不清，系统应如何降级。', '降低置信度，不要强判为反手拨球。', '请写具体处理：降低置信度、输出 top2、标记 unknown、建议重拍。'],
    ['识别线索', '备注', '可选', '补充说明。', '侧前方视角更容易观察。', '不要放必须解析的信息。'],

    ['混淆矩阵', 'action_id', '必填', '动作 A。', 'bh_drive', '必须来自「动作清单」。'],
    ['混淆矩阵', 'confusable_with', '必填', '容易与动作 A 混淆的动作 B。', 'bh_loop', '必须来自「动作清单」。'],
    ['混淆矩阵', '最关键区别', '必填', 'A 和 B 最重要、最能一锤定音的区别。', '拨球动作小且向前多；反手拉球引拍更充分、向上摩擦更多。', '这是最关键字段。请优先写可观察差异。'],
    ['混淆矩阵', '次要区别', '建议填', '辅助判断的差异。', '拉球随挥更完整，核心参与更明显。', '不要重复最关键区别。'],
    ['混淆矩阵', '必须可见的信息', '必填', '要区分这两个动作，视频里必须看见什么。', '引拍幅度、挥拍方向、触球阶段。', '如果必须信息看不到，系统应降级。'],
    ['混淆矩阵', '低置信度处理', '必填', '区分不了时系统应如何处理。', '同时输出 top2 候选，不进入强诊断。', '避免硬猜。可以写 unknown、uncertain、要求重拍等。'],
    ['混淆矩阵', '示例提示词片段', '可选', '可直接放入识别 prompt 的教练判断语句。', '如果引拍和触球方向不可见，不要在 bh_drive 与 bh_loop 间强判。', '用清晰、短句、可执行的表达。'],

    ['降级规则', 'scope', '必填', '规则范围：global 表示所有动作通用；action 表示某动作专属。', 'global', '全局视频质量问题写 global；某动作特有要求写 action。'],
    ['降级规则', 'action_id', '条件必填', 'scope=action 时填写动作 ID；scope=global 时留空。', 'bh_flick', 'scope=action 时必须来自「动作清单」。'],
    ['降级规则', 'rule_type', '必填', '降级原因类型，方便脚本分类。', 'visibility', '可选：visibility、camera_angle、frame_rate、table_visibility 等。'],
    ['降级规则', '不可判断条件', '必填', '什么画面条件下证据不足，不能高置信度判断。', '看不到触球瞬间。', '写具体画面问题，不要写“视频不好”。'],
    ['降级规则', '影响哪些判断', '必填', '该条件会影响哪些动作或哪些区分。', '所有技术动作识别。', '例如“台内技术”“发球旋转”“拉球/攻球区分”。'],
    ['降级规则', '系统应采取的动作', '必填', '模型或产品遇到该情况时的处理策略。', 'lower_confidence', 'high_confidence、lower_confidence、unknown、ask_for_better_video。'],
    ['降级规则', '建议给用户的提示', '建议填', '需要反馈给用户的拍摄建议或解释。', '请尽量拍到击球前后完整动作。', '语气要具体、可操作。'],
    ['降级规则', '备注', '可选', '补充说明。', '发球类动作尤其重要。', '不要放必须解析的信息。'],

    ['诊断规则', 'action_id', '必填', '这条诊断规则属于哪个动作。', 'fh_loop', '必须来自「动作清单」。'],
    ['诊断规则', 'issue_id', '必填', '技术问题的稳定机器 ID。', 'fh_loop_late_contact', '英文小写和下划线。建议格式：action_problem。'],
    ['诊断规则', '视觉证据 evidence', '必填', '视频里看到什么，才能判断这个问题存在。', '击球点靠后，身体被球顶住，随挥仓促。', '必须是可见证据。不要只写“发力不顺”。'],
    ['诊断规则', '问题描述 problem', '必填', '给用户看的技术问题表述。', '击球点太晚，导致拉球质量不稳定。', '要简短明确。'],
    ['诊断规则', 'priority', '必填', '问题优先级。', '1', '1=最先改；2=重要；3=细节优化。'],
    ['诊断规则', '训练建议 advice', '必填', '针对该问题的训练或纠正建议。', '提前移动到位，在身体右前方击球，先练固定落点多球。', '建议要可练、可执行。'],
    ['诊断规则', '相关识别线索', '可选', '这条诊断和哪些识别/观察线索有关。', '击球点、引拍、随挥', '用于审核和后续 prompt 组织。'],
    ['诊断规则', '备注', '可选', '补充说明。', '优先在多球训练视频中验证。', '不要放必须解析的信息。'],

    ['枚举值', '字段', '系统维护', '枚举类型名称。', 'phase', '通常不用教练修改。'],
    ['枚举值', '候选值', '系统维护', '下拉框可选值列表。', 'preparation, backswing, contact', '如果新增枚举，应同步脚本和数据校验。'],
  ],
  'DataDictionary'
);
styleSheet(dictionarySheet, [130, 170, 100, 420, 360, 460, 80, 80]);
dictionarySheet.getRange('A4:F80').format.rowHeightPx = 54;

const actionSheet = workbook.worksheets.add('动作清单');
setTitle(actionSheet, '动作清单', '每行一个技术动作。教练可以补充定义、适用来球、排除情况和别名。');
writeTable(
  actionSheet,
  'A4',
  ['action_id', '中文名称', '别名/关键词', '一句话定义', '适用来球/场景', '不属于本技术的情况', '状态', '备注'],
  actions.map((action) => [
    action.id,
    action.title,
    action.keywords,
    actionExamples[action.id]?.definition || '',
    actionExamples[action.id]?.scenario || '',
    actionExamples[action.id]?.exclusion || '',
    'active',
    actionExamples[action.id]?.note || '',
  ]),
  'ActionList'
);
styleSheet(actionSheet, [130, 160, 240, 360, 340, 360, 100, 220]);
addListValidation(actionSheet, `G5:G${actions.length + 60}`, ['active', 'draft', 'deprecated'], '状态', 'active 会进入视频识别候选；draft 只保存不启用。');

const cueSheet = workbook.worksheets.add('识别线索');
setTitle(cueSheet, '视频识别线索', '描述视频里能直接观察到的正向/反向线索。每条线索独立一行，便于脚本转 JSON。');
writeTable(
  cueSheet,
  'A4',
  ['action_id', '线索类型', 'phase', '视觉线索 cue', 'weight', '为什么重要', '看不到时如何处理', '备注'],
  [
    ['bh_drive', 'positive', 'swing', '前臂以肘为轴向前弹出，挥拍幅度小', 3, '区分反手拨球和反手拉球的核心线索', '降低置信度，不要强判为反手拨球', '示例'],
    ['bh_drive', 'negative', 'backswing', '引拍明显更低且向上摩擦充分', 3, '更像反手拉球', '加入 bh_loop 作为 top2 候选', '示例'],
    ['fh_loop', 'positive', 'backswing', '引拍较低，蹬转后向前上方摩擦', 3, '正手拉球核心动作链', '看不到引拍时降低置信度', '示例'],
  ],
  'RecognitionCues'
);
styleSheet(cueSheet, [130, 120, 130, 380, 80, 320, 320, 180]);
addListValidation(cueSheet, 'A5:A200', actionIds, '选择动作 ID', '必须来自动作清单。');
addListValidation(cueSheet, 'B5:B200', ['positive', 'negative'], '线索类型', 'positive=支持该动作；negative=排除或提示其他动作。');
addListValidation(cueSheet, 'C5:C200', phases, '动作阶段', '选择线索发生在动作哪个阶段。');
addListValidation(cueSheet, 'E5:E200', weights, '权重', '1=辅助，2=重要，3=核心。');

const confusionSheet = workbook.worksheets.add('混淆矩阵');
setTitle(confusionSheet, '易混淆技术区分', '专门填写两个相似动作怎么区分。这张表对提升识别准确度最关键。');
writeTable(
  confusionSheet,
  'A4',
  ['action_id', 'confusable_with', '最关键区别', '次要区别', '必须可见的信息', '低置信度处理', '示例提示词片段'],
  [
    ['bh_drive', 'bh_loop', '拨球动作小且向前多；反手拉球引拍更充分、向上摩擦更多', '拉球随挥更完整，核心参与更明显', '引拍幅度、挥拍方向、触球阶段', '同时输出 top2 候选，不进入强诊断', '如果引拍和触球方向不可见，不要在 bh_drive 与 bh_loop 间强判。'],
    ['bh_flick', 'bh_drive', '拧拉多处理台内短球，手腕内扣外展明显；拨球更偏近台出台球衔接', '拧拉肘部支点更突出', '球是否台内、手腕动作、肘部位置', '标记 uncertain，要求更清晰侧前方视角', '看不到球台短长时，不要高置信度识别 bh_flick。'],
  ],
  'ConfusionMatrix'
);
styleSheet(confusionSheet, [130, 150, 380, 300, 300, 300, 360]);
addListValidation(confusionSheet, 'A5:A200', actionIds, '动作 A', '必须来自动作清单。');
addListValidation(confusionSheet, 'B5:B200', actionIds, '动作 B', '必须来自动作清单。');

const downgradeSheet = workbook.worksheets.add('降级规则');
setTitle(downgradeSheet, '不可判断 / 降级规则', '既可以填全局视频质量规则，也可以填某个动作的专属降级规则。');
writeTable(
  downgradeSheet,
  'A4',
  ['scope', 'action_id', 'rule_type', '不可判断条件', '影响哪些判断', '系统应采取的动作', '建议给用户的提示', '备注'],
  [
    ['global', '', 'visibility', '看不到触球瞬间', '所有技术动作识别', 'lower_confidence', '请尽量拍到击球前后完整动作。', '全局规则示例'],
    ['global', '', 'table_visibility', '看不到球台，无法判断台内/出台', '台内技术、拉球/拨球区分', 'unknown', '请把球台和击球点一起拍进画面。', '全局规则示例'],
    ['action', 'bh_flick', 'visibility', '看不到手腕内扣到外展过程', '反手拧拉识别', 'lower_confidence', '反手拧拉需要拍清手腕和肘部支点。', '动作专属示例'],
  ],
  'DowngradeRules'
);
styleSheet(downgradeSheet, [100, 130, 150, 360, 300, 180, 360, 180]);
addListValidation(downgradeSheet, 'A5:A200', ['global', 'action'], '规则范围', 'global=所有动作通用；action=某个动作专属。');
addListValidation(downgradeSheet, 'B5:B200', ['', ...actionIds], '动作 ID', 'scope=action 时必填。');
addListValidation(downgradeSheet, 'C5:C200', ruleTypes, '规则类型', '用于脚本分类。');
addListValidation(downgradeSheet, 'F5:F200', confidenceActions, '系统动作', '低置信度、unknown 或提示用户重拍。');

const diagnosisSheet = workbook.worksheets.add('诊断规则');
setTitle(diagnosisSheet, '常见错误诊断规则', '识别出动作后，用视觉证据映射到问题和训练建议。');
writeTable(
  diagnosisSheet,
  'A4',
  ['action_id', 'issue_id', '视觉证据 evidence', '问题描述 problem', 'priority', '训练建议 advice', '相关识别线索', '备注'],
  [
    ['bh_drive', 'bh_drive_elbow_unstable', '肘部左右晃动，出球方向不稳定', '肘部不稳，导致拨球方向控制差', 1, '把肘部固定在身体前方，只让前臂以肘为轴向前弹出。', '肘部稳定', '示例'],
    ['fh_loop', 'fh_loop_late_contact', '击球点靠后，身体被球顶住，随挥仓促', '击球点太晚，导致拉球质量不稳定', 1, '提前移动到位，在身体右前方击球，先练固定落点多球。', '击球点', '示例'],
  ],
  'DiagnosisRules'
);
styleSheet(diagnosisSheet, [130, 220, 360, 320, 80, 420, 220, 180]);
addListValidation(diagnosisSheet, 'A5:A200', actionIds, '动作 ID', '必须来自动作清单。');
addListValidation(diagnosisSheet, 'E5:E200', priorities, '优先级', '1=最先改，2=重要，3=细节优化。');

const enumSheet = workbook.worksheets.add('枚举值');
setTitle(enumSheet, '枚举值', '脚本和下拉框使用的候选值。通常不需要教练修改。');
const enumRows = [
  ['action_ids', actionIds.join(', ')],
  ['phase', phases.join(', ')],
  ['weight', weights.join(', ')],
  ['priority', priorities.join(', ')],
  ['rule_type', ruleTypes.join(', ')],
  ['system_action', confidenceActions.join(', ')],
];
writeTable(enumSheet, 'A4', ['字段', '候选值'], enumRows, 'Enums');
styleSheet(enumSheet, [180, 900, 80, 80, 80, 80, 80, 80]);

for (const sheetName of ['动作清单', '识别线索', '混淆矩阵', '降级规则', '诊断规则']) {
  const sheet = workbook.worksheets.getItem(sheetName);
  sheet.getRange('A4:H200').format.rowHeightPx = 42;
  sheet.getRange('A4:H4').format.rowHeightPx = 36;
}

await fs.mkdir(outputDir, { recursive: true });

const guideInspect = await workbook.inspect({
  kind: 'table',
  range: '填写说明!A1:B12',
  include: 'values,formulas',
  tableMaxRows: 12,
  tableMaxCols: 2,
});
console.log(guideInspect.ndjson);

const errorScan = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 100 },
  summary: 'final formula error scan',
});
console.log(errorScan.ndjson);

for (const name of ['填写说明', '数据字典', '动作清单', '识别线索', '混淆矩阵', '降级规则', '诊断规则', '枚举值']) {
  await workbook.render({ sheetName: name, range: 'A1:H18', scale: 1 });
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
