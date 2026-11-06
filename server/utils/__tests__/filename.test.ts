import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixMultipartFilename } from '../filename';

/** 模拟 multer：浏览器发来 UTF-8 字节，被当成 latin1 读成乱码 */
function asMulterWouldRead(realName: string): string {
  return Buffer.from(realName, 'utf8').toString('latin1');
}

test('还原被误读为 latin1 的中文文件名（真实线上样本，用 \\u 转义写出，避免复制时丢失不可见的 C1 控制字符）', () => {
  // 线上数据库里实际存过的值：马诗彤-b.MOV / 大盼盼2.MOV 被误读后的样子
  const garbled1 = '\u00e9\u00a9\u00ac\u00e8\u00af\u0097\u00e5\u00bd\u00a4-b.MOV';
  const garbled2 = '\u00e5\u00a4\u00a7\u00e7\u009b\u00bc\u00e7\u009b\u00bc2.MOV';
  assert.equal(fixMultipartFilename(garbled1), '马诗彤-b.MOV');
  assert.equal(fixMultipartFilename(garbled2), '大盼盼2.MOV');
  // 样本本身确实是 multer 会产生的结果
  assert.equal(garbled1, asMulterWouldRead('马诗彤-b.MOV'));
  assert.equal(garbled2, asMulterWouldRead('大盼盼2.MOV'));
});

test('往返：各种中文 / 日文 / 带标点的文件名都能还原', () => {
  for (const name of ['马诗彤-b.MOV', '大盼盼2.MOV', '反手霸王拧.mov', '训练视频（正手）.mp4', 'テスト動画.mov', '反手 拨球 01.mp4']) {
    assert.equal(fixMultipartFilename(asMulterWouldRead(name)), name);
  }
});

test('幂等：已经是正确 Unicode 的名字不会被再次改动', () => {
  assert.equal(fixMultipartFilename('马诗彤-b.MOV'), '马诗彤-b.MOV');
  const once = fixMultipartFilename(asMulterWouldRead('马诗彤-b.MOV'));
  assert.equal(fixMultipartFilename(once), once);
});

test('纯 ASCII 原样返回', () => {
  assert.equal(fixMultipartFilename('video-01.mp4'), 'video-01.mp4');
  assert.equal(fixMultipartFilename(''), '');
});

test('真正的 latin1 名字（非合法 UTF-8 字节序列）不会被改坏', () => {
  // é 单独一个 0xE9 字节，按 UTF-8 解码非法，必须保持原样
  assert.equal(fixMultipartFilename('café.mov'), 'café.mov');
  assert.equal(fixMultipartFilename('naïve résumé.mp4'), 'naïve résumé.mp4');
});
