/**
 * Gemini Files API 视频托管
 *
 * 上传 → 轮询 PROCESSING→ACTIVE → 用完删除。
 * 国内版将由对象存储（阿里云 OSS + 签名 URL + 生命周期删除）实现同一接口。
 */
import { getAI } from './client';
import { LLMError, errorMessage } from '../errors';
import type { VideoRef, VideoRefState, VideoStorage } from '../types';

const POLL_INITIAL_MS = 3000;
const POLL_MAX_MS = 10000;
const DEFAULT_MAX_WAIT_MS = 8 * 60 * 1000; // 留出余量，Worker 总超时为 10 分钟

function mapState(state: unknown): VideoRefState {
  if (state === 'ACTIVE') return 'ready';
  if (state === 'FAILED') return 'failed';
  return 'processing';
}

function toRef(file: any, fallbackMime: string): VideoRef {
  return {
    storage: 'gemini_files',
    fileRef: file.name,
    uri: file.uri,
    mimeType: file.mimeType || fallbackMime,
    state: mapState(file.state),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class GeminiFilesStorage implements VideoStorage {
  readonly name = 'gemini_files' as const;

  constructor(private readonly maxWaitMs = DEFAULT_MAX_WAIT_MS) {}

  async upload(localPath: string, mimeType: string): Promise<VideoRef> {
    try {
      const file = await getAI().files.upload({ file: localPath, config: { mimeType } });
      return toRef(file, mimeType);
    } catch (err) {
      throw new LLMError('STORAGE_FAILED', `upload failed: ${errorMessage(err)}`, { provider: 'gemini', cause: err });
    }
  }

  async waitReady(ref: VideoRef, onPoll?: (state: VideoRefState) => void): Promise<VideoRef> {
    let current = ref;
    let waitMs = POLL_INITIAL_MS;
    const deadline = Date.now() + this.maxWaitMs;

    while (current.state === 'processing') {
      if (Date.now() > deadline) {
        throw new LLMError('STORAGE_FAILED', `processing timeout after ${this.maxWaitMs}ms`, { provider: 'gemini' });
      }
      await sleep(waitMs);
      waitMs = Math.min(waitMs * 1.5, POLL_MAX_MS); // 指数退避，最长 10s
      const file = await getAI().files.get({ name: current.fileRef });
      current = toRef(file, current.mimeType);
      onPoll?.(current.state);
    }

    if (current.state === 'failed') {
      await this.cleanup(current).catch(() => {});
      throw new LLMError('STORAGE_FAILED', 'processing failed', { provider: 'gemini' });
    }
    return current;
  }

  async cleanup(ref: VideoRef): Promise<void> {
    await getAI().files.delete({ name: ref.fileRef });
  }
}
