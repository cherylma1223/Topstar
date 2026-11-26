# -*- coding: utf-8 -*-
"""
乒乓球单项技术多模态识别与诊断知识库 v3 生成脚本 (Part 1/3)
依赖安装: pip install openpyxl
"""

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# ==================== Sheet 1: 填写说明 ====================
SHEET_README = [
    ["乒乓球技术知识填写模板 (v3 多模态工程优化版)", ""],
    ["说明", "本模板供乒乓球教练与算法工程师协作维护；脚本读取各 Sheet 生成阶段2(动作路由)与阶段3(动作诊断)专用 JSON。"],
    ["", ""],
    ["核心升级点(v3)", "1. 读写分离：识别线索只写客观轨迹/来球/声音不变量，绝不拿标准动作卡死初学者；2. 左右手解耦：统一采用『持拍侧/非持拍侧』相对描述；3. 诊断扩充：新增可见度前置条件(visibility_req)与同源错误归并组(issue_group)。"],
    ["填写顺序", "先维护「动作清单」，再填「识别线索」与「混淆矩阵」（用于阶段2分类），最后填「降级规则」与「诊断规则」（用于阶段3纠错）。"],
    ["action_id", "英文小写+下划线，保持稳定。v3 已补齐钟摆发球(pendulum_serve)，并将笼统的接发球拆分为正/反手搓摆(fh_push / bh_push)。"],
    ["cue_channel", "识别线索通道：player_motion=学员动作轨迹，ball_and_feed=来球弧线与喂球手法，audio_cue=击球声与口令。"],
    ["权重 weight", "1=辅助加分线索（如转腰蹬腿、口令），2=重要特征，3=核心判别不变量（即使动作变形也成立的特征）。"],
    ["visibility_req", "诊断规则的镜头前提：full_body=需全身含脚可见，upper_body=半身可见即可，table_and_ball=需看清球台落点与弧线。"],
    ["issue_group", "同源错误归并组：同一组内若同时命中多条错误（如抬肘+甩大臂），阶段3合并为1条核心建议输出，避免车轱辘话。"],
    ["空间方向约定", "严禁硬编码『右手/右脚』，统一使用『持拍侧/非持拍侧』（工程端可根据阶段1识别出的左右手自动替换为左或右）。"],
]

# ==================== Sheet 2: 数据字典 ====================
SHEET_DICT = [
    ["sheet_name", "column_name", "英文键名", "是否必填", "数据类型", "字段用途与工程约束"],
    ["动作清单", "action_id", "action_id", "是", "string", "全局唯一动作主键"],
    ["动作清单", "动作中文名", "name_zh", "是", "string", "前端展示与报告输出名称"],
    ["动作清单", "英文名", "name_en", "是", "string", "英文标识"],
    ["动作清单", "技术大类", "category", "是", "enum", "见枚举值 Sheet"],
    ["动作清单", "技术细类", "sub_category", "是", "string", "细分子类"],
    ["动作清单", "适用水平", "level", "是", "string", "初学 / 进阶 / 通用"],
    ["动作清单", "典型场景", "typical_scene", "是", "string", "多球定点击球 / 发球单练 / 接发球等"],
    ["动作清单", "一句话定义", "summary", "是", "string", "供阶段2大模型快速理解动作本质"],
    ["动作清单", "标准动作要领", "standard_essentials", "是", "string", "仅注入阶段3作为正确基准参考，不注入阶段2"],
    ["动作清单", "教练核心秘诀", "coach_tips", "否", "string", "仅用于阶段3生成训练处方时的文案润色，严禁用于视觉判别"],
    ["动作清单", "父级降级ID", "parent_action_id", "否", "string", "当旋转/细节看不清时优雅退化的通用类别"],
    ["动作清单", "正向达标亮点", "positive_highlights", "是", "string", "格式：视觉达标特征->表扬话术；用于阶段3先肯定优点"],
    ["识别线索", "action_id", "action_id", "是", "string", "关联动作清单"],
    ["识别线索", "线索类型", "cue_type", "是", "enum", "positive=正向支持，negative=反向排除"],
    ["识别线索", "线索通道", "cue_channel", "是", "enum", "player_motion / ball_and_feed / audio_cue"],
    ["识别线索", "动作阶段", "phase", "是", "enum", "见枚举值 Sheet"],
    ["识别线索", "可观察线索描述", "cue_desc", "是", "string", "必须是VLM肉眼可见的几何位置/轨迹或清晰声音，禁写心理与体感词"],
    ["识别线索", "权重", "weight", "是", "int", "1 / 2 / 3"],
    ["识别线索", "缺失时处理", "missing_policy", "否", "enum", "keep_evaluating / lower_confidence / output_top2"],
    ["混淆矩阵", "action_id", "action_id", "是", "string", "当前动作"],
    ["混淆矩阵", "易混动作ID", "confusable_with", "是", "string", "易混淆的另一动作"],
    ["混淆矩阵", "核心区分点", "key_diff", "是", "string", "注入阶段2的对比裁决规则(Tie-Breaker)"],
    ["混淆矩阵", "决定性阶段", "decisive_phase", "是", "enum", "见枚举值 Sheet"],
    ["混淆矩阵", "低置信度策略", "low_conf_action", "是", "enum", "output_top2 / lower_confidence / uncertain"],
    ["降级规则", "rule_id", "rule_id", "是", "string", "规则唯一ID"],
    ["降级规则", "适用范围", "scope", "是", "enum", "global 或具体 action_id"],
    ["降级规则", "规则类型", "rule_type", "是", "enum", "camera_angle / visibility / ball_visibility / frame_rate / table_visibility"],
    ["降级规则", "触发条件", "trigger_cond", "是", "string", "阶段1或阶段2检测到该视觉缺陷时触发"],
    ["降级规则", "系统动作", "system_action", "是", "enum", "lower_confidence / ask_for_better_video / unknown"],
    ["降级规则", "前端提示语", "user_prompt", "是", "string", "直接返回给用户的友好重拍引导"],
    ["诊断规则", "action_id", "action_id", "是", "string", "关联动作清单"],
    ["诊断规则", "问题ID", "issue_id", "是", "string", "全局唯一错误编码"],
    ["诊断规则", "动作阶段", "phase", "是", "enum", "见枚举值 Sheet"],
    ["诊断规则", "同源归并组", "issue_group", "是", "enum", "同组命中多条时合并输出"],
    ["诊断规则", "机位可见度要求", "visibility_req", "是", "enum", "full_body / upper_body / table_and_ball"],
    ["诊断规则", "视觉证据(VLM核验项)", "visual_evidence", "是", "string", "纯客观跨帧几何姿态/轨迹异常描述"],
    ["诊断规则", "技术问题定性", "problem_desc", "是", "string", "专业教练归因诊断"],
    ["诊断规则", "针对性训练建议", "training_advice", "是", "string", "具体可执行的纠正练习与体感口诀"],
    ["诊断规则", "修改优先级", "priority", "是", "int", "1=破坏发力框架必改，2=重要提升，3=细节打磨"],
]

# ==================== Sheet 8: 枚举值 ====================
SHEET_ENUMS = [
    ["枚举组名", "合法枚举值列表 (逗号分隔)", "工程说明"],
    ["category", "反手进攻, 反手控制与防守, 正手进攻, 正手控制与防守, 发球技术", "技术大类"],
    ["cue_type", "positive, negative", "正向支持线索 / 反向排他线索"],
    ["cue_channel", "player_motion, ball_and_feed, audio_cue", "多模态线索来源通道"],
    ["phase", "preparation, backswing, contact, swing, follow_through, recovery, ball_flight, footwork", "已统一修正 follow_through"],
    ["weight", "1, 2, 3", "1=辅助，2=重要，3=核心不变量"],
    ["priority", "1, 2, 3", "1=最高优(主矛盾)，2=次优，3=细节"],
    ["rule_type", "camera_angle, visibility, ball_visibility, frame_rate, table_visibility", "降级检测维度"],
    ["system_action", "high_confidence, lower_confidence, output_top2, uncertain, unknown, ask_for_better_video", "标准化系统路由动作"],
    ["visibility_req", "full_body, upper_body, table_and_ball", "若阶段1判定半身入镜，自动跳过 full_body 类规则"],
    ["issue_group", "arm_fulcrum, swing_brake, core_legs, racket_angle, timing_point, balance_hand, footwork_pos, serve_mechanics", "防止同一病因重复输出多条建议"],
]

# ==================== Sheet 3: 动作清单 (15个标准单项) ====================
SHEET_ACTIONS_HEADER = [
    "action_id", "动作中文名", "英文名", "技术大类", "技术细类", "适用水平",
    "典型场景", "一句话定义", "标准动作要领", "教练核心秘诀", "父级降级ID", "正向达标亮点"
]

