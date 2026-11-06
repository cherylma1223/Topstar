import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agreement, boundaryErrors, intervalsIoU, matchProblemsToRules, mean, parsePredictedSegments,
  percentile, precisionRecallF1,
} from '../lib/metrics';

const close = (a: number | undefined, b: number, eps = 1e-9) => assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('percentile：线性插值，单样本、空样本', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([4, 1, 3, 2], 0), 1);
  assert.equal(percentile([4, 1, 3, 2], 100), 4);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([], 50), undefined);
  assert.equal(mean([]), undefined);
});

test('intervalsIoU：部分重叠、完全一致、互不相交、重叠的预测先合并、两边为空', () => {
  close(intervalsIoU([{ start: 0, end: 10 }], [{ start: 5, end: 15 }]), 1 / 3);
  assert.equal(intervalsIoU([{ start: 0, end: 20 }], [{ start: 0, end: 20 }]), 1);
  assert.equal(intervalsIoU([{ start: 0, end: 5 }], [{ start: 10, end: 20 }]), 0);
  assert.equal(intervalsIoU([{ start: 0, end: 5 }, { start: 4, end: 10 }], [{ start: 0, end: 10 }]), 1);
  assert.equal(intervalsIoU([], []), 1);
  assert.equal(intervalsIoU([], [{ start: 0, end: 5 }]), 0);
});

test('boundaryErrors：边界误差带符号，漏检与多检分别计数', () => {
  const r = boundaryErrors(
    [{ start: 12, end: 19 }, { start: 30, end: 40 }],
    [{ start: 10, end: 20 }],
  );
  assert.deepEqual(r, { startErrors: [2], endErrors: [-1], missedGold: 0, extraPred: 1 });

  const missed = boundaryErrors([], [{ start: 0, end: 5 }]);
  assert.deepEqual(missed, { startErrors: [], endErrors: [], missedGold: 1, extraPred: 0 });
});

test('parsePredictedSegments：解析 mm:ss / hh:mm:ss，跳过非法项', () => {
  assert.deepEqual(
    parsePredictedSegments([
      { start: '00:05', end: '00:19' },
      { start: '1:00:00', end: '1:00:10' },
      { start: 'x', end: '00:10' },
      { start: '00:10', end: '00:05' },
      null,
    ]),
    [{ start: 5, end: 19 }, { start: 3600, end: 3610 }],
  );
  assert.deepEqual(parsePredictedSegments(undefined), []);
});

test('matchProblemsToRules：用真实规则文案，模型描述包含「视觉证据」或「问题」原文即命中', () => {
  const rules = [
    { issue_id: 'bh_drive_net', evidence: '击球点偏低，拍面前倾过度', problem: '反手拨球总是下网' },
    { issue_id: 'bh_drive_elbow_unstable', evidence: '肘部左右晃动，出球方向不稳定', problem: '肘部不稳，导致拨球方向控制差' },
    { issue_id: 'bh_drive_weak', evidence: '前臂弹击不明显、手腕过度参与', problem: '拨球力量小不够快' },
  ];
  const { matched, unmatched } = matchProblemsToRules(
    [
      '击球点偏低，拍面前倾过度，反手拨球总是下网',                     // 线上真实输出（证据 + 问题）
      '肘部左右晃动，出球方向不稳定，肘部不稳，导致拨球方向控制差',
      '站位太靠后',                                                   // 规则之外的自由发挥
    ],
    rules,
  );
  assert.deepEqual(matched.sort(), ['bh_drive_elbow_unstable', 'bh_drive_net']);
  assert.deepEqual(unmatched, ['站位太靠后']);

  // 标点和空格不影响匹配
  assert.deepEqual(matchProblemsToRules(['拨球 力量小，不够快。'], rules).matched, ['bh_drive_weak']);
});

test('precisionRecallF1：常规、预测为空、标注为空', () => {
  const normal = precisionRecallF1(['a', 'b'], ['a', 'c']);
  assert.deepEqual(normal, { precision: 0.5, recall: 0.5, f1: 0.5 });

  const noPred = precisionRecallF1([], ['a']);
  assert.deepEqual(noPred, { precision: undefined, recall: 0, f1: 0 });

  const noGold = precisionRecallF1(['a'], []);
  assert.deepEqual(noGold, { precision: 0, recall: undefined, f1: 0 });

  assert.deepEqual(precisionRecallF1(['a', 'b'], ['b', 'a']), { precision: 1, recall: 1, f1: 1 });
});

test('agreement：重复结果的一致度', () => {
  assert.equal(agreement(['x', 'x', 'x']), 1);
  assert.equal(agreement(['x', 'y']), 0.5);
  close(agreement(['x', 'x', 'y']), 2 / 3);
  assert.equal(agreement([]), undefined);
});
