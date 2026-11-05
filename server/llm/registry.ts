/**
 * LLM 抽象层 — Provider / VideoStorage 注册表
 *
 * 新增国内 provider（如百炼、方舟）时在此注册即可，业务代码无需改动。
 */
import type { LLMProvider, ProviderName, VideoStorage, VideoStorageName } from './types';
import { LLMError } from './errors';
import { GeminiProvider } from './gemini/GeminiProvider';
import { GeminiFilesStorage } from './gemini/GeminiFilesStorage';

const providerFactories: Record<ProviderName, () => LLMProvider> = {
  gemini: () => new GeminiProvider(),
};

const storageFactories: Record<VideoStorageName, () => VideoStorage> = {
  gemini_files: () => new GeminiFilesStorage(),
};

const providers = new Map<string, LLMProvider>();
const storages = new Map<string, VideoStorage>();

export function getProvider(name: string): LLMProvider {
  let p = providers.get(name);
  if (!p) {
    const factory = (providerFactories as Record<string, () => LLMProvider>)[name];
    if (!factory) throw new LLMError('NOT_CONFIGURED', `unknown LLM provider "${name}"`);
    p = factory();
    providers.set(name, p);
  }
  return p;
}

export function getStorage(name: string): VideoStorage {
  let s = storages.get(name);
  if (!s) {
    const factory = (storageFactories as Record<string, () => VideoStorage>)[name];
    if (!factory) throw new LLMError('NOT_CONFIGURED', `unknown video storage "${name}"`);
    s = factory();
    storages.set(name, s);
  }
  return s;
}

/** 仅供测试：注入假的 provider / storage */
export function __setProviderForTest(name: string, provider: LLMProvider | undefined): void {
  if (provider) providers.set(name, provider);
  else providers.delete(name);
}

export function __setStorageForTest(name: string, storage: VideoStorage | undefined): void {
  if (storage) storages.set(name, storage);
  else storages.delete(name);
}
