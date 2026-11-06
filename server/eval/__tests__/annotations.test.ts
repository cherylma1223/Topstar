import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsvLine, CSV_BOM } from '../lib/csv';
import {
  parseAnnotationRows, parseSegments, parseTimeToSeconds, validateAnnotations, type Knowledge,
} from '../lib/annotations';
import { annotationTemplate } from '../lib/template';

// ─── CSV ─────────────────────────────────────────────────────────

test('csv：BOM、CRLF、引号内的逗号和换行、"" 转义', () => {
  const text = `${CSV_BOM}a,b,c\r\n1,"x,y","line1\nline2"\r\n"he said ""hi""",,3\r\n`;
  assert.deepEqual(parseCsv(text), [
    ['a', 'b', 'c'],
    ['1', 'x,y', 'line1\nline2'],
    ['he said "hi"', '', '3'],
  ]);
});

test('csv：# 注释行和空行被忽略，注释里的逗号不影响', () => {
  const text = '# 说明，里面有逗号, 和更多逗号\n\nvideo_id,video_file\n,,\na,b\n';
  assert.deepEqual(parseCsv(text), [['video_id', 'video_file'], ['a', 'b']]);
});

test('csv：toCsvLine 与 parseCsv 往返一致', () => {
  const cells = ['plain', 'has,comma', 'has "quote"', '多行\n备注', ' 前后空格 ', '中文'];
  assert.deepEqual(parseCsv(toCsvLine(cells) + '\n')[0], cells);
});

// ─── 时间与片段 ──────────────────────────────────────────────────

test('parseTimeToSeconds：mm:ss / hh:mm:ss / 纯秒数；非法返回 null', () => {
  assert.equal(parseTimeToSeconds('00:19'), 19);
  assert.equal(parseTimeToSeconds('1:05'), 65);
  assert.equal(parseTimeToSeconds('1:02:03'), 3723);
  assert.equal(parseTimeToSeconds('12.5'), 12.5);
  assert.equal(parseTimeToSeconds(' 7 '), 7);
  for (const bad of ['', 'abc', '1:xx', '1:2:3:4', '-5']) assert.equal(parseTimeToSeconds(bad), null, bad);
});

test('parseSegments：多个片段、多种分隔符；none → 空数组；空串 → 未标注；非法给出可读错误', () => {
  assert.deepEqual(parseSegments('00:00-00:19; 00:25–00:40').value, [{ start: 0, end: 19 }, { start: 25, end: 40 }]);
  assert.deepEqual(parseSegments('0:00 ~ 0:05；0:10至0:12').value, [{ start: 0, end: 5 }, { start: 10, end: 12 }]);
  assert.deepEqual(parseSegments('none').value, []);
  assert.deepEqual(parseSegments('NONE').value, []);
  assert.deepEqual(parseSegments(''), {});
  assert.match(parseSegments('00:19-00:00').error!, /结束时间必须大于开始时间/);
  assert.match(parseSegments('abc').error!, /格式不对/);
  assert.match(parseSegments('00:00-00:05-00:09').error!, /格式不对/);
});

// ─── 标注表 ──────────────────────────────────────────────────────

const HEADER = ['video_id', 'video_file', 'action_id', 'segments', 'has_voice', 'issues', 'tags', 'notes', 'source_job'];

test('parseAnnotationRows：字段解析，留空 = 未标注，none = 明确没有', () => {
  const { annotations, errors } = parseAnnotationRows([
    HEADER,
    ['v1', 'v1.mov', 'bh_loop', '00:00-00:19', 'yes', 'bh_loop_a; bh_loop_b', 'side-view; noisy', '备注', 'job-1'],
    ['v2', 'v2.mp4', 'none', 'none', 'no', 'none', '', '', ''],
    ['v3', 'v3.mp4', '', '', '', '', '', '', ''],
  ]);
  assert.deepEqual(errors, []);
  assert.equal(annotations.length, 3);

  const [a, b, c] = annotations;
  assert.deepEqual(
    { id: a.videoId, action: a.actionId, seg: a.segments, voice: a.hasVoice, issues: a.issues, tags: a.tags, notes: a.notes, job: a.sourceJob, row: a.rowNumber },
    { id: 'v1', action: 'bh_loop', seg: [{ start: 0, end: 19 }], voice: true, issues: ['bh_loop_a', 'bh_loop_b'], tags: ['side-view', 'noisy'], notes: '备注', job: 'job-1', row: 2 },
  );
  assert.deepEqual({ action: b.actionId, seg: b.segments, voice: b.hasVoice, issues: b.issues }, { action: 'none', seg: [], voice: false, issues: [] });
  assert.deepEqual({ action: c.actionId, seg: c.segments, voice: c.hasVoice, issues: c.issues }, { action: undefined, seg: undefined, voice: undefined, issues: undefined });
});