SHEET_ACTIONS_ROWS = [
    ("bh_drive", "反手拨球/攻球", "Backhand Drive", "反手进攻", "快攻/借力相持", "初学~进阶",
     "上旋多球定点、反手斜线对拨", "在台面以上迎前借力，以肘为支点前臂快速向前斜上方轻快撞击与轻擦结合的近台技术。",
     "双脚略宽于肩微蹲，引拍至腹前偏持拍侧（拍高略高于或平齐台面），在来球上升期以肘为相对支点，前臂伴随手腕微外展向前上方发力，挥至胸前偏持拍侧即制动还原。",
     "像在胸前画小半圆顶出去，借来球反弹之力迎前快拨，前臂轻快莫抡大臂。", "",
     "双膝微屈重心平稳->下盘站位扎实；引拍紧凑不拉后手->胸前三角区保持极佳；击球后快速回腹前->连续还原意识好"),

    ("bh_loop", "反手拉弧圈球", "Backhand Loop", "反手进攻", "弧圈进攻(含起下旋与相持)", "初学~高阶",
     "多球喂下旋拉球、搓球后反手起板、反手弧圈相持", "通过较充分的沉拍内收蓄力，在触球瞬间利用前臂与手腕快速摩擦制造强烈上旋弧线的进攻技术。",
     "拉下旋时重心与球拍明显下沉至台面以下（两腿间腹前），拉上旋时平齐台面蓄力；手腕适度内屈，肘部撑起做稳定支点；蹬地顶胯带动前臂向持拍侧前上方高速鞭打摩擦，在额前斜上方突然制动。",
     "手肘定住做轴心，手腕像拧毛巾一样瞬间外展弹射，挥到眼睛斜前方急刹车！", "bh_drive",
     "引拍明显下沉至台面下->迎下旋引拍位置准确；双膝弯曲蓄力低->下盘重心压得稳；触球弧线饱满稳定上台->摩擦制造弧线意识好"),

    ("bh_block", "反手防弧圈(快带/贴防)", "Backhand Block", "反手控制与防守", "借力防守", "进阶",
     "防守对方正反手拉球、高速相持借力变线", "面对强上旋或冲球，几乎不向后引拍，在上升前期靠固定拍形短促借力封堵回击。",
     "重心前倾迎前，球拍置于胸腹前紧凑位置，拍面适度前倾压住；在来球刚弹起的上升前期触球中上部，手腕绷紧固定，前臂仅做数厘米短促迎前推送即停。",
     "迎上去按住球头！借对方的冲力挡回去，动作越小越稳，切忌后退等球。", "bh_drive",
     "来球弹起瞬间即迎前触球->上升前期抢点精准；拍面稳定无多余后拉->借力防守动作极其紧凑"),

    ("bh_push", "反手搓球与摆短", "Backhand Push & Drop Shot", "反手控制与防守", "台内下旋控制", "初学~高阶",
     "下旋多球对搓、接发球反手摆短或劈长", "持拍侧脚或重心探入近台，拍面后仰在球中下部向底部切摩制造下旋的控制技术。",
     "身体贴近球台，引拍至胸腹前偏高处，拍面后仰；慢搓/劈长在上升后期至高点期前臂向前下方切送，摆短则在上升前期手腕手指轻触球底即刻制动减力。",
     "摆短要借球刚弹起的劲儿轻轻一托一抹就停住；劈长则要盯准球底干脆利落地切向对方底线。", "",
     "上步贴近球台重心前探->迎前步法意识好；回球弧线低平不出高球->拍形控制稳定"),

    ("bh_flick", "反手拧拉", "Backhand Banana Flick", "反手进攻", "台内起板进攻", "进阶~高阶",
     "台内短球多球拧拉、接发球直接反手抢攻", "持拍侧脚深入台内，手肘外撑架高，手腕极度内屈后在台内近网处瞬间外展摩擦制造侧上旋弧圈。",
     "持拍侧脚大幅跨入台内支撑，重心前探；手肘抬起向前撑开，手腕向怀里充分内屈蓄力；在球高点期手腕配合手指瞬间向外弹抖摩擦球侧上部，小幅度制动后迅速撤步还原。",
     "脚踩进台底找球，手肘架高给手腕留空间，像甩鞭子尖一样把手腕弹出去。", "bh_loop",
     "持拍侧脚果断跨入台内->上步找球到位；手腕内屈充分->台内蓄力空间足"),

    ("fh_drive", "正手攻球", "Forehand Drive", "正手进攻", "快攻/基本功", "初学~进阶",
     "正手斜线定点对攻、多球正手基本功训练", "站位近台，向持拍侧小幅引拍，通过转腰带动大臂与前臂收小臂向前上方撞击为主的快攻基础技术。",
     "两脚开立，持拍侧脚稍后；转腰约30度向持拍侧腰旁小幅引拍（大小臂夹角约100度，不拉到身后）；在上升期至高点期蹬转收前臂迎前击球中部偏上，挥至眉心/额前制动还原。",
     "腰带手走，在身体侧前方击球，收小臂像敬礼一样停在眉心前，紧凑连贯。", "",
     "始终在身体侧前方迎前击球->击球点位置极佳；收小臂至额前连贯还原->正手攻框架标准"),

    ("fh_loop", "正手拉弧圈球", "Forehand Loop", "正手进攻", "弧圈进攻(起下旋与前冲)", "初学~高阶",
     "正手多球拉下旋、搓球后侧身抢拉、中近台对拉", "充分转腰沉肩引拍蓄力，利用蹬地转腰鞭打传导至前臂手腕强烈摩擦制造高速上旋弧线的核心得分技术。",
     "拉下旋时持拍侧腿微蹲、转腰沉肩将拍引至持拍侧膝胯高度（台面以下），拉上旋时引拍略平齐台面；触球前持拍侧脚蹬地、转髋转腰带动大臂，触球瞬间快收前臂摩擦球中上部，随挥至非持拍侧额前上方制动。",
     "劲儿从脚底板蹬起来，腰胯先把大臂甩出去，触球瞬间前臂加速咬住球皮擦过去！", "fh_drive",
     "转腰沉肩引拍充分->蓄力空间饱满；下肢蹬转带动上肢明显->全身发力链条顺畅"),

    ("fh_block", "正手快带与封堵", "Forehand Block", "正手控制与防守", "借力防守/反击", "进阶",
     "防守对方拉冲至正手位、高速相持借力快带", "面对强上旋来球，利用小幅转腰迎前与固定拍面，在上升期借来球冲力快速带回或封堵。",
     "不向身后拉手，直接微转腰将拍置于身体侧前方台面之上，拍面适度前倾；在来球上升期靠腰腹绷紧带着前臂向前轻快迎带，动作短促紧凑。",
     "用腰合住来球的力量往前送，手千万别软也别往后拉拍。", "fh_drive",
     "不拉后手迎前快带->借力时机把握准确；重心前压稳定->抗冲防守扎实"),

    ("fh_push", "正手搓球与摆短", "Forehand Push & Drop Shot", "正手控制与防守", "台内下旋控制", "初学~高阶",
     "接正手位短发球摆短、正手位台内控制劈长", "持拍侧脚跨入正手台内，拍面后仰在球底部轻托减力（摆短）或切送（搓长）的台内控制技术。",
     "持拍侧脚向正手台内迈步支撑，身体前倾靠近球，球拍置于胸前偏持拍侧；摆短在上升前期手指手腕轻触球中下部即停，搓长则前臂向持拍侧前下方切送，击球后持拍侧脚迅速蹬回还原。",
     "脚到身到球才稳，千万别站在台外伸长胳膊去够正手短球！", "",
     "持拍侧脚主动跨入台内支撑->正手步法上步到位；回球不出高->台内手感柔和"),

    ("fh_flick", "正手挑打", "Forehand Flick", "正手进攻", "台内快攻抢点", "进阶~高阶",
     "正手台内短球抢攻、接短发球直接挑打突击", "持拍侧脚大步跨入台内，利用手腕后展再快速前弹（或小幅暴挑摩擦）在台内高点期直接进攻短球。",
     "持拍侧脚果断跨入正手台内（脚尖外展稳住重心），手臂随身体入台，手腕微后仰亮拍（下旋短球多亮拍托击，上旋不转压拍弹击）；在高点期前臂带手腕短促向前弹击，手腕瞬间制动防触台。",
     "先上脚踩稳再出手，全靠前臂手腕在台内那一下寸劲暴弹！", "fh_drive",
     "大步入台重心跟进及时->正手抢攻步法果断；台内寸劲短促制动->手腕爆发力好"),

    ("pendulum_serve", "正手侧旋发球(钟摆式)", "Pendulum Serve", "发球技术", "正手侧上/侧下旋发球", "初学~高阶",
     "单人多球练发球、比赛开局正手发球", "侧身站位，抛球后球拍像钟摆一样由持拍侧后上方向非持拍侧前下方（或斜上方）摆动摩擦的经典发球。",
     "侧身站于反手位或中线，非持拍手垂直上抛球至少16cm；同时转腰向持拍侧后上方引拍；球下落至近网高处时，转腰带动前臂手腕加速向非持拍侧下方切摩（侧下旋）或横擦提拉（侧上旋），配合剁脚或假动作隐蔽。",
     "手腕放松最后一下猛抖摩擦，击球点越贴近台面发出的球越低平。", "serve_spin",
     "抛球垂直高度合规->发球抛球规范；触球点贴近台面过网低平->发球弧线控制佳"),

    ("serve_spin", "正手下旋发球(砍/铲式)", "Backspin Serve", "发球技术", "纯下旋/急长下旋发球", "初学~进阶",
     "基础下旋发球练习、发急长下旋偷袭", "抛球后拍面后仰，在球下落至近台面高度时用前臂手腕快速向球底部前方平切制造强下旋的发球。",
     "侧身站位，垂直抛球；向持拍侧上方引拍，拍面明显后仰；等球下落至接近球网及以下近台面高度时，前臂加速带动手腕向球中下部至底部快速平切摩擦，发短球第一跳在中线附近，发急长球第一跳靠近己方端线。",
     "降低击球点贴着台面平砍球底，别在半空中往下砸球台！", "",
     "下降后期低点触球->击球高度合理不冒高；手腕摩擦干脆->下旋制造充分"),

    ("serve_nospin", "不转发球(含转不转迷惑)", "No-Spin Serve", "发球技术", "假动作迷惑发球", "进阶",
     "转不转发球套路练习", "采用与下旋/侧下旋完全一致的引拍与随挥动作外形，但在触球瞬间用靠近拍柄部位撞击球心减少摩擦的发球。",
     "引拍、抛球与随挥假动作同下旋发球保持一致；区别在于触球瞬间拍面稍立起，用球拍中后部（线速度较小处）轻撞推送球的中部，随即手腕补做切球假动作。",
     "外形演得越像切下旋越好，但碰到球那一毫秒其实是轻轻一撞。", "pendulum_serve",
     "发球前后动作连贯舒展->发球假动作协调性好"),

    ("hook_serve", "勾手发球", "Hook / Shovel Serve", "发球技术", "右侧旋系隐蔽发球", "进阶~高阶",
     "正手勾手发球专项练习", "抛球后手腕内收，触球时前臂与手腕由怀内向外侧（由非持拍侧向持拍侧前方）铲勾摩擦的发球技术。",
     "侧身站位，抛球同时引拍至身体前侧或腰腹旁；触球瞬间手腕由内向外快速展腕铲摩球的侧下部（侧下旋）或侧中部（侧上旋），球拍轨迹呈向外侧勾铲状。",
     "手腕先往怀里收紧，触球瞬间像用铲子往外侧铲出去一样抖腕。", "pendulum_serve",
     "由内向外展腕轨迹清晰->勾手发球摩擦方向明确"),

    ("reverse_pendulum_serve", "正手逆旋转发球", "Reverse Pendulum Serve", "发球技术", "逆侧旋高阶发球", "进阶~高阶",
     "逆旋转发球专项训练", "引拍时手肘外扬、手腕极度内屈蓄力，触球时球拍由非持拍侧向持拍侧外上方逆向甩动摩擦的高阶发球。",
     "侧身站位，抛球后持拍侧手肘明显向外上方抬起架开，手腕向内深度弯曲使拍头指向身体内侧；球下落时以肘为支点，手腕猛烈向外侧甩动摩擦球的外侧面。",
     "架高手肘把拍头掰向怀里，触球时像拧发条释放一样往外侧猛甩拍头。", "hook_serve",
     "引拍架肘内屈手腕充分->逆旋转蓄力结构标准"),
]

