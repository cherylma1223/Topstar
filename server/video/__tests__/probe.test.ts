import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { parseDurationSeconds, probeVideoDuration } from '../probe';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('parseDurationSeconds：正常值向下取整，非法值返回 undefined', () => {
  assert.equal(parseDurationSeconds('20.366667\n'), 20);
  assert.equal(parseDurationSeconds('3.0'), 3);
  assert.equal(parseDurationSeconds('0.9'), 0); // 不足 1 秒取整为 0，由业务层的最短片段规则兜底
  assert.equal(parseDurationSeconds(''), undefined);
  assert.equal(parseDurationSeconds('N/A'), undefined);
  assert.equal(parseDurationSeconds('-5'), undefined);
  assert.equal(parseDurationSeconds('0'), undefined);
});

test('probeVideoDuration：ffprobe 不存在时返回 undefined 而不是抛错', async () => {
  const saved = process.env.FFPROBE_PATH;
  process.env.FFPROBE_PATH = '/nonexistent/ffprobe';
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await probeVideoDuration('/tmp/whatever.mp4'), undefined);
  } finally {
    console.warn = warn;
    if (saved === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = saved;
  }
});

test('probeVideoDuration：真实视频（需要本机有 ffmpeg，否则跳过）', { skip: !(hasBinary('ffmpeg') && hasBinary('ffprobe')) }, async () => {
  const file = path.join(os.tmpdir(), `probe-test-${process.pid}.mp4`);
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=64x64:rate=5', file]);
    assert.equal(await probeVideoDuration(file), 3);
  } finally {
    fs.rmSync(file, { force: true });
  }
  // 文件不存在 / 不是视频
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await probeVideoDuration('/tmp/definitely-not-exist.mp4'), undefined);
  } finally {
    console.warn = warn;
  }
});