test('parseAnnotationRows：表头缺列、重复 ID、非法 ID、非法片段、非法 has_voice 都会报到具体行', () => {
  assert.match(parseAnnotationRows([['video_id', 'action_id']]).errors[0], /缺少必填列「video_file」/);

  const { errors } = parseAnnotationRows([
    HEADER,
    ['dup', 'a.mov', '', '', '', '', '', '', ''],
    ['dup', 'b.mov', '', '', '', '', '', '', ''],
    ['马诗彤', 'c.mov', '', '', '', '', '', '', ''],
    ['bad-seg', 'd.mov', '', '00:10-00:05', '', '', '', '', ''],
    ['bad-voice', 'e.mov', '', '', '也许', '', '', '', ''],
    ['', 'f.mov', '', '', '', '', '', '', ''],
  ]);
  const joined = errors.join('\n');
  assert.match(joined, /第 3 行：video_id「dup」重复/);
  assert.match(joined, /第 4 行：video_id「马诗彤」只能用英文字母/);
  assert.match(joined, /第 5 行（bad-seg）segments：.*结束时间必须大于开始时间/);
  assert.match(joined, /第 6 行（bad-voice）has_voice/);
  assert.match(joined, /第 7 行：video_id 不能为空/);
});

test('annotationTemplate：模板本身能被解析（只有表头，没有数据行，没有错误）', () => {
  const result = parseAnnotationRows(parseCsv(annotationTemplate()));
  assert.deepEqual(result, { annotations: [], errors: [] });
});

// ─── 对照知识库校验 ──────────────────────────────────────────────

const KNOWLEDGE: Knowledge = {
  actionIds: ['bh_loop', 'bh_drive'],
  issueIdsByAction: { bh_loop: ['bh_loop_a', 'bh_loop_b'], bh_drive: ['bh_drive_net'] },
};

test('validateAnnotations：未知动作、不属于该动作的 issue、有 issues 却没 action 都是错误；没填 action 只是提示', () => {
  const { annotations } = parseAnnotationRows([
    HEADER,
    ['ok', 'a.mov', 'bh_loop', '', '', 'bh_loop_a', '', '', ''],
    ['bad-action', 'b.mov', 'fh_unknown', '', '', '', '', '', ''],
    ['bad-issue', 'c.mov', 'bh_loop', '', '', 'bh_drive_net', '', '', ''],
    ['no-action', 'd.mov', '', '', '', 'bh_loop_a', '', '', ''],
    ['blank', 'e.mov', '', '', '', '', '', '', ''],
    ['none-ok', 'f.mov', 'none', 'none', '', 'none', '', '', ''],
  ]);
  const { errors, warnings } = validateAnnotations(annotations, KNOWLEDGE);
  const e = errors.join('\n');
  assert.match(e, /bad-action.*action_id「fh_unknown」不在知识库里.*bh_loop, bh_drive/);
  assert.match(e, /bad-issue.*issue_id「bh_drive_net」不是 bh_loop 的诊断规则.*bh_loop_a, bh_loop_b/);
  assert.match(e, /no-action.*填了 issues，就必须同时填 action_id/);
  assert.equal(errors.length, 3, e);
  assert.ok(warnings.some(w => w.includes('no-action') && w.includes('action_id 还没填')));
  assert.ok(warnings.some(w => w.includes('blank')));
  assert.ok(!errors.some(x => x.includes('(ok)') || x.includes('none-ok')));
});