# ==================== Sheet 5: 混淆矩阵 ====================
SHEET_CONFUSION_HEADER = ["action_id", "易混动作ID", "核心区分点", "决定性阶段", "低置信度策略"]
SHEET_CONFUSION_ROWS = [
    ("bh_drive", "bh_loop", "看引拍高度与来球性质：引拍在台面以上、来球为平快上旋、小幅迎前撞击为主=bh_drive；引拍沉至台面以下(或明显内收蓄力)、来球为切送下旋、大幅向上摩擦提拉=bh_loop。", "backswing", "output_top2"),
    ("bh_drive", "bh_block", "看引拍有无与来球冲力：有明确向腹前小幅回引再主动发力=bh_drive；对方拉冲球速极快、几乎零引拍在上升前期贴住挡回=bh_block。", "preparation", "lower_confidence"),
    ("bh_loop", "bh_flick", "看站位与击球位置：双脚均在球台端线外、等球出台后从台面下向上拉=bh_loop；持拍侧脚明显跨入球台下方、手肘架高在台内球网附近拧拉短球=bh_flick。", "footwork", "output_top2"),
    ("bh_push", "bh_flick", "看拍面朝向与出球弧线：拍面后仰向下切球底、回球低平带下旋=bh_push；手腕内屈包球侧上部向外弹拧、回球呈上旋拱形弧线=bh_flick。", "contact", "output_top2"),
    ("fh_drive", "fh_loop", "看引拍高低幅度与发力性质：仅向腰侧小幅转腰引拍(拍高于台面)、中等球速连续轻快对攻=fh_drive；大幅转腰沉肩引拍至膝胯高度(尤指拉下旋)或全力蹬转鞭打暴冲=fh_loop。", "backswing", "output_top2"),
    ("fh_drive", "fh_block", "看主动挥拍行程：有规律引拍与收小臂至额前完整行程=fh_drive；面对强弧圈不拉手、固定拍面短促迎前封堵=fh_block。", "swing", "lower_confidence"),
    ("fh_push", "fh_flick", "看触球方向与随挥：拍面后仰向前下方切搓送球=fh_push；亮拍或立拍在台内高点向前上方短促弹击挑打=fh_flick。", "contact", "output_top2"),
    ("pendulum_serve", "serve_spin", "看挥拍轨迹方向：拍头由持拍侧向非持拍侧明显横向摆动切擦球侧面=pendulum_serve；拍面正对球底部由后上直接向前下方直线平砍=serve_spin。", "swing", "lower_confidence"),
    ("pendulum_serve", "reverse_pendulum_serve", "看摩擦挥向（互为镜像）：拍头从身体外侧向怀里(非持拍侧)摆动=pendulum_serve；架肘内屈后拍头从怀里向身体外侧(持拍侧)甩出=reverse_pendulum_serve。", "swing", "output_top2"),
    ("hook_serve", "reverse_pendulum_serve", "看手肘高低与发力形态：手肘自然偏低、手腕像铲子向外平铲=hook_serve；引拍时手肘高高架起、手腕深度内折后向外上方翻甩=reverse_pendulum_serve。", "backswing", "output_top2"),
    ("serve_spin", "serve_nospin", "普通帧率下外形极度相似，重点看接球方反应或触球部位：接球方轻搓下网或触球薄擦底部=serve_spin；接球方轻搓直接冒高出界或拍根撞击球中部=serve_nospin。", "ball_flight", "uncertain"),
]

# ==================== Sheet 6: 降级规则 ====================
SHEET_DEGRADE_HEADER = ["rule_id", "适用范围", "规则类型", "触发条件", "系统动作", "前端提示语"]
SHEET_DEGRADE_ROWS = [
    ("deg_cam_back", "global", "camera_angle", "正后方机位：背部完全遮挡胸前引拍、手腕内屈与触球瞬间拍面", "ask_for_better_video", "当前为正后方视角，身体遮挡了胸前引拍与手腕动作，建议将手机架在持拍侧斜前方或斜后方45°重新拍摄。"),
    ("deg_cam_far", "global", "visibility", "远景监控机位：目标球员在画面中占比过小(高度不足画面1/4)，手肘与球拍姿态模糊", "ask_for_better_video", "拍摄距离过远，无法看清手臂支点与拍面细节，建议走近至球台侧方3~4米处拍摄。"),
    ("deg_half_body", "global", "visibility", "半身入镜：膝盖与双脚在画面外被截断不可见", "lower_confidence", "未拍到膝盖与脚部，本次仅为您诊断上半身挥拍与支点问题；如需分析重心蹬转与步法，请退后半步确保全身入镜。"),
    ("deg_no_table", "global", "table_visibility", "球台与过网球路完全不在画面内（纯空挥或特写）", "lower_confidence", "画面未包含球台与来球轨迹，系统按徒手挥拍模式评估动作框架，暂无法结合来球旋转做时机判断。"),
    ("deg_multi_action", "global", "visibility", "单段视频内包含正反手连续转换组合练习或实战对打回合", "unknown", "检测到当前视频为『组合步法练习或实战对抗』，请上传单项定点技术练习视频，或切换至组合/技战术分析模式。"),
    ("deg_penhold", "global", "visibility", "检测到球员采用直拍握法（如直拍传统推挡或直拍横打）", "lower_confidence", "检测到您采用直拍握法，当前标准库主要针对横拍结构优化，部分手腕与手肘提示仅供框架参考。"),
    ("deg_serve_fps", "serve_nospin", "frame_rate", "30fps常规视频且画面中无接发球方回球反馈，无法区分真假摩擦", "lower_confidence", "单人发球普通帧率视频难以精准区分『纯下旋』与『不转发球』的毫秒级触球差异，建议开启手机慢动作(120fps)拍摄。"),
    ("deg_spin_feed", "bh_loop", "ball_visibility", "未拍到喂球方手法、无音频口令且引拍高度处于台面临界区，难定上下旋", "lower_confidence", "未拍到来球喂球画面，系统已自动按通用反手拉球标准为您分析发力支点与制动问题。"),
]

# ==================== Sheet 4: 识别线索 (Part 2/3) ====================
SHEET_CUES_HEADER = [
    "action_id", "线索类型", "线索通道", "动作阶段", "可观察线索描述", "权重", "缺失时处理"
]

