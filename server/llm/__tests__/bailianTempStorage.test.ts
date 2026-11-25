import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BailianTempStorage } from '../dashscope/BailianTempStorage';

const realFetch = globalThis.fetch;
let tmpFile = '';

const POLICY = {
  policy: 'p', signature: 's', upload_dir: 'dashscope-instant/abc/2026-11-25/def',
  upload_host: 'https://dashscope.oss.example.com', oss_access_key_id: 'AK',
  x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true',
  max_file_size_mb: 100, capacity_limit_mb: 1000, expire_in_seconds: 172800,
};

function stubFetch(opts: { policyStatus?: number; policyBody?: unknown; putStatus?: number } = {}): string[] {
  const hits: string[] = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    hits.push(url);
    if (url.includes('action=getPolicy')) {
      return {
        ok: (opts.policyStatus ?? 200) < 300,
        status: opts.policyStatus ?? 200,
        text: async () => JSON.stringify(opts.policyBody ?? { data: POLICY }),
      };
    }
    assert.ok(init?.body instanceof FormData, '上传必须是 multipart');
    return { ok: (opts.putStatus ?? 200) < 300, status: opts.putStatus ?? 200, text: async () => '' };
  };
  return hits;
}

beforeEach(() => {
  process.env.DASHSCOPE_API_KEY = 'sk-test';
  delete process.env.DASHSCOPE_UPLOAD_MODEL;
  tmpFile = path.join(os.tmpdir(), 'dppbl-test.MOV');
  fs.writeFileSync(tmpFile, Buffer.alloc(1024));
});
afterEach(() => {
  (globalThis as any).fetch = realFetch;
  delete process.env.DASHSCOPE_API_KEY;
  try { fs.unlinkSync(tmpFile); } catch {}
});

test('upload：先取 getPolicy 再 multipart 直传，返回 oss:// 引用', async () => {
  const hits = stubFetch();
  const ref = await new BailianTempStorage().upload(tmpFile, 'video/quicktime');

  assert.equal(hits.length, 2);
  assert.match(hits[0], /action=getPolicy&model=qwen3\.8-max/);
  assert.equal(hits[1], POLICY.upload_host);

  assert.equal(ref.storage, 'bailian_temp');
  assert.equal(ref.state, 'ready');
  assert.equal(ref.mimeType, 'video/quicktime');
  assert.equal(ref.fileRef, POLICY.upload_dir + '/dppbl-test.MOV');
  assert.equal(ref.uri, 'oss://' + POLICY.upload_dir + '/dppbl-test.MOV');
});

test('upload：waitReady 原样返回，cleanup 不报错', async () => {
  stubFetch();
  const s = new BailianTempStorage();
  const ref = await s.upload(tmpFile, 'video/mp4');
  assert.deepEqual(await s.waitReady(ref), ref);
  await s.cleanup(ref);
});

test('错误：没 key → NOT_CONFIGURED；getPolicy / 上传失败 → STORAGE_FAILED', async () => {
  delete process.env.DASHSCOPE_API_KEY;
  await assert.rejects(() => new BailianTempStorage().upload(tmpFile, 'video/mp4'), (e: any) => e.code === 'NOT_CONFIGURED');

  process.env.DASHSCOPE_API_KEY = 'sk-test';
  stubFetch({ policyStatus: 429 });
  await assert.rejects(() => new BailianTempStorage().upload(tmpFile, 'video/mp4'), (e: any) => e.code === 'STORAGE_FAILED' && /429/.test(e.message));

  stubFetch({ putStatus: 503 });
  await assert.rejects(() => new BailianTempStorage().upload(tmpFile, 'video/mp4'), (e: any) => e.code === 'STORAGE_FAILED' && /503/.test(e.message));
});

test('错误：超过临时空间单文件上限时直接拒绝并提示走正式 OSS', async () => {
  stubFetch({ policyBody: { data: { ...POLICY, max_file_size_mb: 0.00001 } } });
  await assert.rejects(
    () => new BailianTempStorage().upload(tmpFile, 'video/mp4'),
    (e: any) => e.code === 'STORAGE_FAILED' && /temp-space limit/.test(e.message)
  );
});
