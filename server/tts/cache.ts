/**
 * TTS 音频缓存（LRU + TTL）
 *
 * 为什么不用裸 Map：中文长文本的整段 PCM 很大（1 分钟音频约 2.8 MB，base64 后约 3.8 MB），
 * 只做 TTL 清理、没有容量上限的话，大量不同文本会把进程内存顶高。
 *
 * 规则：
 *  - 每条带 expiresAt，读取时过期即删
 *  - 访问命中把条目移到队尾（Map 插入顺序即 LRU 顺序）
 *  - 写入后按「条数」和「总字节数」双上限淘汰最久未使用的条目
 */
export interface TtsCacheEntry<T> {
  expiresAt: number;
  payload: T;
  /** 该条目占用的估算字节数 */
  bytes: number;
}

export interface TtsCacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxTotalBytes: number;
}

export interface TtsCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  entries: number;
  totalBytes: number;
}

export class TtsCache<T> {
  private readonly map = new Map<string, TtsCacheEntry<T>>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly options: TtsCacheOptions) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.deleteEntry(key, entry);
      this.misses++;
      return undefined;
    }
    // 命中：移到队尾
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.payload;
  }

  set(key: string, payload: T, bytes: number, ttlMs?: number): void {
    const existing = this.map.get(key);
    if (existing) this.deleteEntry(key, existing);

    const entry: TtsCacheEntry<T> = {
      expiresAt: Date.now() + (ttlMs ?? this.options.ttlMs),
      payload,
      bytes: Math.max(0, bytes),
    };
    this.map.set(key, entry);
    this.totalBytes += entry.bytes;

    this.evictOverflow();
  }

  /** 清理过期条目，返回清理条数 */
  cleanupExpired(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.map.entries()) {
      if (entry.expiresAt <= now) {
        this.deleteEntry(key, entry);
        removed++;
      }
    }
    return removed;
  }

  stats(): TtsCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      entries: this.map.size,
      totalBytes: this.totalBytes,
    };
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  private deleteEntry(key: string, entry: TtsCacheEntry<T>): void {
    this.map.delete(key);
    this.totalBytes -= entry.bytes;
    if (this.totalBytes < 0) this.totalBytes = 0;
  }

  private evictOverflow(): void {
    while (
      this.map.size > this.options.maxEntries ||
      this.totalBytes > this.options.maxTotalBytes
    ) {
      const oldest = this.map.keys().next();
      if (oldest.done) return;
      const entry = this.map.get(oldest.value);
      if (!entry) return;
      this.deleteEntry(oldest.value, entry);
      this.evictions++;
    }
  }
}