SHEET_CUES_ROWS = [
    # --- 1. bh_drive 反手拨球/攻球 ---
    ("bh_drive", "positive", "player_motion", "backswing", "双脚站于端线外反手区，引拍置于胸腹前且球拍高度平齐或高于球台面，引拍幅度紧凑", 3, "lower_confidence"),
    ("bh_drive", "positive", "player_motion", "swing", "在来球上升期向持拍侧前上方做小幅短促迎前挥动，以撞击借力为主，随挥行程较短", 3, "lower_confidence"),
    ("bh_drive", "positive", "ball_and_feed", "ball_flight", "来球多为平快上旋球（教练平推喂球或双方连续对拨），过网弧线平直、往返节奏轻快", 2, "keep_evaluating"),
    ("bh_drive", "positive", "audio_cue", "contact", "击球声呈清脆规律的连续撞击声，或伴随『拨、迎前、快点』等口令", 1, "keep_evaluating"),
    ("bh_drive", "negative", "player_motion", "backswing", "球拍大幅下沉至球台面以下两腿间蓄力，并做大幅向上提拉摩擦（应归入 bh_loop）", 3, "output_top2"),

    # --- 2. bh_loop 反手拉弧圈球 ---
    ("bh_loop", "positive", "player_motion", "backswing", "站于端线外明显向腹前内收引拍蓄力；拉下旋时球拍明显沉至台面以下两腿间，拉上旋相持时平齐台面但有充分内屈蓄力弧线", 3, "lower_confidence"),
    ("bh_loop", "positive", "player_motion", "swing", "触球至随挥呈明显向持拍侧前上方的大幅加速挥拍摩擦轨迹，出球呈饱满上旋拱形弧线过网急坠", 3, "lower_confidence"),
    ("bh_loop", "positive", "ball_and_feed", "ball_flight", "多球喂球方呈向下切送/削送手势（来球弧线低缓带下旋），或搓球出台后起板拉球", 2, "keep_evaluating"),
    ("bh_loop", "positive", "audio_cue", "contact", "触球声偏厚重摩擦声，常伴随教练『拉、下来一点、加速、摩擦』等口令", 2, "keep_evaluating"),
    ("bh_loop", "positive", "player_motion", "preparation", "双膝明显弯曲压低重心，击球过程伴随重心由低向高起伏（仅作加分项，初学者即使腿蹲死不蹬转也不排除 bh_loop）", 1, "keep_evaluating"),
    ("bh_loop", "negative", "player_motion", "footwork", "持拍侧脚大幅跨入球台底面以下，并在近网台内上方空间出手（应归入台内拧拉 bh_flick）", 3, "output_top2"),

    # --- 3. bh_block 反手防弧圈 ---
    ("bh_block", "positive", "player_motion", "backswing", "面对高速冲球几乎无向后引拍动作，球拍直接置于胸腹前迎球，拍面明显前倾下压", 3, "lower_confidence"),
    ("bh_block", "positive", "ball_and_feed", "ball_flight", "对方来球为大幅挥拍拉冲过来的高质量强上旋弧圈球，球速极快、前冲力强", 3, "lower_confidence"),
    ("bh_block", "positive", "player_motion", "contact", "在来球刚弹起的上升前期即触球，前臂仅做数厘米极短促的迎前借力贴防或快带", 2, "keep_evaluating"),
    ("bh_block", "negative", "player_motion", "swing", "来球速度温和且本方有充分沉拍蓄力再主动发力大幅挥拍（应归入 bh_drive 或 bh_loop）", 3, "output_top2"),

    # --- 4. bh_push 反手搓球与摆短 ---
    ("bh_push", "positive", "player_motion", "contact", "身体靠近反手近台，拍面明显后仰亮拍，在球中下部向底部做向前下方的切摩或轻托减力", 3, "lower_confidence"),
    ("bh_push", "positive", "ball_and_feed", "ball_flight", "来球与回球均为低平缓慢的下旋轨迹，无上旋拱形下扎弧线，落台后不往前猛冲", 3, "lower_confidence"),
    ("bh_push", "positive", "player_motion", "follow_through", "慢搓/劈长时前臂向持拍侧前下方切送；摆短时在上升前期触球后手腕即刻停顿减力且回球不出台", 2, "keep_evaluating"),
    ("bh_push", "negative", "player_motion", "contact", "手腕深度内屈包住球侧上部向外弹抖制造上旋拱形弧线（应归入 bh_flick）", 3, "output_top2"),

    # --- 5. bh_flick 反手拧拉 ---
    ("bh_flick", "positive", "player_motion", "footwork", "持拍侧脚明显跨入球台端线以里（台内支撑），上身大幅前探深入近网台内区域找短球", 3, "lower_confidence"),
    ("bh_flick", "positive", "player_motion", "backswing", "持拍侧手肘向侧上方明显架高撑开，手腕向怀里极度内屈蓄力，拍头指向身体内侧", 3, "lower_confidence"),
    ("bh_flick", "positive", "player_motion", "contact", "在球台上方台内空间手腕瞬间向外侧弹抖摩擦球侧上部，回球呈带侧拐的上旋弧线", 3, "lower_confidence"),
    ("bh_flick", "negative", "player_motion", "footwork", "双脚始终站在端线外等球出台下降至台面下再向上拉球（应归入 bh_loop）", 3, "output_top2"),

    # --- 6. fh_drive 正手攻球 ---
    ("fh_drive", "positive", "player_motion", "backswing", "站于正手近台，向持拍侧腰肋旁做小幅引拍（球拍高于或平齐台面，大小臂夹角约90°~110°，不向身后大幅拉手）", 3, "lower_confidence"),
    ("fh_drive", "positive", "player_motion", "swing", "向非持拍侧前上方收前臂迎前撞击为主，挥拍行程适中紧凑，随挥停在额前/眉心附近并连贯还原", 3, "lower_confidence"),
    ("fh_drive", "positive", "ball_and_feed", "ball_flight", "来球为中等速度上旋球（定点平送或斜线连续对攻），出球路线平快干脆", 2, "keep_evaluating"),
    ("fh_drive", "positive", "audio_cue", "contact", "清脆有节奏的撞击声，常伴随『收小臂、迎前、正手攻』等口令", 1, "keep_evaluating"),
    ("fh_drive", "negative", "player_motion", "backswing", "大幅沉肩将球拍拉至持拍侧膝胯高度（台面以下）再向上提拉摩擦（应归入 fh_loop）", 3, "output_top2"),

    # --- 7. fh_loop 正手拉弧圈球 ---
    ("fh_loop", "positive", "player_motion", "backswing", "持拍侧肩膀下沉并向后大幅引拍蓄力；拉下旋时手臂舒展沉拍至台面以下膝胯旁，拉上旋前冲时引拍幅度明显大于正手攻球", 3, "lower_confidence"),
    ("fh_loop", "positive", "player_motion", "swing", "触球至随挥爆发力强、挥拍行程长，球拍高速挥向非持拍侧额前上方或头顶侧方，出球上旋强烈", 3, "lower_confidence"),
    ("fh_loop", "positive", "ball_and_feed", "ball_flight", "喂球方切送下旋球、搓球出台起板，或中近台大力量弧圈相持对拉", 2, "keep_evaluating"),
    ("fh_loop", "positive", "audio_cue", "contact", "强烈摩擦声或暴冲脆响，常伴随『拉、摩擦、往上提、转腰、冲』等口令", 2, "keep_evaluating"),
    ("fh_loop", "positive", "player_motion", "swing", "伴随持拍侧脚蹬地与腰髋转动传导（仅作加分项，初学者纯抡手臂拉球亦不排除 fh_loop）", 1, "keep_evaluating"),
    ("fh_loop", "negative", "player_motion", "footwork", "持拍侧脚跨入正手台内并在球网上方台内空间短促弹击短球（应归入 fh_flick）", 3, "output_top2"),

    # --- 8. fh_block 正手快带与封堵 ---
    ("fh_block", "positive", "player_motion", "backswing", "面对正手位强上旋冲球，无向后拉手动作，球拍直接置于身体持拍侧前方台面之上，拍面微前倾", 3, "lower_confidence"),
    ("fh_block", "positive", "ball_and_feed", "ball_flight", "对方来球为大力拉冲过来的高速强上旋弧圈球", 3, "lower_confidence"),
    ("fh_block", "positive", "player_motion", "swing", "在来球上升期做极小幅度的迎前借力快带或贴防封堵，动作短促紧凑", 2, "keep_evaluating"),
    ("fh_block", "negative", "player_motion", "backswing", "有完整向腰后引拍再主动发力收小臂连续等速对攻（应归入 fh_drive）", 3, "output_top2"),

    # --- 9. fh_push 正手搓球与摆短 ---
    ("fh_push", "positive", "player_motion", "footwork", "持拍侧脚向正手台内迈步支撑（或上身探入正手近台），靠近球台处理来球", 3, "lower_confidence"),
    ("fh_push", "positive", "player_motion", "contact", "正手握拍拍面明显后仰，在球中下部向前下方切搓送球，或上升前期轻托底部减力摆短", 3, "lower_confidence"),
    ("fh_push", "positive", "ball_and_feed", "ball_flight", "来球与回球均为低缓下旋球，落台后无上旋前冲感", 2, "keep_evaluating"),
    ("fh_push", "negative", "player_motion", "contact", "拍面立起在正手台内高点向前上方突发弹击进攻（应归入 fh_flick）", 3, "output_top2"),

    # --- 10. fh_flick 正手挑打 ---
    ("fh_flick", "positive", "player_motion", "footwork", "持拍侧脚大步跨入正手球台下方，重心前压深入正手台内近网区域", 3, "lower_confidence"),
    ("fh_flick", "positive", "player_motion", "contact", "手臂伸入台内，在来球高点期利用前臂与手腕向前上方做短促有力的突发弹击或暴挑，手腕迅速制动防撞台", 3, "lower_confidence"),
    ("fh_flick", "positive", "ball_and_feed", "ball_flight", "来球为不出台的正手短球，回球球速快、呈进攻性直线或斜线奔向对方底线", 2, "keep_evaluating"),
    ("fh_flick", "negative", "player_motion", "contact", "拍面后仰向下慢切球底部且回球缓慢低平（应归入 fh_push）", 3, "output_top2"),

    # --- 11. pendulum_serve 正手侧旋发球(钟摆式) ---
    ("pendulum_serve", "positive", "player_motion", "preparation", "端线外单人持球发球（多为侧身站位），非持拍手掌心向上抛球，球第一跳落在本方球台", 3, "lower_confidence"),
    ("pendulum_serve", "positive", "player_motion", "swing", "球拍由持拍侧外上方向非持拍侧内下方（或内上方）做明显的钟摆状横向摆动切擦球侧面", 3, "lower_confidence"),
    ("pendulum_serve", "positive", "ball_and_feed", "ball_flight", "球过网后飞行轨迹或落台弹跳带有向一侧偏拐的侧旋特征", 2, "keep_evaluating"),
    ("pendulum_serve", "negative", "player_motion", "swing", "拍头由身体怀里向身体外侧（由非持拍侧向持拍侧）逆向甩出或铲出（应归入 hook_serve 或 reverse_pendulum_serve）", 3, "output_top2"),

    # --- 12. serve_spin 正手下旋发球 ---
    ("serve_spin", "positive", "player_motion", "preparation", "端线外单人抛球发球，第一跳落在本方球台再过网", 3, "lower_confidence"),
    ("serve_spin", "positive", "player_motion", "contact", "拍面明显后仰，由后上方向前下方直线平砍或切擦球的中下部至底部（无大幅左右钟摆横甩）", 3, "lower_confidence"),
    ("serve_spin", "positive", "ball_and_feed", "ball_flight", "球过网弧线低平、前冲衰减快；若画面含接球方，多以搓球回接或吃下旋下网", 2, "keep_evaluating"),
    ("serve_spin", "negative", "player_motion", "swing", "存在明显由外向内或由内向外的横向侧摆摩擦轨迹（应归入侧旋系发球）", 3, "output_top2"),

    # --- 13. serve_nospin 不转发球 ---
    ("serve_nospin", "positive", "player_motion", "preparation", "端线外抛球发球，引拍与随挥假动作外形与下旋或侧下旋发球高度相似", 3, "lower_confidence"),
    ("serve_nospin", "positive", "ball_and_feed", "ball_flight", "画面中接发球方按常规下旋摆短/搓球时，球触拍后直接冒高或往天上飞出界（最强逆向判别证据）", 3, "lower_confidence"),
    ("serve_nospin", "positive", "player_motion", "contact", "高帧率画面下可见触球瞬间拍面稍立起，用靠近拍柄的中后部轻撞球心而非薄擦球底", 2, "lower_confidence"),
    ("serve_nospin", "negative", "ball_and_feed", "ball_flight", "球落对方台面明显回跳急停或接球方轻碰即下网（实为真下旋 serve_spin）", 3, "output_top2"),

    # --- 14. hook_serve 勾手发球 ---
    ("hook_serve", "positive", "player_motion", "preparation", "侧身站位抛球发球，引拍置于身前腰腹旁，持拍侧手肘自然偏低（不向头肩高处大幅架肘）", 3, "lower_confidence"),
    ("hook_serve", "positive", "player_motion", "swing", "触球瞬间手腕由怀内向身体外侧前方（由非持拍侧向持拍侧）做铲子状快速外展勾擦", 3, "lower_confidence"),
    ("hook_serve", "positive", "player_motion", "follow_through", "触球后球拍顺势向持拍侧外前方扬起或制动收住", 2, "keep_evaluating"),
    ("hook_serve", "negative", "player_motion", "swing", "拍头从身体外侧向怀里摆动摩擦（应归入 pendulum_serve）", 3, "output_top2"),

    # --- 15. reverse_pendulum_serve 正手逆旋转发球 ---
    ("reverse_pendulum_serve", "positive", "player_motion", "backswing", "抛球引拍时持拍侧手肘明显向外上方高高架起，手腕向内极度弯曲蓄力，拍头指向怀里", 3, "lower_confidence"),
    ("reverse_pendulum_serve", "positive", "player_motion", "swing", "触球瞬间以高架的手肘为支点，手腕猛烈向持拍侧外上方翻转甩出摩擦球外侧面", 3, "lower_confidence"),
    ("reverse_pendulum_serve", "positive", "ball_and_feed", "ball_flight", "第一跳落本方台面过网后带有强烈逆侧旋侧拐弹跳", 2, "keep_evaluating"),
    ("reverse_pendulum_serve", "negative", "player_motion", "backswing", "引拍时手肘贴近腰肋自然下垂、呈低位平铲状发力（更接近 hook_serve）", 3, "output_top2"),
]


