/**
 * 标注模板：表头 + 填写说明（# 开头的注释行，程序读取时会忽略）
 */
import { COLUMNS } from './annotations';
import { CSV_BOM, toCsvLine } from './csv';

export function annotationTemplate(): string {
  const comments = [
    '# 评测集标注表。一行 = 一个视频。以 # 开头的行是说明，程序会忽略。详细说明见 eval/README.md',
    '# video_id：这个视频的唯一短名，只能用英文字母 数字 下划线 点 连字符，例如 dapanpan2',
    '# video_file：视频文件名，文件放在 eval/videos/ 目录下',
    '# action_id：动作 ID，必须是知识库里的 ID（npm run eval -- validate 会列出可选值）；整段没有有效技术动作填 none；没把握就留空',
    '# segments：有效击球片段，格式 00:00-00:19 多个用分号分隔，例如 00:00-00:19; 00:25-00:40；整段都没有有效击球填 none；没标注就留空',
    '# has_voice：教练口令是否清晰可辨，填 yes 或 no，可留空',
    '# issues：这个视频的主要问题点，填诊断规则的 issue_id，多个用分号分隔，例如 bh_drive_net; bh_drive_elbow_unstable；确认没有问题填 none；没标注就留空',
    '# tags：拍摄条件标签，多个用分号分隔，例如 side-view; dim-light; noisy；可留空',
    '# notes：备注，可留空',
    '# source_job：来自哪个已上传任务的 ID，用 add 命令添加时自动填写，手工添加可留空',
  ];
  return CSV_BOM + comments.join('\n') + '\n' + toCsvLine([...COLUMNS]) + '\n';
}
