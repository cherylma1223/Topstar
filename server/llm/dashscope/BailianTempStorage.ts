/**
 * 百炼「临时存储」VideoStorage —— 只用于开发 / 评测，不要用于生产
 *
 * 官方口径：免费临时空间 ≤1GB、文件 48 小时后自动过期，文档明确写「勿用于生产」。
 * 它的价值在于：在 V2 的私有 OSS 桶落地之前，先把「上传 → Pass1 → Pass1.5 → Pass2」
 * 整条链路跑在千问上，用于模型选型和回归。
 *
 * 地址形态是 `oss://{upload_dir}/{filename}`，调模型时必须带
 * `X-DashScope-OssResourceResolve: enable`（DashScopeProvider 会自动加，这里不用管）。
 *
 * 环境变量：
 *   DASHSCOPE_API_KEY        必填
 *   DASHSCOPE_UPLOAD_MODEL   申请上传目录时用的模型名，默认 qwen3.8-max（决定目录归属）
 */
import fs from 'fs';
import path from 'path';
import { LLMError, errorMessage } from '../errors';
import { dashscopeApiKey } from './QwenTtsProvider';
import type { VideoRef, VideoStorage, VideoRefState } from '../types';

const UPLOADS_URL = 'https://dashscope.aliyuncs.com/api/v1/uploads';

interface UploadPolicy {
  policy: string;
  signature: string;
  upload_dir: string;
  upload_host: string;
  oss_access_key_id: string;
  x_oss_object_acl?: string;
  x_oss_forbid_overwrite?: string;
  max_file_size_mb?: number;
  capacity_limit_mb?: number;
  expire_in_seconds?: number;
}

export class BailianTempStorage implements VideoStorage {
  readonly name = 'bailian_temp' as const;

  async upload(localPath: string, mimeType: string): Promise<VideoRef> {
    const apiKey = dashscopeApiKey();
    if (!apiKey) throw new LLMError('NOT_CONFIGURED', 'DASHSCOPE_API_KEY is not set', { provider: 'dashscope' });

    const model = (process.env.DASHSCOPE_UPLOAD_MODEL || 'qwen3.8-max').trim();
    const fileName = path.basename(localPath);
    const bytes = await fs.promises.readFile(localPath);

    // 1) 申请上传凭证
    let policyRes: Response;
    try {
      policyRes = await fetch(`${UPLOADS_URL}?action=getPolicy&model=${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new LLMError('STORAGE_FAILED', `getPolicy request failed: ${errorMessage(err)}`, { provider: 'dashscope', cause: err });
    }
    const policyRaw = await policyRes.text().catch(() => '');
    if (!policyRes.ok) {
      throw new LLMError('STORAGE_FAILED', `getPolicy HTTP ${policyRes.status}: ${policyRaw.slice(0, 200)}`, { provider: 'dashscope' });
    }
    let policy: UploadPolicy;
    try {
      policy = (JSON.parse(policyRaw).data || {}) as UploadPolicy;
    } catch {
      throw new LLMError('STORAGE_FAILED', `getPolicy returned invalid JSON: ${policyRaw.slice(0, 200)}`, { provider: 'dashscope' });
    }
    if (!policy.upload_host || !policy.upload_dir) {
      throw new LLMError('STORAGE_FAILED', 'getPolicy response missing upload_host / upload_dir', { provider: 'dashscope' });
    }
    if (policy.max_file_size_mb && bytes.length > policy.max_file_size_mb * 1024 * 1024) {
      throw new LLMError(
        'STORAGE_FAILED',
        `file ${(bytes.length / 1048576).toFixed(1)}MB exceeds the temp-space limit ${policy.max_file_size_mb}MB; 用正式 OSS（V2）或先裁剪视频`,
        { provider: 'dashscope' }
      );
    }

    // 2) 按 OSS PostObject 直传
    const objectKey = `${policy.upload_dir}/${fileName}`;
    const form = new FormData();
    form.append('OSSAccessKeyId', policy.oss_access_key_id);
    form.append('Signature', policy.signature);
    form.append('policy', policy.policy);
    form.append('key', objectKey);
    if (policy.x_oss_object_acl) form.append('x-oss-object-acl', policy.x_oss_object_acl);
    if (policy.x_oss_forbid_overwrite) form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite);
    form.append('success_action_status', '200');
    form.append('file', new Blob([bytes], { type: mimeType }), fileName);

    let putRes: Response;
    try {
      putRes = await fetch(policy.upload_host, { method: 'POST', body: form, signal: AbortSignal.timeout(600_000) });
    } catch (err) {
      throw new LLMError('STORAGE_FAILED', `upload request failed: ${errorMessage(err)}`, { provider: 'dashscope', cause: err });
    }
    if (!putRes.ok) {
      const body = await putRes.text().catch(() => '');
      throw new LLMError('STORAGE_FAILED', `upload HTTP ${putRes.status}: ${body.slice(0, 200)}`, { provider: 'dashscope' });
    }

    return {
      storage: 'bailian_temp',
      fileRef: objectKey,
      uri: `oss://${objectKey}`,
      mimeType,
      state: 'ready',
    };
  }

  /** 直传完成即可用，无需轮询 */
  async waitReady(ref: VideoRef, _onPoll?: (state: VideoRefState) => void): Promise<VideoRef> {
    return ref;
  }

  /** 临时文件 48 小时后由百炼自动清理，这里不做删除（也没有删除接口） */
  async cleanup(_ref: VideoRef): Promise<void> {
    return;
  }
}