# ==================== Sheet 7: 诊断规则 (Part 3/3) ====================
SHEET_DIAG_HEADER = [
    "action_id", "问题ID", "动作阶段", "同源归并组", "机位可见度要求",
    "视觉证据(VLM核验项)", "技术问题定性", "针对性训练建议", "修改优先级"
]

SHEET_DIAG_ROWS = [
    # --- 1. bh_drive 反手拨球/攻球 (5条) ---
    ("bh_drive", "bh_drive_elbow_lift", "swing", "arm_fulcrum", "upper_body",
     "挥拍过程中持拍侧手肘明显向外或向上抬起架开，大臂随球大幅晃动", "肘支点不稳（架大臂），导致拨球散乱不稳",
     "将手肘自然垂于身前偏持拍侧做相对固定支点，可在腋下虚夹球拍套体会只动前臂不动大臂。", 1),
    ("bh_drive", "bh_drive_overswing", "follow_through", "swing_brake", "upper_body",
     "击球后手臂向持拍侧外方大幅甩开伸直，未停在胸前三角区", "随挥过大缺乏制动，连续相持还原慢",
     "建立胸前三角区概念，挥拍至右胸/左胸斜前方即突然制动刹车，打完立即回腹前准备下一板。", 1),
    ("bh_drive", "bh_drive_wrist_wobble", "contact", "racket_angle", "upper_body",
     "引拍与触球时手腕过度乱甩翻动，导致回球忽高忽低或频繁下网出界", "手腕过于松散晃动，拍形失控",
     "初学反手拨球先适当绷紧固定手腕，以小臂迎前发力为主，待落点稳定后再加入微弱手腕寸劲。", 1),
    ("bh_drive", "bh_drive_late_point", "contact", "timing_point", "table_and_ball",
     "等球弹起很高甚至落至下降期才被动出手，球拍被来球顶在腹部贴身处", "击球时机偏晚（等球被顶），失去借力优势",
     "紧盯球落本方球台瞬间，在上升期主动迎前触球，保持击球点与腹部有一前臂的距离。", 2),
    ("bh_drive", "bh_drive_high_stance", "preparation", "core_legs", "full_body",
     "双腿完全站直锁死，上身直立后仰着伸手拨球", "重心过高直立，下盘不稳难调整",
     "双脚开立略宽于肩，双膝微屈、前脚掌着地，收腹含胸保持重心微前倾。", 2),

    # --- 2. bh_loop 反手拉弧圈球 (6条 - 完整覆盖实测视频痛点) ---
    ("bh_loop", "bh_loop_overswing", "follow_through", "swing_brake", "upper_body",
     "触球后大臂带着前臂大幅向持拍侧外上方甩开，整条手臂几乎完全伸直甩出体外", "挥拍半径过大、缺乏制动（甩手），力量发散且还原极慢",
     "挥拍至持拍侧眼睛或前额斜前方必须突然『急刹车』制动，把加速爆发力集中在触球瞬间，体会甩毛巾急停感。", 1),
    ("bh_loop", "bh_loop_elbow_lift", "swing", "arm_fulcrum", "upper_body",
     "向上发力时持拍侧手肘明显向侧上方抬起漂移，变成大臂整体往上抡球", "肘关节支点漂移、大臂代偿过多，失去前臂鞭打速度",
     "引拍撑起肘尖后稳住手肘位置做旋转轴心，靠前臂快速绕肘挥动配合手腕外展摩擦，切忌抬肘抡大臂。", 1),
    ("bh_loop", "bh_loop_high_backswing", "backswing", "racket_angle", "upper_body",
     "面对下旋球时引拍高度仍停留在台面以上，手腕僵直未内屈，直接平撞下网", "引拍下沉不足且手腕未内收，无法克服下旋",
     "拉下旋前先沉重心，将球拍引至台面以下两腿间腹前，手腕放松向内弯曲蓄力，再向前上方摩擦球中上部。", 1),
    ("bh_loop", "bh_loop_static_legs", "swing", "core_legs", "full_body",
     "双腿呈静态蹲马步状无起伏，或发力瞬间靠仰头挺胸后仰往上带球而非下肢蹬顶", "上下肢脱节（静态蹲死/仰头挺胸代偿），缺乏蹬地顶胯传导",
     "引拍时微收腹含胸蓄力，触球瞬间前脚掌蹬地、膝胯微向前上方顶出寸劲，下巴微收盯球，用重心带着手走。", 2),
    ("bh_loop", "bh_loop_free_hand", "swing", "balance_hand", "upper_body",
     "每次发力挥拍时，非持拍手不自觉向身体外侧张开上下乱晃", "非持拍手失控外展，导致核心松散、破坏身体平衡",
     "非持拍手自然半握拳收稳于同侧胸肋前方，全程保持核心紧绷，绝不往身体外侧乱甩。", 2),
    ("bh_loop", "bh_loop_high_arc", "contact", "racket_angle", "table_and_ball",
     "挥拍轨迹几乎垂直向上撩，拍面过度后仰，回球弧线极高且过网无前冲力", "发力过度向上、迎前不足，回球冒高易挨打",
     "触球瞬间拍面适度前倾包住球中上部，在向上摩擦抓球的同时增加向前迎前挥动的分量。", 2),

    # --- 3. bh_block 反手防弧圈 (4条) ---
    ("bh_block", "bh_block_backswing_big", "backswing", "swing_brake", "upper_body",
     "面对高速冲球仍习惯性向腹后大幅拉手引拍，导致来不及出手被球顶死或漏球", "防守引拍过大，错失上升前期封堵时机",
     "防弧圈严禁向后拉手！球拍直接架在胸前迎球，借对方来球冲力轻轻贴住往前一顶即可。", 1),
    ("bh_block", "bh_block_open_angle", "contact", "racket_angle", "table_and_ball",
     "触球瞬间拍面后仰或手腕被冲翻后折，球直接高飞出界", "拍面未压住或手腕松软，吃强上旋飞出界",
     "触球瞬间手指手腕绷紧固定，拍面适度前倾盖住球的中上部，迎前按住弧线。", 1),
    ("bh_block", "bh_block_lean_back", "contact", "core_legs", "full_body",
     "接冲球时上身畏缩后仰、重心坐到脚后跟上，边退边挡", "重心后坐畏球，导致防球飘高出界",
     "越是对方冲得凶，重心越要含胸微前倾压住，前脚掌撑地顶住来球冲力。", 2),
    ("bh_block", "bh_block_late_drop", "contact", "timing_point", "table_and_ball",
     "退到端线后等球弹至最高点或下降期才去挡，频繁下网或出界", "未抢上升前期，旋转充分释放后更难控",
     "站位贴近球台，在球落台刚弹起的上升前期（旋转最弱瞬间）果断迎前封堵。", 2),

    # --- 4. bh_push 反手搓球与摆短 (5条) ---
    ("bh_push", "bh_push_stand_far", "footwork", "footwork_pos", "full_body",
     "双脚钉在端线外原地不动，弯腰伸直长胳膊去够台内球，重心悬空", "上步不到位（伸手够球），手感失控易冒高",
     "先动脚后动手！持拍侧脚主动跨步上前让身体贴近来球，击球点保持在胸腹前舒适区，搓完立即撤步还原。", 1),
    ("bh_push", "bh_push_pop_high", "contact", "racket_angle", "table_and_ball",
     "拍面过度平仰向上托球，且在球高点期发力过猛，回球弹起老高", "拍形过仰或发力过死，导致搓球冒高",
     "摆短抢上升前期手指轻触即停减力；慢搓则保持适当后仰切球中下部，前臂柔和向前下方送出而非往上托。", 1),
    ("bh_push", "bh_push_stiff_chop", "swing", "arm_fulcrum", "upper_body",
     "大臂夹死或抡大臂生硬往下猛劈撞击，缺乏手腕前臂柔和切摩，频繁下网", "大臂生硬劈撞、缺乏柔和摩擦",
     "放松肩膀，以前臂带动手腕手指在触球瞬间做细腻切削摩擦，体会『擦球皮』而非『砍球心』。", 2),
    ("bh_push", "bh_push_long_drop", "follow_through", "swing_brake", "table_and_ball",
     "意图摆短但触球后前臂继续向前长送，导致回球全部出台变成半出台肉球", "摆短缺乏制动减力，控短变半出台",
     "摆短触球瞬间像手碰到烫水一样立刻制动停住（甚至微回撤泄力），切忌往前送大臂。", 2),
    ("bh_push", "bh_push_no_recovery", "recovery", "footwork_pos", "full_body",
     "上步搓完球后脚停在台下发呆，重心趴在球台上未撤回", "搓后不还原，无法衔接下一板防守或拉球",
     "养成『上步搓球—前脚蹬地撤回端线外』的一体化连贯步法习惯。", 3),

    # --- 5. bh_flick 反手拧拉 (5条) ---
    ("bh_flick", "bh_flick_no_step", "footwork", "footwork_pos", "full_body",
     "持拍侧脚未跨入台内，站在台外探身伸长手臂去拧台内短球", "未上步入台，重心脱节发不出手腕寸劲",
     "反手拧拉第一步必须是持拍侧脚大胆跨入球台下方支撑，让胸口贴近球台再去架肘找球。", 1),
    ("bh_flick", "bh_flick_low_elbow", "backswing", "arm_fulcrum", "upper_body",
     "引拍时手肘下垂夹在腰间未架起，导致手腕无法内屈、球拍易磕碰台面", "手肘未架高撑开，丧失台内挥拍空间",
     "入台同时将持拍侧手肘向侧前方抬高撑起，给手腕留出充分的内屈与外展摩擦空间。", 1),
    ("bh_flick", "bh_flick_no_wrist_curl", "backswing", "racket_angle", "upper_body",
     "手腕僵直未向怀里内屈，靠小臂平推出去硬撞来球导致下网", "手腕内屈蓄力不足，摩擦过少下网",
     "引拍时充分弯曲手腕让拍头指向怀里，在球高点期像弹弹簧一样快速外展摩擦球侧上部。", 1),
    ("bh_flick", "bh_flick_drop_late", "contact", "timing_point", "table_and_ball",
     "等台内短球落到比球网还低的下降后期才出手，只能往上硬捞出高球", "错失高点期，低点硬拧质量极差",
     "盯紧球在台内的最高点果断出手，利用球网高度优势直接向前侧上方暴拧。", 2),
    ("bh_flick", "bh_flick_stuck_inside", "recovery", "footwork_pos", "full_body",
     "拧拉完成后右脚/左脚滞留在台内，上身趴台来不及退回相持位", "拧后撤步还原慢，易被对方防回头打死",
     "触球制动瞬间，跨入台内的支撑脚立即用力向后蹬地撤回端线外准备衔接反手相持。", 2),

    # --- 6. fh_drive 正手攻球 (5条) ---
    ("fh_drive", "fh_drive_big_backswing", "backswing", "swing_brake", "upper_body",
     "引拍时大臂向身后大幅拉扯，球拍甩到后背方向，大小臂完全伸直", "引拍过大拉后手，导致还原慢、击球点滞后",
     "正手攻球只靠微转腰把拍引到身体持拍侧腰旁即可（大小臂夹角保持约100度），在肋骨旁放个标志物限制拉手。", 1),
    ("fh_drive", "fh_drive_elbow_clamp", "swing", "arm_fulcrum", "upper_body",
     "大臂死死夹紧贴在肋骨上，或翻手腕像苍蝇拍一样乱拍，动作拘谨变形", "夹大臂或翻手腕代偿，动作僵硬不舒展",
     "腋下保持约一拳距离自然舒展，手腕相对固定微后展，靠转腰带动前臂向眉心前收小臂。", 1),
    ("fh_drive", "fh_drive_arm_only", "swing", "core_legs", "full_body",
     "腰胯正对球台一动不动，纯靠抡胳膊左右摆动打球", "光动手不转腰，缺乏身体协调发力",
     "体会『腰带手走』：引拍时腰向持拍侧微转约30度，击球时蹬地转腰把手臂自然带到身前。", 1),
    ("fh_drive", "fh_drive_behind_body", "contact", "timing_point", "upper_body",
     "等球飞到身体侧面甚至身后才仓促拐着胳膊击球", "击球点落后于身体（被球顶住）",
     "务必坚持在身体持拍侧斜前方（眼睛余光能同时看到球和球拍的位置）迎前击球。", 2),
    ("fh_drive", "fh_drive_cross_head", "follow_through", "swing_brake", "upper_body",
     "收拍挥过头顶甩到非持拍侧肩膀后方，整个身体拧成麻花", "随挥越界缺乏制动，破坏连续攻球节奏",
     "挥拍至额前或眉心正前方即停住制动（像敬礼位置），随即顺势落手转腰还原。", 2),

    # --- 7. fh_loop 正手拉弧圈球 (6条) ---
    ("fh_loop", "fh_loop_arm_only", "swing", "core_legs", "full_body",
     "双脚与腰髋几乎不转动，仅靠肩膀和大臂生硬往上抡球", "纯用手臂抡球、无蹬转传导，发力散且易伤肩",
     "建立『蹬地—转髋—转腰—带动大臂—快收前臂』动力链：引拍压住持拍侧腿，击球瞬间脚蹬地把胯转出去。", 1),
    ("fh_loop", "fh_loop_lean_back", "swing", "core_legs", "full_body",
     "拉下旋发力时上身明显向后仰倒，重心落到后脚跟，边往后退边往上捞球", "重心后仰拔高（仰着拉），力量抵消易出界或下网",
     "越是拉下旋越要『先沉后迎前』！蹬腿转腰时重心必须从持拍侧脚转移压向非持拍侧前脚掌，身体迎前包住球。", 1),
    ("fh_loop", "fh_loop_high_backswing", "backswing", "racket_angle", "upper_body",
     "面对下旋来球引拍高度仍高于台面，挥拍平直向前硬撞导致直接下网", "拉下旋沉拍蓄力不足，撞击过多未制造弧线",
     "拉下旋引拍时持拍侧肩膀自然下沉、微屈持拍侧膝盖，将球拍引至台面以下膝胯高度，再向斜前上方提拉摩擦。", 1),
    ("fh_loop", "fh_loop_stiff_forearm", "contact", "arm_fulcrum", "upper_body",
     "整条手臂僵直成一根棍子抡过去，触球瞬间无前臂快速收缩鞭打加速", "大小臂僵直抡大臂，缺少触球瞬间收前臂加速",
     "引拍时前臂自然舒展打开，在球即将触拍的一刹那快速加速收缩前臂，打出『鞭打寸劲』。", 2),
    ("fh_loop", "fh_loop_free_hand", "swing", "balance_hand", "upper_body",
     "非持拍手垂在裤缝旁一动不动或向后乱甩，未能配合引拍与转腰", "非持拍手未参与协调，转腰半途卡壳",
     "引拍时非持拍手自然抬起指向来球方向辅助合腰；挥拍转腰时非持拍手同步向左侧肋旁收拉制动，带动转腰加速。", 2),
    ("fh_loop", "fh_loop_overswing", "follow_through", "swing_brake", "upper_body",
     "随挥一直甩到非持拍侧背后腰部，身体重心大幅失衡偏倒", "随挥失控制动过晚，下一板无法连续还原",
     "正手拉球挥至非持拍侧额前斜上方（约耳朵上方）即突然制动锁住核心，借反弹惯性迅速落拍还原。", 2),

    # --- 8. fh_block 正手快带与封堵 (4条) ---
    ("fh_block", "fh_block_backswing", "backswing", "swing_brake", "upper_body",
     "面对强弧圈冲球仍向身后拉手引拍，导致触球晚飞出界或漏球", "快带拉后手，来不及迎前合住冲力",
     "正手快带绝不向后拉手！球拍直接放在身前迎球，微转腰合住来球顺势往前轻带。", 1),
    ("fh_block", "fh_block_soft_wrist", "contact", "racket_angle", "upper_body",
     "触球瞬间手腕向后松软晃动，球直接飞向天花板或出底线", "手腕松软被强上旋冲翻拍形",
     "触球瞬间手腕与手指保持固定紧绷，拍面微前倾盖住球中上部。", 1),
    ("fh_block", "fh_block_reach_arm", "footwork", "footwork_pos", "full_body",
     "脚下不动纯伸直手臂去够正手大角来球，身体重心歪斜", "步法未微调迎球，手臂脱离身体核心控制",
     "用极小幅垫步或单步微调位置，保持用腰胯迎着球面挡回。", 2),
    ("fh_block", "fh_block_late", "contact", "timing_point", "table_and_ball",
     "等球跳到最高点以后才被动去碰，吃强烈上旋控制不住弧线", "击球期偏晚，吃转严重",
     "盯准球落台刚弹起的上升期果断迎前快带，借力打力。", 2),

    # --- 9. fh_push 正手搓球与摆短 (4条) ---
    ("fh_push", "fh_push_no_step", "footwork", "footwork_pos", "full_body",
     "双脚留在端线外不迈步，撅着屁股伸直长胳膊去够正手短球", "正手未上步入台，重心悬空导致搓球冒高或下网",
     "处理正手近网球必须持拍侧脚大步跨入台内（脚跟先着地过渡前脚掌稳住），让身体贴近球再出手。", 1),
    ("fh_push", "fh_push_scoop_high", "contact", "racket_angle", "table_and_ball",
     "拍面平摊向上兜托球底，回球过网弧线高大易被对方直接扣杀", "拍面过仰兜球，回球严重冒高",
     "保持适度后仰切摩球中下部，摆短抢上升前期轻触即停，劈长则干脆向前下方切送压低弧线。", 1),
    ("fh_push", "fh_push_wrist_slap", "contact", "arm_fulcrum", "upper_body",
     "触球时手腕生硬往下乱拍撞击，缺乏手指手腕细腻减力或摩擦", "手腕生硬拍打，控球粗糙失误多",
     "正手摆短多体会手指轻捏拍肩、手腕柔和托抹卸力的感觉，避免大臂生硬往下砸。", 2),
    ("fh_push", "fh_push_slow_retreat", "recovery", "footwork_pos", "full_body",
     "正手上步搓球后持拍侧脚停在台内回不来，被对方劈长顶死底线", "上步后蹬回还原太慢",
     "触球结束瞬间，台内支撑脚立即向后蹬地撤回基本准备站位，做到『快上快回』。", 2),

    # --- 10. fh_flick 正手挑打 (4条) ---
    ("fh_flick", "fh_flick_no_step", "footwork", "footwork_pos", "full_body",
     "脚未跨入正手台内，在端线外伸长手臂勉强够着挑打", "步法未入台，手臂伸直发不出寸劲",
     "持拍侧脚果断跨入正手台内支撑重心，大小臂保持弯曲弹性空间再出手挑打。", 1),
    ("fh_flick", "fh_flick_big_swing", "swing", "swing_brake", "upper_body",
     "在台内拉大臂大幅挥拍且无制动，球拍易砸球台或回球狂飞出界", "台内动作过大无制动，失去挑打短促爆发力",
     "台内挑打全靠前臂带动手腕的短促寸劲！引拍只需手腕微后展，击球高点瞬间前弹即刻急停制动。", 1),
    ("fh_flick", "fh_flick_flat_net", "contact", "racket_angle", "table_and_ball",
     "面对台内下旋短球拍面压得过死直接平推，导致球直接撞网", "挑下旋短球拍面过压，未制造过网弧线",
     "挑打下旋短球时先微亮拍面从球中下部向上向前托挑（或手腕摩擦暴挑），过网瞬间再微压拍面。", 2),
    ("fh_flick", "fh_flick_miss_peak", "contact", "timing_point", "table_and_ball",
     "犹豫过久等短球下落到球网高度以下才出手，挑打下网率极高", "错过台内高点期，低点强挑失误",
     "预判不出台短球立刻抢先上步，务必在球弹起最高点果断出手。", 2),

    # --- 11. pendulum_serve 正手侧旋发球(钟摆式) (5条) ---
    ("pendulum_serve", "pend_serve_low_toss", "preparation", "serve_mechanics", "upper_body",
     "非持拍手抛球高度极低（刚离开手掌几厘米）或明显向身体内侧斜抛合力", "抛球过低或斜抛违规，且缺乏下降重力势能",
     "手掌摊平在台面以上端线外，垂直向上抛球至少16cm（约球网高度以上），养成合规发球习惯。", 1),
    ("pendulum_serve", "pend_serve_high_contact", "contact", "serve_mechanics", "table_and_ball",
     "球还在胸口高处就急着挥拍向下砸向球台，导致发球过网弧线极高", "触球点过高向下砸台，发球严重冒高",
     "耐心等球下落至接近球网高度附近的低点再加速横切摩擦，击球点越低发球过网越低平。", 1),
    ("pendulum_serve", "pend_serve_stiff_wrist", "contact", "racket_angle", "upper_body",
     "发球时手腕僵死不动，纯靠大臂摆动平推撞击球，发出的球毫无旋转", "手腕僵硬无抖动摩擦，发球不转无威胁",
     "引拍手腕放松外展，触球一瞬间手腕像甩鞭梢一样加速向内侧抖动薄擦球的侧面。", 1),
    ("pendulum_serve", "pend_serve_far_body", "contact", "serve_mechanics", "upper_body",
     "触球点远离身体伸直胳膊去够球，腰腹力量完全借不上", "触球点离身体太远，发力脱节不隐蔽",
     "抛球靠近身体前侧，在右腰/左腰近身处依靠转腰合力带动手腕集中摩擦。", 2),

    # --- 12. serve_spin 正手下旋发球 (4条 - 已修正原表第26行物理错误) ---
    ("serve_spin", "serve_spin_high", "contact", "serve_mechanics", "table_and_ball",
     "抛球后未等球下落至近台面高度，在胸腹高处过早出手向下猛砸球台，导致反弹极高过网冒高", "击球点过高且向下砸台过重，垂直反弹大导致冒高",
     "等球下落至接近球网及以下近台面高度再出手，变『高处往下砸』为『贴近台面平切球底部』；发短球第一跳控在本方中线附近配合减力，发急长球第一跳靠近本方端线。", 1),
    ("serve_spin", "serve_spin_thick_hit", "contact", "racket_angle", "upper_body",
     "触球时拍面立起撞击球后中部而非薄擦底部，球速虽快但无下旋", "撞击过厚摩擦不足，下旋不转",
     "拍面充分后仰接近水平，手腕放松在触球瞬间快速向前下方薄削球的底部皮层。", 1),
    ("serve_spin", "serve_spin_decelerate", "swing", "serve_mechanics", "upper_body",
     "引拍很大但快碰到球时前臂手腕明显减速犹豫，轻轻碰球过网", "触球瞬间减速（不敢摩擦），旋转极弱",
     "区分『用力薄擦』与『撞击出界』：越怕出界越要敢于加速薄擦球底，摩擦越薄球越往前走得短且转。", 2),
    ("serve_spin", "serve_spin_no_recovery", "recovery", "footwork_pos", "full_body",
     "发完球后侧身站在原地看着球飞过去，未迅速转正还原准备第三板抢攻", "发球后不还原，失去发球抢攻衔接",
     "发球触球结束瞬间双脚立刻小跳垫步转正面向球台，球拍还原至胸前准备衔接下一板。", 2),

    # --- 13. serve_nospin 不转发球 (3条 - 已清除心理伪证据) ---
    ("serve_nospin", "serve_nospin_obvious", "follow_through", "serve_mechanics", "upper_body",
     "触球轻推后手臂立刻停住，完全没有下旋发球的切球随挥假动作，一眼被看穿", "缺乏随挥假动作掩护，不转发球无迷惑性",
     "触球瞬间用拍根轻撞球心后，手腕必须立即顺势往下补做一个逼真的切球假动作，做到真假外形一致。", 1),
    ("serve_nospin", "serve_nospin_slow_high", "contact", "serve_mechanics", "table_and_ball",
     "触球瞬间前臂推送幅度过小且击球点偏高，球过网缓慢又高又飘", "触球点高且推送乏力，形成半高慢球挨打",
     "同样在近台面低点触球，短促干脆地向前平推撞击，保证球低平快速过网。", 1),
    ("serve_nospin", "serve_nospin_brush_tip", "contact", "racket_angle", "upper_body",
     "触球位置偏向拍头外沿且手腕顺势切擦，实际发出成了真下旋球", "触球部位偏拍头产生真摩擦，未能发出不转球",
     "有意识将触球点移至靠近拍柄的球拍中后部（线速度最小区），减少球皮咬合摩擦。", 2),

    # --- 14. hook_serve 勾手发球 (4条) ---
    ("hook_serve", "hook_serve_no_wrist", "swing", "racket_angle", "upper_body",
     "手腕未提前内收，仅靠大臂向外侧平推硬拨，缺乏由内向外的铲勾加速", "缺乏手腕内收再外展的勾铲爆发力，旋转弱",
     "引拍时先把拍头向怀里收紧，触球瞬间前臂配合手腕由内向外侧猛烈展腕铲擦球侧下部。", 1),
    ("hook_serve", "hook_serve_pop_high", "contact", "serve_mechanics", "table_and_ball",
     "向外铲球时拍面过度朝天往上托举且击球点偏高，发球冒高", "向外托举过多、触球点偏高导致冒高",
     "降低身体重心与击球点高度，手腕向外侧平铲或向斜下方切铲，压低第一跳反弹弧线。", 1),
    ("hook_serve", "hook_serve_illegal_toss", "preparation", "serve_mechanics", "upper_body",
     "非持拍手在身体遮挡下往怀里斜抛球直接撞向球拍", "往怀里斜抛合力或身体遮挡违规",
     "保持垂直上抛，发球瞬间非持拍手臂及时从球与球网之间的视线通道移开，避免遮挡犯规。", 2),
    ("hook_serve", "hook_serve_slow_reset", "recovery", "footwork_pos", "full_body",
     "侧身发完勾手球后身体拧在侧方未及时转正，反手大空档暴露", "侧身发球后还原慢，反手位空档大",
     "勾手发球多站在中线或反手位，发完球后持拍侧脚迅速后撤半步转正还原盯防两面。", 2),

    # --- 15. reverse_pendulum_serve 正手逆旋转发球 (4条) ---
    ("reverse_pendulum_serve", "rev_serve_low_elbow", "backswing", "arm_fulcrum", "upper_body",
     "引拍时手肘垂在腰间未架高，手腕掰不过来导致向外甩不开速度", "手肘未架高撑开，手腕内折蓄力受限",
     "抛球同时大胆将持拍侧手肘向外上方抬高架起，让手腕深度向怀内弯曲，形成充分的逆向弹射空间。", 1),
    ("reverse_pendulum_serve", "rev_serve_miss_thin", "contact", "racket_angle", "table_and_ball",
     "向外甩腕时切球过薄打滑漏球，或撞击过厚直接飞出对方侧边线", "触球厚薄失控（漏球或侧飞出界）",
     "先固定抛球落点贴近身前，体会先微咬住球外侧中下部再向外侧加速翻甩摩擦，逐步加快腕速。", 1),
    ("reverse_pendulum_serve", "rev_serve_high_point", "contact", "serve_mechanics", "table_and_ball",
     "球还在肩膀胸口高度就急于翻腕外甩，发球过网弧线高飘", "触球高度过高导致逆旋转发球冒高",
     "重心随球下落同步微沉，等球落至近网高度时再集中爆发甩腕。", 2),
    ("reverse_pendulum_serve", "rev_serve_shoulder_stiff", "swing", "core_legs", "upper_body",
     "肩膀耸起僵硬死板，仅靠手腕干掰发力，动作别扭易伤手腕", "耸肩僵硬干掰手腕，缺乏重心与前臂协同",
     "架肘但不要耸肩锁死，触球瞬间配合腰腹微震与前臂外旋顺势把手腕力量释放出去。", 2),
]


# ==================== Excel 生成与样式美化主函数 ====================
def build_workbook(output_path="table_tennis_action_knowledge_v3.xlsx"):
    wb = openpyxl.Workbook()
    # 移除默认空白页
    wb.remove(wb.active)

    sheets_config = [
        ("填写说明", SHEET_README, False),
        ("数据字典", SHEET_DICT, True),
        ("动作清单", [SHEET_ACTIONS_HEADER] + list(SHEET_ACTIONS_ROWS), True),
        ("识别线索", [SHEET_CUES_HEADER] + list(SHEET_CUES_ROWS), True),
        ("混淆矩阵", [SHEET_CONFUSION_HEADER] + list(SHEET_CONFUSION_ROWS), True),
        ("降级规则", [SHEET_DEGRADE_HEADER] + list(SHEET_DEGRADE_ROWS), True),
        ("诊断规则", [SHEET_DIAG_HEADER] + list(SHEET_DIAG_ROWS), True),
        ("枚举值", SHEET_ENUMS, True),
    ]

    header_fill = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
    header_font = Font(name="微软雅黑", size=11, bold=True, color="FFFFFF")
    title_font = Font(name="微软雅黑", size=13, bold=True, color="1F4E78")
    body_font = Font(name="微软雅黑", size=10)
    zebra_fill = PatternFill(start_color="F2F6FA", end_color="F2F6FA", fill_type="solid")
    thin_border = Border(
        left=Side(style="thin", color="D9D9D9"),
        right=Side(style="thin", color="D9D9D9"),
        top=Side(style="thin", color="D9D9D9"),
        bottom=Side(style="thin", color="D9D9D9"),
    )

    for sheet_name, rows, has_header in sheets_config:
        ws = wb.create_sheet(title=sheet_name)
        for r_idx, row_data in enumerate(rows, start=1):
            ws.append(list(row_data))
            for c_idx in range(1, len(row_data) + 1):
                cell = ws.cell(row=r_idx, column=c_idx)
                cell.border = thin_border
                cell.alignment = Alignment(vertical="center", wrap_text=True)

                if not has_header and r_idx == 1:
                    cell.font = title_font
                elif has_header and r_idx == 1:
                    cell.fill = header_fill
                    cell.font = header_font
                    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
                else:
                    cell.font = body_font
                    if r_idx % 2 == 0:
                        cell.fill = zebra_fill

        if has_header:
            ws.freeze_panes = "A2"
            ws.auto_filter.ref = ws.dimensions

        # 自适应列宽（限制最大宽度为46，自动换行更美观）
        for col in ws.columns:
            col_letter = get_column_letter(col[0].column)
            max_len = 0
            for cell in col:
                val = str(cell.value or "")
                # 中文字符按约1.8宽度估算
                est_len = sum(1.8 if ord(ch) > 127 else 1.0 for ch in val)
                if est_len > max_len:
                    max_len = est_len
            ws.column_dimensions[col_letter].width = min(max(max_len + 4, 12), 46)

    wb.save(output_path)
    print(f"✅ 成功生成知识库文件: {output_path}")
    print(f"📊 统计: 动作清单 {len(SHEET_ACTIONS_ROWS)} 项 | 识别线索 {len(SHEET_CUES_ROWS)} 条 | 诊断规则 {len(SHEET_DIAG_ROWS)} 条")


if __name__ == "__main__":
    build_workbook()

